import { AnimatePresence, motion } from 'motion/react'
import { Drawer } from 'vaul'
import { ArrowRight, CalendarDays, Check, ChevronDown, Delete, LayoutGrid, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Account, Person, Transaction, TxKind } from '../lib/api'
import { currencySymbol, dayLabel, getCurrency, localNow, money, pad, timeLabel, ymd } from '../lib/format'
import { haptic, palette } from '../lib/look'
import { useData, useDeleteTx, useSaveEntity, useSaveTx } from '../lib/queries'
import { closeComposer, composer, type ComposerPreset } from '../lib/store'
import { isPersonKind, kindMeta } from '../lib/tx'
import { Avatar, Chip, Glyph, Segmented, cn } from './ui'

type Mode = 'expense' | 'income' | 'transfer' | 'people'
type PersonKind = 'lend' | 'borrow' | 'collect' | 'repay'
type Panel = 'keypad' | 'account' | 'toAccount' | 'date' | 'category' | 'person'

const personKindHelp: Record<PersonKind, string> = {
  lend: 'You gave them money',
  borrow: 'They gave you money',
  collect: 'They returned your money',
  repay: 'You returned their money',
}

// ---- Keypad arithmetic ----

const OPS = ['+', '−', '×', '÷']
const isOp = (c: string) => OPS.includes(c)

/** Evaluates "450+120×2" with × and ÷ first. Returns rupees, or null if incomplete. */
export function evaluate(expr: string): number | null {
  const trimmed = isOp(expr.slice(-1)) ? expr.slice(0, -1) : expr
  if (!trimmed) return null
  const tokens = trimmed.split(/([+−×÷])/).filter(Boolean)
  const nums: number[] = []
  const ops: string[] = []
  for (const tok of tokens) {
    if (isOp(tok)) ops.push(tok)
    else {
      const n = Number(tok === '.' ? '0' : tok)
      if (!Number.isFinite(n)) return null
      nums.push(n)
    }
  }
  if (nums.length !== ops.length + 1) return null
  // × and ÷ first
  const n2 = [nums[0]]
  const o2: string[] = []
  ops.forEach((op, i) => {
    const b = nums[i + 1]
    if (op === '×') n2[n2.length - 1] *= b
    else if (op === '÷') n2[n2.length - 1] = b === 0 ? NaN : n2[n2.length - 1] / b
    else {
      o2.push(op)
      n2.push(b)
    }
  })
  let result = n2[0]
  o2.forEach((op, i) => (result = op === '+' ? result + n2[i + 1] : result - n2[i + 1]))
  if (!Number.isFinite(result)) return null
  return Math.round(result * 100) / 100
}

function pressKey(expr: string, key: string): string {
  const parts = expr.split(/[+−×÷]/)
  const current = parts[parts.length - 1]
  if (key === 'back') return expr.slice(0, -1)
  if (key === '.') {
    if (current.includes('.')) return expr
    return expr + (current === '' ? '0.' : '.')
  }
  if (isOp(key)) {
    if (!expr) return expr
    if (isOp(expr.slice(-1))) return expr.slice(0, -1) + key
    return expr + key
  }
  // digit
  if (current.includes('.') && current.split('.')[1].length >= 2) return expr
  if (current.replace('.', '').length >= 10) return expr
  if (current === '0') return expr.slice(0, -1) + key
  return expr + key
}

function groupDigits(n: string): string {
  const [int, frac] = n.split('.')
  const grouped = int ? Number(int).toLocaleString(getCurrency() === 'INR' ? 'en-IN' : undefined) : '0'
  return frac !== undefined ? `${grouped}.${frac}` : grouped
}

function prettyExpr(expr: string): string {
  return expr
    .split(/([+−×÷])/)
    .map((t) => (isOp(t) ? ` ${t} ` : t ? groupDigits(t) : ''))
    .join('')
}

// ---- Sheet ----

export function Composer() {
  const { open, editing, preset, key } = composer.use((s) => s)
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && closeComposer()} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[3px]" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[96dvh] w-full max-w-[480px] flex-col rounded-t-[32px] bg-surface shadow-float outline-none md:bottom-4 md:rounded-[32px] md:after:hidden!">
          <Drawer.Title className="sr-only">{editing ? 'Edit transaction' : 'Add transaction'}</Drawer.Title>
          <Drawer.Description className="sr-only">Enter an amount and details</Drawer.Description>
          <div className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-full bg-ink/15" />
          {open && <ComposerBody key={key} editing={editing} preset={preset} />}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

function lastAccountId(): number | null {
  try {
    return Number(localStorage.getItem('kosh:lastAccount')) || null
  } catch {
    return null
  }
}

function ComposerBody({ editing, preset }: { editing: Transaction | null; preset: ComposerPreset }) {
  const d = useData()
  const save = useSaveTx()
  const del = useDeleteTx()
  const savePerson = useSaveEntity<Person>('people')

  const initialKind: TxKind = editing?.kind ?? preset.kind ?? 'expense'
  const accounts = d.activeAccounts
  const defaultAccount =
    editing?.accountId ?? preset.accountId ?? (accounts.find((a) => a.id === lastAccountId()) ?? accounts[0])?.id ?? 0

  const [mode, setMode] = useState<Mode>(isPersonKind(initialKind) ? 'people' : (initialKind as Mode))
  const [personKind, setPersonKind] = useState<PersonKind>(isPersonKind(initialKind) ? (initialKind as PersonKind) : 'lend')
  const [expr, setExpr] = useState(() => {
    const amt = editing?.amount ?? preset.amount
    return amt ? String(amt / 100) : ''
  })
  const [accountId, setAccountId] = useState(defaultAccount)
  const [toAccountId, setToAccountId] = useState<number | null>(editing?.toAccountId ?? accounts.find((a) => a.id !== defaultAccount)?.id ?? null)
  const [categoryId, setCategoryId] = useState<number | null>(editing?.categoryId ?? preset.categoryId ?? null)
  const [personId, setPersonId] = useState<number | null>(editing?.personId ?? preset.personId ?? null)
  const [note, setNote] = useState(editing?.note ?? '')
  const [occurredAt, setOccurredAt] = useState(editing?.occurredAt ?? localNow())
  const [panel, setPanel] = useState<Panel>('keypad')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [shake, setShake] = useState<string | null>(null)

  const kind: TxKind = mode === 'people' ? personKind : mode
  const result = evaluate(expr)
  const hasOp = /[+−×÷]/.test(expr.replace(/[+−×÷]$/, ''))

  const categories = useMemo(() => {
    if (mode !== 'expense' && mode !== 'income') return []
    return d.categories
      .filter((c) => c.kind === mode && (!c.archived || c.id === categoryId))
      .sort((a, b) => b.useCount - a.useCount || a.sortOrder - b.sortOrder)
  }, [d.categories, mode, categoryId])

  const people = useMemo(
    () => d.people.filter((p) => !p.archived || p.id === personId).sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || '') || a.name.localeCompare(b.name)),
    [d.people, personId],
  )

  // A category from the other kind doesn't carry over when switching modes.
  useEffect(() => {
    if (categoryId && d.categoriesById.get(categoryId)?.kind !== mode) setCategoryId(null)
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const press = useCallback((k: string) => {
    haptic(6)
    setExpr((e) => pressKey(e, k))
  }, [])

  const fail = (what: string, msg: string) => {
    haptic(30)
    setShake(what)
    setTimeout(() => setShake(null), 500)
    toast.error(msg)
  }

  const submit = () => {
    // With a sum on the keypad, the first press shows the result; the next one saves.
    if (hasOp && result != null && result > 0) {
      setExpr(String(result))
      haptic(10)
      return
    }
    const amount = Math.round((result ?? 0) * 100)
    if (amount <= 0) return fail('amount', 'Enter an amount')
    if (!accountId) return fail('account', 'Add an account first')
    if (mode === 'transfer' && (!toAccountId || toAccountId === accountId)) return fail('toAccount', 'Pick a different account to move money to')
    if (mode === 'people' && !personId) {
      setPanel('person')
      return fail('person', 'Pick a person')
    }
    save.mutate(
      {
        id: editing?.id,
        input: {
          kind,
          amount,
          accountId,
          toAccountId: mode === 'transfer' ? toAccountId : null,
          categoryId: mode === 'expense' || mode === 'income' ? categoryId : null,
          personId: mode === 'people' ? personId : null,
          note: note.trim(),
          occurredAt,
        },
      },
      {
        onSuccess: () => {
          haptic(15)
          try {
            localStorage.setItem('kosh:lastAccount', String(accountId))
          } catch {}
          toast.success(editing ? 'Changes saved' : `${kindMeta[kind].verb} ${money(amount)}`)
          closeComposer()
        },
      },
    )
  }

  // Physical keyboard on desktop
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement
      if (e.key === 'Enter') {
        e.preventDefault()
        submitRef.current()
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const map: Record<string, string> = { '+': '+', '-': '−', '*': '×', x: '×', '/': '÷', Backspace: 'back', '.': '.', ',': '.' }
      if (/^[0-9]$/.test(e.key)) press(e.key)
      else if (map[e.key]) {
        e.preventDefault()
        press(map[e.key])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [press])

  const account = d.accountsById.get(accountId)
  const toAccount = toAccountId ? d.accountsById.get(toAccountId) : undefined
  const person = personId ? d.peopleById.get(personId) : undefined
  const amountTone =
    mode === 'income' ? 'text-pos' : mode === 'people' ? (personKind === 'borrow' || personKind === 'collect' ? 'text-pos' : 'text-lend') : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+14px)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <button onClick={closeComposer} aria-label="Close" className="press grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
          <X className="size-[18px]" />
        </button>
        <Segmented
          id="composer-mode"
          size="sm"
          className="flex-1"
          value={mode}
          onChange={(m) => {
            setMode(m)
            setPanel('keypad')
            haptic(6)
          }}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
            { value: 'people', label: 'People' },
          ]}
        />
        {editing && (
          <button
            onClick={() => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                haptic(10)
                setTimeout(() => setConfirmDelete(false), 3000)
                return
              }
              del.mutate(editing, { onSuccess: closeComposer })
            }}
            aria-label="Delete transaction"
            className={cn('press grid h-9 shrink-0 place-items-center rounded-full transition-all', confirmDelete ? 'w-[76px] bg-neg text-[13px] font-semibold text-white' : 'w-9 bg-neg/10 text-neg')}
          >
            {confirmDelete ? 'Delete?' : <Trash2 className="size-[17px]" />}
          </button>
        )}
      </div>

      {mode === 'people' && (
        <div className="px-4 pt-3">
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
            {(['lend', 'borrow', 'collect', 'repay'] as PersonKind[]).map((k) => (
              <Chip key={k} active={personKind === k} onClick={() => setPersonKind(k)} className="flex-1 justify-center">
                {kindMeta[k].label}
              </Chip>
            ))}
          </div>
          <p className="mt-1.5 text-center text-[12px] text-ink-3">{personKindHelp[personKind]}</p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Amount */}
        <motion.div
          animate={shake === 'amount' ? { x: [0, -10, 10, -6, 6, 0] } : {}}
          transition={{ duration: 0.4 }}
          className="flex flex-col items-center px-6 pb-1 pt-5"
        >
          <div className="h-5 text-[13px] font-medium text-ink-3 tnum">{hasOp ? prettyExpr(expr) : ''}</div>
          <div className={cn('flex items-baseline justify-center font-bold tracking-[-0.04em] tnum', amountTone)}>
            <span className="mr-1 text-[30px] font-semibold opacity-60">{currencySymbol()}</span>
            <span className={cn('transition-[font-size] duration-200', (hasOp ? String(result ?? 0) : expr).length > 9 ? 'text-[44px]' : 'text-[58px]', !expr && 'text-ink-3/50')}>
              {hasOp ? groupDigits(String(result ?? 0)) : expr ? groupDigits(expr) : '0'}
            </span>
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={280}
            placeholder={mode === 'people' ? 'What was it for?' : 'Add a note'}
            className="mt-1 w-full max-w-[300px] rounded-xl bg-transparent py-1.5 text-center text-[15px] font-medium outline-none placeholder:text-ink-3 focus:bg-surface-2"
          />
        </motion.div>

        {/* Account, transfer target, date */}
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto px-4 pb-3 pt-2">
          <PickerChip active={panel === 'account'} shake={shake === 'account'} onClick={() => setPanel(panel === 'account' ? 'keypad' : 'account')}>
            {account ? <Glyph icon={account.icon} color={account.color} size={22} /> : null}
            <span className="max-w-[120px] truncate">{account?.name ?? 'Account'}</span>
          </PickerChip>
          {mode === 'transfer' && (
            <>
              <ArrowRight className="size-4 shrink-0 text-ink-3" />
              <PickerChip active={panel === 'toAccount'} shake={shake === 'toAccount'} onClick={() => setPanel(panel === 'toAccount' ? 'keypad' : 'toAccount')}>
                {toAccount ? <Glyph icon={toAccount.icon} color={toAccount.color} size={22} /> : null}
                <span className="max-w-[120px] truncate">{toAccount?.name ?? 'To account'}</span>
              </PickerChip>
            </>
          )}
          {mode === 'people' && (
            <PickerChip active={panel === 'person'} shake={shake === 'person'} onClick={() => setPanel(panel === 'person' ? 'keypad' : 'person')}>
              {person ? <Avatar name={person.name} color={person.color} size={22} /> : <Plus className="size-4" />}
              <span className="max-w-[120px] truncate">{person?.name ?? 'Person'}</span>
            </PickerChip>
          )}
          <PickerChip active={panel === 'date'} onClick={() => setPanel(panel === 'date' ? 'keypad' : 'date')}>
            <CalendarDays className="size-4" />
            <span>{dayLabel(occurredAt.slice(0, 10))}</span>
            <span className="text-ink-3">{timeLabel(occurredAt)}</span>
          </PickerChip>
        </div>

        {/* One-tap category or person strip */}
        {(mode === 'expense' || mode === 'income') && (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-4 pb-3">
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  haptic(6)
                  setCategoryId(categoryId === c.id ? null : c.id)
                }}
                className={cn('press flex shrink-0 items-center gap-1.5 rounded-full py-1.5 pl-1.5 pr-3 text-[13px] font-semibold transition-colors', categoryId === c.id ? '' : 'bg-surface-2 text-ink-2')}
                style={categoryId === c.id ? { background: c.color + '24', color: c.color, boxShadow: `inset 0 0 0 1.5px ${c.color}` } : undefined}
              >
                <span className="grid size-6 place-items-center rounded-full text-[14px]" style={{ background: c.color + '22' }}>
                  {c.icon}
                </span>
                {c.name}
              </button>
            ))}
            <button onClick={() => setPanel(panel === 'category' ? 'keypad' : 'category')} className="press flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-3 text-[13px] font-semibold text-ink-2">
              <LayoutGrid className="size-4" /> All
            </button>
          </div>
        )}
        {mode === 'people' && people.length > 0 && panel !== 'person' && (
          <div className="no-scrollbar flex gap-3 overflow-x-auto px-4 pb-3">
            {people.slice(0, 12).map((p) => (
              <button key={p.id} onClick={() => setPersonId(p.id)} className="press flex w-14 shrink-0 flex-col items-center gap-1">
                <span className={cn('rounded-full p-[2px] transition', personId === p.id ? 'ring-2 ring-accent' : '')}>
                  <Avatar name={p.name} color={p.color} size={42} />
                </span>
                <span className={cn('w-full truncate text-center text-[11px] font-medium', personId === p.id ? 'text-ink' : 'text-ink-3')}>{p.name.split(' ')[0]}</span>
              </button>
            ))}
            <button onClick={() => setPanel('person')} className="press flex w-14 shrink-0 flex-col items-center gap-1">
              <span className="grid size-[46px] place-items-center rounded-full border-2 border-dashed border-ink-3/40 text-ink-3">
                <Plus className="size-5" />
              </span>
              <span className="text-[11px] font-medium text-ink-3">New</span>
            </button>
          </div>
        )}
      </div>

      {/* Keypad, or a picker in its place */}
      <div className="relative h-[262px] shrink-0 overflow-hidden px-3">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={panel}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-3 inset-y-0"
          >
            {panel === 'keypad' && <Keypad onKey={press} onClear={() => setExpr('')} />}
            {panel === 'account' && (
              <AccountPicker accounts={accounts} selected={accountId} onPick={(id) => { setAccountId(id); if (id === toAccountId) setToAccountId(null); setPanel('keypad') }} />
            )}
            {panel === 'toAccount' && (
              <AccountPicker accounts={accounts.filter((a) => a.id !== accountId)} selected={toAccountId ?? 0} onPick={(id) => { setToAccountId(id); setPanel('keypad') }} />
            )}
            {panel === 'date' && <DatePicker value={occurredAt} onChange={setOccurredAt} onDone={() => setPanel('keypad')} />}
            {panel === 'category' && (
              <div className="grid h-full grid-cols-4 content-start gap-2 overflow-y-auto pb-2">
                {categories.map((c) => (
                  <button key={c.id} onClick={() => { setCategoryId(c.id); setPanel('keypad') }} className={cn('press flex flex-col items-center gap-1.5 rounded-2xl p-2', categoryId === c.id && 'bg-surface-2')}>
                    <Glyph icon={c.icon} color={c.color} size={44} />
                    <span className="line-clamp-1 text-[11px] font-medium text-ink-2">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
            {panel === 'person' && (
              <PersonPicker
                people={people}
                selected={personId}
                creating={savePerson.isPending}
                onPick={(id) => { setPersonId(id); setPanel('keypad') }}
                onCreate={(name) =>
                  savePerson.mutate(
                    { body: { name, color: palette[Math.floor(Math.random() * palette.length)] } },
                    { onSuccess: (p) => { setPersonId(p.id); setPanel('keypad') } },
                  )
                }
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="px-4 pt-2">
        <button
          onClick={submit}
          disabled={save.isPending}
          className="press flex h-14 w-full items-center justify-center gap-2 rounded-[20px] bg-accent text-[16px] font-semibold text-white shadow-[0_12px_30px_-12px_var(--accent)] disabled:opacity-60"
        >
          {hasOp ? (
            <>= {money(Math.round((result ?? 0) * 100))}</>
          ) : (
            <>
              <Check className="size-5" strokeWidth={2.6} />
              {editing ? 'Save changes' : `Save ${kindMeta[kind].label.toLowerCase()}`}
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function PickerChip({ active, shake, onClick, children }: { active?: boolean; shake?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <motion.button
      onClick={onClick}
      animate={shake ? { x: [0, -8, 8, -5, 5, 0] } : {}}
      transition={{ duration: 0.4 }}
      className={cn(
        'press flex h-9 shrink-0 items-center gap-1.5 rounded-full pl-1.5 pr-2.5 text-[13px] font-semibold transition-colors',
        active ? 'bg-ink text-bg' : 'bg-surface-2 text-ink',
        shake && 'ring-2 ring-neg',
      )}
    >
      {children}
      <ChevronDown className={cn('size-3.5 opacity-50 transition-transform', active && 'rotate-180')} />
    </motion.button>
  )
}

function Keypad({ onKey, onClear }: { onKey: (k: string) => void; onClear: () => void }) {
  const keys = ['1', '2', '3', '+', '4', '5', '6', '−', '7', '8', '9', '×', '.', '0', 'back', '÷']
  const holdTimer = useRef<number | undefined>(undefined)
  return (
    <div className="grid h-full grid-cols-4 gap-2 pb-1">
      {keys.map((k) => {
        const op = isOp(k)
        return (
          <motion.button
            key={k}
            whileTap={{ scale: 0.92 }}
            transition={{ type: 'spring', stiffness: 600, damping: 30 }}
            onClick={() => onKey(k)}
            onPointerDown={k === 'back' ? () => (holdTimer.current = window.setTimeout(() => { onClear(); haptic(20) }, 500)) : undefined}
            onPointerUp={k === 'back' ? () => clearTimeout(holdTimer.current) : undefined}
            onPointerLeave={k === 'back' ? () => clearTimeout(holdTimer.current) : undefined}
            aria-label={k === 'back' ? 'Backspace (hold to clear)' : k}
            className={cn(
              'grid select-none place-items-center rounded-[18px] text-[26px] font-medium tracking-tight transition-colors',
              op ? 'bg-accent/10 text-[24px] text-accent active:bg-accent/20' : 'bg-surface-2 text-ink active:bg-surface-3',
            )}
          >
            {k === 'back' ? <Delete className="size-6" /> : k}
          </motion.button>
        )
      })}
    </div>
  )
}

function AccountPicker({ accounts, selected, onPick }: { accounts: Account[]; selected: number; onPick: (id: number) => void }) {
  return (
    <div className="grid h-full grid-cols-2 content-start gap-2 overflow-y-auto pb-2">
      {accounts.map((a) => (
        <button
          key={a.id}
          onClick={() => onPick(a.id)}
          className={cn('press flex items-center gap-2.5 rounded-2xl p-3 text-left', a.id === selected ? 'bg-ink text-bg' : 'bg-surface-2')}
        >
          <Glyph icon={a.icon} color={a.color} size={36} />
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold">{a.name}</span>
            <span className="block truncate text-[12px] opacity-60 tnum">{money(a.balance)}</span>
          </span>
        </button>
      ))}
      {accounts.length === 0 && <p className="col-span-2 py-10 text-center text-[14px] text-ink-3">No other accounts yet.</p>}
    </div>
  )
}

function DatePicker({ value, onChange, onDone }: { value: string; onChange: (v: string) => void; onDone: () => void }) {
  const [date, time] = value.split('T')
  const shift = (days: number) => {
    const d = new Date()
    d.setDate(d.getDate() - days)
    return ymd(d)
  }
  const quick = [
    { label: 'Today', date: shift(0) },
    { label: 'Yesterday', date: shift(1) },
    { label: '2 days ago', date: shift(2) },
  ]
  const nowTime = () => {
    const n = new Date()
    return `${pad(n.getHours())}:${pad(n.getMinutes())}`
  }
  return (
    <div className="flex h-full flex-col gap-3 pt-1">
      <div className="grid grid-cols-3 gap-2">
        {quick.map((q) => (
          <button
            key={q.label}
            onClick={() => {
              onChange(`${q.date}T${q.date === shift(0) ? nowTime() : time}`)
              onDone()
            }}
            className={cn('press h-12 rounded-2xl text-[14px] font-semibold', date === q.date ? 'bg-ink text-bg' : 'bg-surface-2')}
          >
            {q.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="rounded-2xl bg-surface-2 px-4 py-2.5">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-3">Date</span>
          <input type="date" value={date} max="2199-12-31" onChange={(e) => e.target.value && onChange(`${e.target.value}T${time}`)} className="w-full bg-transparent text-[15px] font-semibold outline-none" />
        </label>
        <label className="rounded-2xl bg-surface-2 px-4 py-2.5">
          <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-3">Time</span>
          <input type="time" value={time} onChange={(e) => e.target.value && onChange(`${date}T${e.target.value}`)} className="w-full bg-transparent text-[15px] font-semibold outline-none" />
        </label>
      </div>
      <button onClick={onDone} className="press mt-auto mb-1 h-12 rounded-2xl bg-surface-2 text-[15px] font-semibold">
        Done
      </button>
    </div>
  )
}

function PersonPicker({
  people,
  selected,
  creating,
  onPick,
  onCreate,
}: {
  people: Person[]
  selected: number | null
  creating: boolean
  onPick: (id: number) => void
  onCreate: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = people.filter((p) => p.name.toLowerCase().includes(q))
  const exact = people.some((p) => p.name.toLowerCase() === q)
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex gap-2">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or add a person"
          maxLength={50}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q && !exact) {
              e.stopPropagation()
              onCreate(query.trim())
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-2xl bg-surface-2 px-4 text-[15px] outline-none placeholder:text-ink-3"
        />
        {q && !exact && (
          <button disabled={creating} onClick={() => onCreate(query.trim())} className="press flex h-11 shrink-0 items-center gap-1 rounded-2xl bg-accent px-4 text-[14px] font-semibold text-white disabled:opacity-60">
            <Plus className="size-4" /> Add
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.map((p) => (
          <button key={p.id} onClick={() => onPick(p.id)} className={cn('press flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left', p.id === selected && 'bg-surface-2')}>
            <Avatar name={p.name} color={p.color} size={36} />
            <span className="flex-1 truncate text-[15px] font-medium">{p.name}</span>
            {p.balance !== 0 && (
              <span className={cn('text-[12px] font-semibold tnum', p.balance > 0 ? 'text-pos' : 'text-neg')}>
                {p.balance > 0 ? 'owes you ' : 'you owe '}
                {money(Math.abs(p.balance))}
              </span>
            )}
          </button>
        ))}
        {list.length === 0 && !q && <p className="py-8 text-center text-[14px] text-ink-3">Type a name to add someone.</p>}
      </div>
    </div>
  )
}
