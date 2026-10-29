import { AnimatePresence, motion } from 'motion/react'
import { Drawer } from 'vaul'
import { AlignLeft, ArrowRight, CalendarDays, Check, Delete, LayoutGrid, LoaderCircle, Lock, Pencil, Plus, ScanLine, Store, Trash2, TriangleAlert, UserRound, Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Account, Category, Person, Transaction, TxInput, TxKind } from '../lib/api'
import { currencySymbol, dayLabel, getCurrency, localNow, money, pad, ymd } from '../lib/format'
import { haptic, palette } from '../lib/look'
import { useBudgets, useData, useDeleteTx, useSaveEntity, useSaveTx, useSaveTxs, useUpdateMe } from '../lib/queries'
import { payableAccounts } from '../lib/pay'
import { isTouch } from '../lib/device'
import { suggestEmoji } from '../lib/emoji'
import { navigate, useBackToClose } from '../lib/router'
import { closeComposer, composer, openScanner, type ComposerPreset } from '../lib/store'
import { payLink, platform, preferredApp, readPending, rememberApp, upiApps, writePending, type UpiApp, type UpiTarget } from '../lib/upi'
import { isPersonKind, kindMeta } from '../lib/tx'
import { Avatar, Chip, Glyph, Segmented, Toggle, cn } from './ui'

type Mode = 'expense' | 'income' | 'transfer' | 'people'
type PersonKind = 'lend' | 'borrow' | 'collect' | 'repay'
type Panel = 'keypad' | 'account' | 'toAccount' | 'date' | 'category' | 'person' | 'app' | 'split'

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

/** Splits paise equally; the first share takes the leftover paise. */
export function splitEqually(total: number, parts: number): number[] {
  const base = Math.floor(total / parts)
  return Array.from({ length: parts }, (_, i) => base + (i === 0 ? total - base * parts : 0))
}

// ---- Sheet ----

export function Composer() {
  const { open, editing, preset, key } = composer.use((s) => s)
  useBackToClose(open, closeComposer)
  return (
    <Drawer.Root open={open} onOpenChange={(o) => !o && closeComposer()} repositionInputs={false}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[3px]" />
        {/* A full page on phones, like iOS finance apps; a centred panel on larger screens. */}
        <Drawer.Content className="fixed inset-x-0 bottom-0 top-0 z-50 mx-auto flex w-full max-w-[480px] flex-col bg-bg pt-[env(safe-area-inset-top)] outline-none after:hidden! md:top-auto md:bottom-4 md:max-h-[96dvh] md:rounded-[32px] md:pt-0 md:shadow-float md:dark:border md:dark:border-white/10">
          <Drawer.Title className="sr-only">{editing ? 'Edit transaction' : 'Add transaction'}</Drawer.Title>
          <Drawer.Description className="sr-only">Enter an amount and details</Drawer.Description>
          <div className="mx-auto mt-2.5 hidden h-[5px] w-10 shrink-0 rounded-full bg-ink/15 md:block" />
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
  const saveMany = useSaveTxs()
  const updateMe = useUpdateMe()
  const del = useDeleteTx()
  const savePerson = useSaveEntity<Person>('people')

  const initialKind: TxKind = editing?.kind ?? preset.kind ?? 'expense'
  // Paying a scanned QR: money leaves, so only expenses and lend/repay make sense.
  const upi = editing ? undefined : preset.upi
  const amountLocked = upi?.amount != null
  const [app, setApp] = useState(preferredApp)
  const accounts = d.activeAccounts
  // A UPI payment never comes out of cash.
  const pickable = upi && payableAccounts(accounts).length > 0 ? payableAccounts(accounts) : accounts
  const defaultAccount =
    editing?.accountId ?? preset.accountId ?? (pickable.find((a) => a.id === lastAccountId()) ?? pickable[0])?.id ?? 0

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
  const [note, setNote] = useState(editing?.note ?? preset.note ?? '')
  const [occurredAt, setOccurredAt] = useState(editing?.occurredAt ?? localNow())
  const [panel, setPanel] = useState<Panel>('keypad')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [shake, setShake] = useState<string | null>(null)
  // Splitting a bill: your share is the expense, each friend's share a loan to them.
  const [splitWith, setSplitWith] = useState<number[]>([])
  const [includeMe, setIncludeMe] = useState(true)

  const kind: TxKind = mode === 'people' ? personKind : mode
  const result = evaluate(expr)
  const hasOp = /[+−×÷]/.test(expr.replace(/[+−×÷]$/, ''))
  const total = Math.round((result ?? 0) * 100)
  const canSplit = mode === 'expense' && !editing
  const splitting = canSplit && splitWith.length > 0
  const shares = splitting ? splitEqually(total, splitWith.length + (includeMe ? 1 : 0)) : [total]
  const myShare = splitting ? (includeMe ? shares[0] : 0) : total

  // How this expense sits against the month's budget for its category (or overall).
  const budgets = useBudgets(occurredAt.slice(0, 7))
  const budgetNote = (() => {
    if (mode !== 'expense' || editing || !budgets.data) return null
    const b = budgets.data.find((x) => x.categoryId === categoryId && categoryId != null) ?? budgets.data.find((x) => x.categoryId === null)
    if (!b) return null
    const name = b.categoryId ? (d.categoriesById.get(b.categoryId)?.name ?? 'this') : 'your monthly'
    const left = b.amount - b.spent - myShare
    return left >= 0 ? { text: `${money(left)} left in ${name} budget`, over: false } : { text: `${money(-left)} over ${name} budget`, over: true }
  })()

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

  const press = useCallback(
    (k: string) => {
      if (amountLocked) {
        haptic(20)
        toast('This QR sets the amount', { id: 'locked' })
        return
      }
      haptic(6)
      setExpr((e) => pressKey(e, k))
    },
    [amountLocked],
  )

  const fail = (what: string, msg: string) => {
    haptic(30)
    setShake(what)
    setTimeout(() => setShake(null), 500)
    toast.error(msg)
  }

  // With a sum on the keypad, the first press shows the result; the next one saves.
  const resolveSum = () => {
    if (hasOp && result != null && result > 0) {
      setExpr(String(result))
      haptic(10)
      return true
    }
    return false
  }

  const buildInput = (): TxInput | null => {
    const amount = Math.round((result ?? 0) * 100)
    if (amount <= 0) return fail('amount', 'Enter an amount'), null
    if (!accountId) return fail('account', 'Add an account first'), null
    if (mode === 'transfer' && (!toAccountId || toAccountId === accountId)) return fail('toAccount', 'Pick a different account to move money to'), null
    if (mode === 'people' && !personId) {
      setPanel('person')
      return fail('person', 'Pick a person'), null
    }
    return {
      kind,
      amount,
      accountId,
      toAccountId: mode === 'transfer' ? toAccountId : null,
      categoryId: mode === 'expense' || mode === 'income' ? categoryId : null,
      personId: mode === 'people' ? personId : null,
      note: note.trim(),
      occurredAt,
      ...(upi ? { source: 'upi-scan' as const, payee: upi.vpa } : {}),
    }
  }

  /** The transaction to save, or one per person when splitting. */
  const buildItems = (): TxInput[] | null => {
    const input = buildInput()
    if (!input || !splitting) return input && [input]
    const items: TxInput[] = []
    const parts = [...shares]
    if (includeMe) items.push({ ...input, amount: parts.shift()! })
    const forWhat = input.note || d.categoriesById.get(categoryId ?? 0)?.name || 'a bill'
    splitWith.forEach((pid, i) =>
      items.push({
        kind: 'lend',
        amount: parts[i],
        accountId,
        toAccountId: null,
        categoryId: null,
        personId: pid,
        note: `Split: ${forWhat}`.slice(0, 280),
        occurredAt,
        // The payee stays on one entry so Kosh still remembers this UPI ID.
        ...(upi ? { source: 'upi-scan' as const, payee: !includeMe && i === 0 ? upi.vpa : '' } : {}),
      }),
    )
    return items
  }

  const rememberAccount = () => {
    try {
      localStorage.setItem('kosh:lastAccount', String(accountId))
      if (upi) localStorage.setItem('kosh:lastUpiAccount', String(accountId))
    } catch {}
  }

  // Picking another account for a scan offers to make it the default.
  const [offerDefault, setOfferDefault] = useState(false)
  const pickAccount = (id: number) => {
    setAccountId(id)
    if (id === toAccountId) setToAccountId(null)
    setPanel('keypad')
    setOfferDefault(!!upi && id !== d.user.prefs.upiAccountId)
  }
  const makeDefault = () => {
    const a = d.accountsById.get(accountId)
    haptic(10)
    updateMe.mutate({ prefs: { upiAccountId: accountId } }, { onSuccess: () => { setOfferDefault(false); toast.success(`Scans now pay from ${a?.name ?? 'this account'}`) } })
  }

  const submit = () => {
    if (resolveSum()) return
    const items = buildItems()
    if (!items) return
    if (items.length > 1) {
      saveMany.mutate(items, {
        onSuccess: () => {
          haptic(15)
          rememberAccount()
          toast.success(`Split ${money(total)} with ${splitWith.length} ${splitWith.length === 1 ? 'person' : 'people'}`)
          closeComposer()
        },
      })
      return
    }
    const input = items[0]
    save.mutate(
      { id: editing?.id, input },
      {
        onSuccess: () => {
          haptic(15)
          rememberAccount()
          toast.success(editing ? 'Changes saved' : `${kindMeta[kind].verb} ${money(input.amount)}`)
          closeComposer()
        },
      },
    )
  }

  // Hands the payment to a UPI app. It's saved when you come back and say it went through.
  const pay = () => {
    if (!upi || resolveSum()) return
    const items = buildItems()
    if (!items) return
    if (platform === 'other') {
      toast('Open Kosh on your phone to pay with a UPI app, or tap "Already paid".')
      return
    }
    const link = payLink(upi, total, app)
    const startedAt = Date.now()
    writePending({
      items,
      total,
      payee: upi.vpa,
      payeeName: upi.name,
      splitWith: splitWith.map((id) => d.peopleById.get(id)?.name ?? ''),
      link,
      appName: app.name,
      startedAt,
      left: false,
    })
    rememberApp(app)
    rememberAccount()
    haptic(15)
    window.location.href = link
    window.setTimeout(() => {
      const p = readPending()
      if (p?.startedAt === startedAt && !p.left) toast.error(platform === 'ios' ? `${app.name} didn't open. Is it installed? Try another app.` : "No UPI app opened. Is one installed?")
    }, 4000)
  }

  // Physical keyboard on desktop
  const submitRef = useRef(submit)
  submitRef.current = upi ? pay : submit
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
  const category = categoryId ? d.categoriesById.get(categoryId) : undefined
  const toAccount = toAccountId ? d.accountsById.get(toAccountId) : undefined
  const person = personId ? d.peopleById.get(personId) : undefined
  const amountTone =
    mode === 'income' ? 'text-pos' : mode === 'people' ? (personKind === 'borrow' || personKind === 'collect' ? 'text-pos' : 'text-lend') : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col pb-[calc(env(safe-area-inset-bottom)+14px)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 pt-2 md:pt-3">
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
          options={
            upi
              ? [
                  { value: 'expense', label: 'Expense' },
                  { value: 'people', label: 'Lend or pay back' },
                ]
              : [
                  { value: 'expense', label: 'Expense' },
                  { value: 'income', label: 'Income' },
                  { value: 'transfer', label: 'Transfer' },
                  { value: 'people', label: 'People' },
                ]
          }
        />
        {!editing && !upi && (
          <button onClick={openScanner} aria-label="Scan a UPI QR" className="press grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
            <ScanLine className="size-[18px]" />
          </button>
        )}
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
            {((upi ? ['lend', 'repay'] : ['lend', 'borrow', 'collect', 'repay']) as PersonKind[]).map((k) => (
              <Chip key={k} active={personKind === k} onClick={() => setPersonKind(k)} className="flex-1 justify-center">
                {kindMeta[k].label}
              </Chip>
            ))}
          </div>
          {!upi && <p className="mt-1.5 text-center text-[12px] text-ink-3">{personKindHelp[personKind]}</p>}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {upi && <PayeeCard upi={upi} recent={preset.recent} link={payLink(upi, total, app)} onAlreadyPaid={submit} saving={save.isPending || saveMany.isPending} />}

        {/* Amount */}
        <motion.div
          animate={shake === 'amount' ? { x: [0, -10, 10, -6, 6, 0] } : {}}
          transition={{ duration: 0.4 }}
          className={cn('my-auto flex flex-col items-center px-6 pb-4', upi ? 'pt-2' : 'pt-5')}
        >
          <div className="flex h-5 items-center gap-1 text-[13px] font-medium text-ink-3 tnum">
            {hasOp ? (
              prettyExpr(expr)
            ) : amountLocked ? (
              <>
                <Lock className="size-3" /> Amount set by the QR
              </>
            ) : budgetNote && total > 0 ? (
              <span className={budgetNote.over ? 'font-semibold text-neg' : ''}>{budgetNote.text}</span>
            ) : (
              ''
            )}
          </div>
          <div className="relative flex w-full items-center justify-center">
            <div className={cn('flex items-baseline justify-center font-rounded font-medium tracking-[-0.02em] tnum', amountTone)}>
              <span className="mr-1 text-[30px] font-medium text-ink-3">{currencySymbol()}</span>
              <span className={cn('transition-[font-size] duration-200', (hasOp ? String(result ?? 0) : expr).length > 9 ? 'text-[44px]' : 'text-[60px]', !expr && 'text-ink-3/50')}>
                {hasOp ? groupDigits(String(result ?? 0)) : expr ? groupDigits(expr) : '0'}
              </span>
            </div>
            {!upi && expr && <Backspace onKey={press} onClear={() => setExpr('')} className="absolute right-0" />}
          </div>
          <label className="mt-3 flex h-9 max-w-[280px] items-center gap-1.5 rounded-full bg-surface px-3.5 text-ink-3 focus-within:text-ink">
            <AlignLeft className="size-4 shrink-0" />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={280}
              placeholder={mode === 'people' ? 'What was it for?' : 'Add a note'}
              onFocus={(e) => upi && e.currentTarget.select()}
              className="field-sizing-content min-w-[5.5em] max-w-[220px] bg-transparent text-[15px] font-medium text-ink outline-none placeholder:text-ink-3"
            />
          </label>
        </motion.div>

      </div>

      {/* Details, one small pill each; tapping one swaps the keypad for its picker */}
      <div className="no-scrollbar flex shrink-0 items-center gap-2 overflow-x-auto px-4 pb-3 pt-1">
        {(mode === 'expense' || mode === 'income') && (
          <PickerChip active={panel === 'category'} onClick={() => setPanel(panel === 'category' ? 'keypad' : 'category')} tint={category?.color}>
            {category ? <span className="text-[15px] leading-none">{category.icon}</span> : <LayoutGrid className="size-4" />}
            <span className="max-w-[120px] truncate">{category?.name ?? 'Category'}</span>
          </PickerChip>
        )}
        {mode === 'people' && (
          <PickerChip active={panel === 'person'} shake={shake === 'person'} onClick={() => setPanel(panel === 'person' ? 'keypad' : 'person')}>
            {person ? <Avatar name={person.name} color={person.color} size={20} /> : <UserRound className="size-4" />}
            <span className="max-w-[120px] truncate">{person?.name ?? 'Person'}</span>
          </PickerChip>
        )}
        <PickerChip active={panel === 'account'} shake={shake === 'account'} onClick={() => setPanel(panel === 'account' ? 'keypad' : 'account')}>
          {account ? <span className="text-[15px] leading-none">{account.icon}</span> : null}
          <span className="max-w-[120px] truncate">{account?.name ?? 'Account'}</span>
        </PickerChip>
        {mode === 'transfer' && (
          <>
            <ArrowRight className="size-4 shrink-0 text-ink-3" />
            <PickerChip active={panel === 'toAccount'} shake={shake === 'toAccount'} onClick={() => setPanel(panel === 'toAccount' ? 'keypad' : 'toAccount')}>
              {toAccount ? <span className="text-[15px] leading-none">{toAccount.icon}</span> : null}
              <span className="max-w-[120px] truncate">{toAccount?.name ?? 'To account'}</span>
            </PickerChip>
          </>
        )}
        {offerDefault && (
          <button onClick={makeDefault} disabled={updateMe.isPending} className="press h-8 shrink-0 rounded-full bg-accent/12 px-3 text-[13px] font-semibold text-accent disabled:opacity-60">
            Make default
          </button>
        )}
        {upi && platform === 'ios' && (
          <PickerChip active={panel === 'app'} onClick={() => setPanel(panel === 'app' ? 'keypad' : 'app')}>
            <AppDot app={app} size={18} />
            <span>{app.short}</span>
          </PickerChip>
        )}
        <PickerChip active={panel === 'date'} onClick={() => setPanel(panel === 'date' ? 'keypad' : 'date')}>
          <CalendarDays className="size-4" />
          <span>{dayLabel(occurredAt.slice(0, 10))}</span>
        </PickerChip>
        {canSplit && (
          <PickerChip active={panel === 'split' || splitting} onClick={() => setPanel(panel === 'split' ? 'keypad' : 'split')}>
            <Users className="size-4" />
            <span>{splitting ? `Split · ${splitWith.length + (includeMe ? 1 : 0)}` : 'Split'}</span>
          </PickerChip>
        )}
      </div>

      {/* Keypad, or a picker in its place */}
      <div className="relative h-[min(310px,38dvh)] shrink-0 overflow-hidden px-3 md:h-[min(280px,34dvh)]">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div
            key={panel}
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-3 inset-y-0"
          >
            {panel === 'keypad' && (
              <Keypad
                onKey={press}
                onClear={() => setExpr('')}
                done={upi ? undefined : { onPress: submit, busy: save.isPending || saveMany.isPending, label: hasOp ? '=' : undefined }}
              />
            )}
            {panel === 'account' && (
              <AccountPicker accounts={pickable} selected={accountId} onPick={pickAccount} />
            )}
            {panel === 'toAccount' && (
              <AccountPicker accounts={accounts.filter((a) => a.id !== accountId)} selected={toAccountId ?? 0} onPick={(id) => { setToAccountId(id); setPanel('keypad') }} />
            )}
            {panel === 'split' && (
              <SplitPicker
                people={people}
                selected={splitWith}
                includeMe={includeMe}
                shares={total > 0 ? shares : null}
                creating={savePerson.isPending}
                onToggle={(id) => { haptic(6); setSplitWith((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id])) }}
                onIncludeMe={setIncludeMe}
                onCreate={(name) =>
                  savePerson.mutate(
                    { body: { name, color: palette[Math.floor(Math.random() * palette.length)] } },
                    { onSuccess: (p) => setSplitWith((l) => [...l, p.id]) },
                  )
                }
                onDone={() => setPanel('keypad')}
              />
            )}
            {panel === 'app' && (
              <div className="grid h-full grid-cols-2 content-start gap-2 overflow-y-auto pb-2">
                <p className="col-span-2 px-1 text-[12px] text-ink-3">Kosh opens this app with the payment filled in.</p>
                {upiApps.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => { haptic(6); setApp(a); setPanel('keypad') }}
                    className={cn('press flex items-center gap-2.5 rounded-2xl p-3 text-left', a.id === app.id ? 'bg-ink text-bg' : 'bg-surface-2')}
                  >
                    <AppDot app={a} size={32} />
                    <span className="truncate text-[14px] font-semibold">{a.name}</span>
                  </button>
                ))}
              </div>
            )}
            {panel === 'date' && <DatePicker value={occurredAt} onChange={setOccurredAt} onDone={() => setPanel('keypad')} />}
            {panel === 'category' && (
              <CategoryPicker
                categories={categories}
                selected={categoryId}
                kind={mode === 'income' ? 'income' : 'expense'}
                onPick={(id) => {
                  haptic(6)
                  setCategoryId(id)
                  // Let the choice show for a moment, then bring the keypad back.
                  setTimeout(() => setPanel('keypad'), 260)
                }}
              />
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

      {upi && (
        <div className="px-4 pt-3">
          <button
            onClick={pay}
            className="press flex h-14 w-full items-center justify-center gap-2 rounded-[18px] bg-accent text-[16px] font-semibold text-white"
          >
            {hasOp ? (
              <>= {money(Math.round((result ?? 0) * 100))}</>
            ) : (
              <>
                Pay {result ? money(Math.round(result * 100)) : ''} {platform === 'ios' ? `with ${app.short}` : ''}
                <ArrowRight className="size-5" strokeWidth={2.4} />
              </>
            )}
          </button>
        </div>
      )}
    </div>
  )
}

function AppDot({ app, size = 20 }: { app: UpiApp; size?: number }) {
  return (
    <span className="grid shrink-0 place-items-center rounded-full font-bold text-white" style={{ width: size, height: size, background: app.color, fontSize: size * 0.45 }}>
      {app.short[0]}
    </span>
  )
}

function minutesAgo(utc: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(utc)) / 60000))
}

function agoText(min: number): string {
  return min < 1 ? 'just now' : `${min} min ago`
}

function PayeeCard({
  upi,
  recent,
  link,
  onAlreadyPaid,
  saving,
}: {
  upi: UpiTarget
  recent?: ComposerPreset['recent']
  link: string
  onAlreadyPaid: () => void
  saving: boolean
}) {
  const [details, setDetails] = useState(false)
  // A second payment minutes after the first is usually a mistake.
  const min = recent ? minutesAgo(recent.savedAt) : Infinity
  const warn = recent && min < 30 ? recent : null
  return (
    <div className="mx-4 mt-3 rounded-[20px] bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <button onClick={() => setDetails((v) => !v)} aria-expanded={details} aria-label={`${upi.name}, show QR details`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          {upi.merchant ? (
            <span className="grid size-9 shrink-0 place-items-center rounded-[12px] bg-accent/12 text-accent">
              <Store className="size-[18px]" />
            </span>
          ) : (
            <Avatar name={upi.name} color="#64748B" size={36} />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold">{upi.name}</span>
            <span className="block truncate text-[12px] text-ink-3">
              {upi.merchant ? 'Shop' : 'Person'} · {upi.vpa}
            </span>
          </span>
        </button>
        <button onClick={onAlreadyPaid} disabled={saving} className="press shrink-0 rounded-full bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-2 disabled:opacity-60">
          Already paid
        </button>
      </div>
      {warn && (
        <p className="mt-2 flex items-start gap-2 rounded-xl bg-warn/12 px-2.5 py-2 text-[12px] font-medium text-warn">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          {`You paid ${money(warn.amount)} here ${agoText(min)}. Make sure you're not paying twice.`}
        </p>
      )}
      {details && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-[11px] text-ink-3">
          <p className="break-all"><span className="font-semibold text-ink-2">QR: </span>{upi.raw}</p>
          <p className="break-all"><span className="font-semibold text-ink-2">Opens: </span>{link}</p>
        </div>
      )}
    </div>
  )
}

function PickerChip({ active, shake, tint, onClick, children }: { active?: boolean; shake?: boolean; tint?: string; onClick: () => void; children: ReactNode }) {
  return (
    <motion.button
      onClick={onClick}
      animate={shake ? { x: [0, -8, 8, -5, 5, 0] } : {}}
      transition={{ duration: 0.4 }}
      className={cn(
        'press flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors',
        active ? 'bg-ink text-bg' : 'bg-surface text-ink',
        shake && 'ring-2 ring-neg',
      )}
      style={!active && tint ? { background: tint + '1F', color: tint } : undefined}
    >
      {children}
    </motion.button>
  )
}

/** Deletes the last digit; hold to clear the amount. */
function Backspace({ onKey, onClear, className }: { onKey: (k: string) => void; onClear: () => void; className?: string }) {
  const hold = useRef<number | undefined>(undefined)
  return (
    <button
      onClick={() => onKey('back')}
      onPointerDown={() => (hold.current = window.setTimeout(() => { onClear(); haptic(20) }, 500))}
      onPointerUp={() => clearTimeout(hold.current)}
      onPointerLeave={() => clearTimeout(hold.current)}
      aria-label="Backspace (hold to clear)"
      className={cn('press grid size-9 place-items-center rounded-full bg-surface text-ink-2', className)}
    >
      <Delete className="size-[18px]" />
    </button>
  )
}

/** Digits only, like a phone's number pad. The last key saves (or deletes, when paying a scan). */
function Keypad({ onKey, onClear, done }: { onKey: (k: string) => void; onClear: () => void; done?: { onPress: () => void; busy: boolean; label?: string } }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', done ? 'done' : 'back']
  const hold = useRef<number | undefined>(undefined)
  return (
    <div className="grid h-full grid-cols-3 gap-2 pb-1">
      {keys.map((k) => {
        if (k === 'done' && done) {
          return (
            <motion.button
              key={k}
              whileTap={{ scale: 0.94 }}
              onClick={done.onPress}
              disabled={done.busy}
              aria-label="Save"
              className="grid select-none place-items-center rounded-[16px] bg-accent text-[26px] font-medium text-white disabled:opacity-60"
            >
              {done.busy ? <LoaderCircle className="size-6 animate-spin" /> : done.label ?? <Check className="size-7" strokeWidth={2.6} />}
            </motion.button>
          )
        }
        return (
          <motion.button
            key={k}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 600, damping: 30 }}
            onClick={() => onKey(k)}
            onPointerDown={k === 'back' ? () => (hold.current = window.setTimeout(() => { onClear(); haptic(20) }, 500)) : undefined}
            onPointerUp={k === 'back' ? () => clearTimeout(hold.current) : undefined}
            onPointerLeave={k === 'back' ? () => clearTimeout(hold.current) : undefined}
            aria-label={k === 'back' ? 'Backspace (hold to clear)' : k}
            className="grid select-none place-items-center rounded-[16px] bg-surface font-rounded text-[28px] font-normal text-ink active:bg-surface-3"
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

/** Categories as tinted chips in two columns, with a quick way to add one. */
function CategoryPicker({ categories, selected, kind, onPick }: { categories: Category[]; selected: number | null; kind: 'expense' | 'income'; onPick: (id: number) => void }) {
  const save = useSaveEntity<Category>('categories')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const suggested = suggestEmoji(name)
  const icon = emoji.trim() || suggested || '🏷️'

  const create = () => {
    if (!name.trim()) return
    const color = palette[(categories.length * 5) % palette.length]
    save.mutate(
      { body: { kind, name: name.trim(), icon, color } },
      {
        onSuccess: (c) => {
          setAdding(false)
          setName('')
          setEmoji('')
          onPick(c.id)
        },
      },
    )
  }

  if (adding) {
    return (
      <form
        className="flex h-full flex-col gap-3 pt-1"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <p className="px-1 text-[13px] font-semibold text-ink-2">New {kind === 'income' ? 'income' : 'expense'} category</p>
        <div className="flex gap-2">
          <input
            value={emoji}
            onChange={(e) => setEmoji([...e.target.value].slice(-2).join(''))}
            placeholder={suggested ?? '🏷️'}
            aria-label="Emoji"
            className="h-12 w-14 shrink-0 rounded-2xl bg-surface text-center text-[24px] outline-none placeholder:opacity-60"
          />
          <input
            autoFocus={!isTouch}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name, like Coffee"
            maxLength={40}
            enterKeyHint="done"
            className="h-12 min-w-0 flex-1 rounded-2xl bg-surface px-4 text-[16px] outline-none placeholder:text-ink-3"
          />
        </div>
        <div className="mt-auto grid grid-cols-2 gap-2 pb-1">
          <button type="button" onClick={() => setAdding(false)} className="press h-12 rounded-2xl bg-surface text-[15px] font-semibold">
            Cancel
          </button>
          <button type="submit" disabled={!name.trim() || save.isPending} className="press h-12 rounded-2xl bg-accent text-[15px] font-semibold text-white disabled:opacity-50">
            Add {icon}
          </button>
        </div>
      </form>
    )
  }

  return (
    <div className="relative h-full">
      <div className="no-scrollbar h-full overflow-y-auto pb-16">
        <div className="grid grid-cols-2 gap-2">
          {categories.map((c) => {
            const on = selected === c.id
            return (
              <button
                key={c.id}
                onClick={() => onPick(c.id)}
                className={cn('press flex h-11 items-center gap-2 rounded-[13px] px-3 text-left transition-opacity', selected != null && !on && 'opacity-50')}
                style={{
                  background: `color-mix(in oklab, ${c.color} 20%, transparent)`,
                  color: `color-mix(in oklab, ${c.color} 78%, var(--ink))`,
                  boxShadow: on ? `inset 0 0 0 2px ${c.color}` : undefined,
                }}
              >
                <span className="text-[16px] leading-none">{c.icon}</span>
                <span className="truncate text-[15px] font-semibold">{c.name}</span>
              </button>
            )
          })}
        </div>
      </div>
      {/* Always in reach, however many categories there are. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-1 flex justify-center gap-2">
        <button onClick={() => setAdding(true)} className="press pointer-events-auto flex h-10 items-center gap-1.5 rounded-full bg-accent px-4 text-[14px] font-semibold text-white shadow-float">
          <Plus className="size-4" strokeWidth={2.6} /> New
        </button>
        <button
          onClick={() => {
            closeComposer()
            navigate('/categories')
          }}
          className="press pointer-events-auto flex h-10 items-center gap-1.5 rounded-full bg-surface-2 px-4 text-[14px] font-semibold text-ink-2 shadow-float"
        >
          <Pencil className="size-3.5" /> Edit
        </button>
      </div>
    </div>
  )
}

function SplitPicker({
  people,
  selected,
  includeMe,
  shares,
  creating,
  onToggle,
  onIncludeMe,
  onCreate,
  onDone,
}: {
  people: Person[]
  selected: number[]
  includeMe: boolean
  shares: number[] | null
  creating: boolean
  onToggle: (id: number) => void
  onIncludeMe: (v: boolean) => void
  onCreate: (name: string) => void
  onDone: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const list = people.filter((p) => p.name.toLowerCase().includes(q))
  const exact = people.some((p) => p.name.toLowerCase() === q)
  const each = shares && selected.length > 0 ? shares[shares.length - 1] : null
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Split with…"
          maxLength={50}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && q && !exact) {
              e.stopPropagation()
              onCreate(query.trim())
              setQuery('')
            }
          }}
          className="h-11 min-w-0 flex-1 rounded-2xl bg-surface-2 px-4 text-[15px] outline-none placeholder:text-ink-3"
        />
        {q && !exact ? (
          <button disabled={creating} onClick={() => { onCreate(query.trim()); setQuery('') }} className="press flex h-11 shrink-0 items-center gap-1 rounded-2xl bg-accent px-4 text-[14px] font-semibold text-white disabled:opacity-60">
            <Plus className="size-4" /> Add
          </button>
        ) : (
          <button onClick={onDone} className="press h-11 shrink-0 rounded-2xl bg-ink px-4 text-[14px] font-semibold text-bg">
            Done
          </button>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 px-1">
        <p className="text-[13px] text-ink-2">
          {each != null ? (
            <>
              <span className="font-semibold text-ink tnum">{money(each)}</span> each
              {includeMe ? ' · your share is the expense' : ' · all of it is lent'}
            </>
          ) : (
            'Pick who shares this bill'
          )}
        </p>
        <span className="flex shrink-0 items-center gap-2 text-[12px] font-semibold text-ink-3">
          Include me <Toggle checked={includeMe} onChange={onIncludeMe} label="Include me in the split" />
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {list.map((p) => {
          const on = selected.includes(p.id)
          return (
            <button key={p.id} onClick={() => onToggle(p.id)} className={cn('press flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left', on && 'bg-surface-2')}>
              <Avatar name={p.name} color={p.color} size={34} />
              <span className="flex-1 truncate text-[15px] font-medium">{p.name}</span>
              <span className={cn('grid size-6 place-items-center rounded-full border-2', on ? 'border-accent bg-accent text-white' : 'border-ink-3/40')}>
                {on && <Check className="size-3.5" strokeWidth={3} />}
              </span>
            </button>
          )
        })}
        {list.length === 0 && !q && <p className="py-6 text-center text-[14px] text-ink-3">Type a name to add someone.</p>}
      </div>
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
          autoFocus={!isTouch}
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
