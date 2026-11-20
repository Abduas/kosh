import { useMutation } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { AlertTriangle, Check, CheckCircle2, ChevronRight, FileSearch, HandHeart, ShieldCheck } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button, Chip, ScreenHeader, Segmented, TextInput, Toggle, cn } from '../components/ui'
import { api, ApiError, errorMessage, type StatementCheck, type StatementLabel, type StatementRow } from '../lib/api'
import { PasswordNeeded } from '../lib/docread'
import { money, shortDate } from '../lib/format'
import { invalidateMoney, useData } from '../lib/queries'
import { navigate, useLocation } from '../lib/router'
import { STATEMENT_ACCEPT, readStatementFile } from '../lib/statementpdf'

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'Asia/Kolkata'
  }
}

const LABELS: Record<Exclude<StatementLabel, ''>, string> = {
  interest: 'Interest',
  'interest-paid': 'Interest paid',
  tds: 'Tax on interest',
  charges: 'Bank charge',
}

const PAGE = 60

/** A statement's dates are history: always the date, never "Today". */
const day = (d: string) => format(parseISO(d.slice(0, 10)), 'd MMM yyyy')

/**
 * Check a bank statement: the interest the bank paid, what it charged, and
 * what's missing on either side. The file is read on the phone; nothing in
 * Kosh changes until the person adds or files something.
 */
export function StatementScreen() {
  const d = useData()
  const { search } = useLocation()
  const accounts = d.accounts.filter((a) => !a.archived && a.kind !== 'cash')
  const fromUrl = Number(search.get('account'))
  const [accountId, setAccountId] = useState(
    accounts.find((a) => a.id === fromUrl)?.id ?? accounts.find((a) => a.id === d.user.prefs.upiAccountId)?.id ?? accounts[0]?.id ?? 0,
  )
  const account = d.accounts.find((a) => a.id === accountId)
  const input = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [locked, setLocked] = useState<{ file: File; wrong: boolean } | null>(null)
  const [password, setPassword] = useState('')
  const [csv, setCsv] = useState<string | null>(null)
  const [check, setCheck] = useState<StatementCheck | null>(null)

  const run = useMutation({
    mutationFn: (text: string) => api<StatementCheck>('POST', '/api/statements/check', { csv: text, timezone: timezone(), accountId }),
    onSuccess: setCheck,
    onError: (e) => toast.error(errorMessage(e)),
  })

  const open = async (file: File, pw?: string) => {
    setLocked(null)
    setStatus('Reading…')
    try {
      const text = await readStatementFile(file, { password: pw, status: setStatus })
      setCsv(text)
      setStatus('Checking against Kosh…')
      await run.mutateAsync(text)
    } catch (e) {
      if (e instanceof PasswordNeeded) setLocked({ file, wrong: e.wrong })
      else if (!(e instanceof ApiError)) toast.error(e instanceof Error ? e.message : 'Couldn’t read that file.')
    } finally {
      setStatus(null)
      if (input.current) input.current.value = ''
    }
  }

  const refresh = async () => {
    if (csv) setCheck(await api<StatementCheck>('POST', '/api/statements/check', { csv, timezone: timezone(), accountId }))
  }

  if (check && account) return <Result check={check} accountName={account.name} onRefresh={refresh} onReset={() => setCheck(null)} />

  return (
    <div>
      <ScreenHeader title="Check a statement" back="/settings" subtitle="The interest your bank paid, what it charged, and what Kosh is missing." />
      <input ref={input} type="file" accept={STATEMENT_ACCEPT} className="hidden" onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />

      {accounts.length === 0 ? (
        <p className="rounded-[22px] bg-surface p-5 text-[15px] text-ink-2">Add your bank account first, then check its statement here.</p>
      ) : (
        <div className="rounded-[24px] bg-surface p-5 shadow-card">
          <p className="mb-2 text-[13px] font-medium text-ink-2">Which account is it for?</p>
          <div className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5">
            {accounts.map((a) => (
              <Chip key={a.id} active={a.id === accountId} color={a.color} onClick={() => setAccountId(a.id)}>
                <span>{a.icon}</span> {a.name}
              </Chip>
            ))}
          </div>

          <ol className="mt-5 space-y-3">
            {['In net banking or your bank’s app, open Statement or e-Passbook.', 'Pick the period, for example the last financial year, and download it as PDF or Excel.', 'Choose the file here.'].map((step, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-snug">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/12 text-[13px] font-bold text-accent">{i + 1}</span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>

          {locked ? (
            <form
              className="mt-5 space-y-2"
              onSubmit={(e) => {
                e.preventDefault()
                open(locked.file, password)
              }}
            >
              <p className="text-[13px] font-medium text-ink-2">{locked.wrong ? 'That password didn’t open it. Try again.' : 'This PDF has a password. Banks often use your date of birth or customer ID.'}</p>
              <TextInput type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoComplete="off" />
              <Button size="lg" type="submit" className="w-full" loading={!!status}>
                Open
              </Button>
            </form>
          ) : (
            <Button size="lg" className="mt-5 w-full" loading={!!status} onClick={() => input.current?.click()}>
              <FileSearch className="size-5" /> {status ?? 'Choose the statement'}
            </Button>
          )}
          <p className="mt-4 flex items-start gap-2 text-[13px] text-ink-3">
            <ShieldCheck className="mt-px size-4 shrink-0 text-pos" />
            The file is read on this phone. It isn’t uploaded or kept, and nothing in Kosh changes until you choose to add something.
          </p>
        </div>
      )}
    </div>
  )
}

function Result({ check, accountName, onRefresh, onReset }: { check: StatementCheck; accountName: string; onRefresh: () => Promise<void>; onReset: () => void }) {
  const [tab, setTab] = useState<'missing' | 'kosh' | 'matched'>(check.missing > 0 ? 'missing' : 'kosh')
  const balanced = check.closing !== null && check.closing === check.koshClosing
  const [keepBalance, setKeepBalance] = useState(balanced)
  const missing = useMemo(() => check.rows.filter((r) => !r.match), [check])
  const matched = useMemo(() => check.rows.filter((r) => r.match), [check])
  const interestRows = check.rows.filter((r) => r.label === 'interest')
  const chargeRows = check.rows.filter((r) => r.label === 'charges')
  const [picked, setPicked] = useState<Set<number>>(() => new Set(missing.filter((r) => r.label === 'interest').map((r) => r.index)))

  const add = useMutation({
    mutationFn: (rows: StatementRow[]) =>
      api<{ added: number; skipped: number }>('POST', '/api/statements/add', {
        accountId: check.accountId,
        keepBalance,
        rows: rows.map((r) => ({ at: r.at, kind: r.kind, amount: r.amount, note: r.note, label: r.label })),
      }),
    onSuccess: async (r) => {
      invalidateMoney()
      toast.success(r.added === 1 ? 'Added 1 entry' : `Added ${r.added.toLocaleString()} entries`)
      setPicked(new Set())
      await onRefresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const markInterest = useMutation({
    mutationFn: (ids: number[]) => api('POST', '/api/statements/mark-interest', { ids }),
    onSuccess: async () => {
      invalidateMoney()
      toast.success('Filed under Interest')
      await onRefresh()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })

  const isInterestCat = (r: StatementRow) => r.match?.categoryId != null && r.match.categoryId === check.interestCategoryId
  const interestMissing = interestRows.filter((r) => !r.match)
  const interestMisfiled = interestRows.filter((r) => r.match && !isInterestCat(r))
  const gap = check.closing === null ? null : check.closing - check.koshClosing

  return (
    <div>
      <ScreenHeader
        title={accountName}
        subtitle={`${day(check.from)} – ${day(check.to)} · ${check.count.toLocaleString()} entries`}
        back="/settings"
        actions={
          <Button variant="ghost" size="sm" onClick={onReset}>
            Another file
          </Button>
        }
      />

      {/* Whether the file was read right: each row's balance follows from the last. */}
      {check.closing !== null &&
        (check.breaks.length === 0 ? (
          <Note icon={<CheckCircle2 className="size-4 text-pos" />}>Read correctly: every entry adds up to the bank’s balance.</Note>
        ) : (
          <Note icon={<AlertTriangle className="size-4 text-warn" />}>
            {check.breaks.length === 1 ? '1 entry doesn’t' : `${check.breaks.length} entries don’t`} add up to the bank’s balance, from {shortDate(check.rows[check.breaks[0]].at.slice(0, 10))}. The file may be missing a page.
          </Note>
        ))}
      {check.problems.length > 0 && <Note icon={<AlertTriangle className="size-4 text-warn" />}>{check.problems.length} lines couldn’t be read and were left out.</Note>}

      {/* Interest */}
      <section className="mt-3 overflow-hidden rounded-[24px] bg-surface shadow-card">
        <div className="p-5">
          <p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Interest the bank paid</p>
          <p className="mt-1 text-[36px] font-bold leading-tight tracking-[-0.03em] tnum">{money(check.interest)}</p>
          <p className="text-[13px] text-ink-3">
            {interestRows.length === 0 ? 'No interest in this statement' : interestRows.length === 1 ? '1 credit' : `${interestRows.length} credits`}
            {check.tds > 0 && ` · ${money(check.tds)} tax taken from it`}
            {check.interestPaid > 0 && ` · you paid ${money(check.interestPaid)} in interest`}
          </p>
        </div>
        {interestRows.length > 0 && (
          <div className="divide-y divide-line border-t border-line">
            {interestRows.map((r) => (
              <Row key={r.index} row={r} status={!r.match ? 'Not in Kosh' : isInterestCat(r) ? 'In Kosh as Interest' : 'In Kosh, not as interest'} ok={isInterestCat(r)} />
            ))}
          </div>
        )}
        {(interestMissing.length > 0 || interestMisfiled.length > 0) && (
          <div className="space-y-2 border-t border-line p-4">
            {interestMissing.length > 0 && (
              <Button className="w-full" loading={add.isPending} onClick={() => add.mutate(interestMissing)}>
                Add {interestMissing.length === 1 ? 'it' : `these ${interestMissing.length}`} to Kosh as interest
              </Button>
            )}
            {interestMisfiled.length > 0 && (
              <Button variant="secondary" className="w-full" loading={markInterest.isPending} onClick={() => markInterest.mutate(interestMisfiled.map((r) => r.match!.id))}>
                File {interestMisfiled.length === 1 ? 'the one in Kosh' : `the ${interestMisfiled.length} in Kosh`} under Interest
              </Button>
            )}
            {interestMissing.length > 0 && (
              <label className="flex items-center justify-between gap-3 pt-1">
                <span className="text-[13px] text-ink-2">Keep {accountName}’s balance as it is</span>
                <Toggle checked={keepBalance} onChange={setKeepBalance} label="Keep the balance as it is" />
              </label>
            )}
          </div>
        )}
        <button onClick={() => navigate('/interest')} className="press flex w-full items-center gap-3 border-t border-line px-5 py-3.5 text-left">
          <HandHeart className="size-5 text-accent" />
          <span className="flex-1 text-[15px] font-medium">Interest to give away</span>
          <ChevronRight className="size-4 text-ink-3" />
        </button>
      </section>

      {/* Charges and balance */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Stat label="Bank charges" value={money(check.charges)} sub={chargeRows.length === 1 ? '1 charge' : `${chargeRows.length} charges`} />
        <Stat
          label={`Balance on ${day(check.to)}`}
          value={check.closing === null ? '—' : money(check.closing)}
          sub={gap === null ? 'The file has no balance' : gap === 0 ? 'Kosh agrees' : `Kosh says ${money(check.koshClosing)}`}
          tone={gap === null ? undefined : gap === 0 ? 'pos' : 'warn'}
        />
      </div>
      {chargeRows.length > 0 && (
        <details className="mt-3 overflow-hidden rounded-[22px] bg-surface shadow-card">
          <summary className="press flex cursor-pointer list-none items-center justify-between px-5 py-3.5 text-[15px] font-medium">
            What the bank charged <ChevronRight className="size-4 text-ink-3" />
          </summary>
          <div className="divide-y divide-line border-t border-line">
            {chargeRows.map((r) => (
              <Row key={r.index} row={r} status={r.match ? 'In Kosh' : 'Not in Kosh'} ok={!!r.match} />
            ))}
          </div>
        </details>
      )}

      {/* Cross-check */}
      <h2 className="mb-2.5 mt-8 px-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Statement and Kosh</h2>
      <Segmented
        id="stmt-tab"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'missing', label: `Not in Kosh ${check.missing}` },
          { value: 'kosh', label: `Only in Kosh ${check.koshOnly.length}` },
          { value: 'matched', label: `Both ${check.matched}` },
        ]}
      />
      <div className="mt-3">
        {tab === 'missing' && (
          <MissingList
            rows={missing}
            picked={picked}
            setPicked={setPicked}
            accountName={accountName}
            keepBalance={keepBalance}
            setKeepBalance={setKeepBalance}
            adding={add.isPending}
            onAdd={() => add.mutate(missing.filter((r) => picked.has(r.index)))}
          />
        )}
        {tab === 'kosh' && (
          <List
            empty="Everything in Kosh for these dates is in the statement."
            hint="In Kosh for these dates, but not in the statement: a different account or date, or entered twice."
            items={check.koshOnly.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{t.note || (t.in ? 'Money in' : 'Money out')}</p>
                  <p className="text-[12px] text-ink-3">{shortDate(t.at.slice(0, 10))}</p>
                </div>
                <Amount value={t.in ? t.amount : -t.amount} />
              </div>
            ))}
          />
        )}
        {tab === 'matched' && <List empty="Nothing matched yet." items={matched.map((r) => <Row key={r.index} row={r} />)} />}
      </div>
    </div>
  )
}

function MissingList({
  rows,
  picked,
  setPicked,
  accountName,
  keepBalance,
  setKeepBalance,
  adding,
  onAdd,
}: {
  rows: StatementRow[]
  picked: Set<number>
  setPicked: (s: Set<number>) => void
  accountName: string
  keepBalance: boolean
  setKeepBalance: (v: boolean) => void
  adding: boolean
  onAdd: () => void
}) {
  if (rows.length === 0) return <List empty="Everything in the statement is in Kosh." items={[]} />
  const all = picked.size === rows.length
  const toggle = (i: number) => {
    const next = new Set(picked)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setPicked(next)
  }
  return (
    <>
      <div className="mb-2 flex items-center justify-between px-1">
        <p className="text-[13px] text-ink-3">Tap the ones to add</p>
        <button className="press text-[13px] font-semibold text-accent" onClick={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.index)))}>
          {all ? 'Select none' : 'Select all'}
        </button>
      </div>
      <List
        items={rows.map((r) => (
          <button key={r.index} onClick={() => toggle(r.index)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
            <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border-2', picked.has(r.index) ? 'border-accent bg-accent text-white' : 'border-ink-3/40')}>
              {picked.has(r.index) && <Check className="size-3.5" strokeWidth={3} />}
            </span>
            <RowBody row={r} />
          </button>
        ))}
      />
      {picked.size > 0 && (
        <div className="sticky bottom-[calc(env(safe-area-inset-bottom)+84px)] z-10 mt-3 space-y-3 rounded-[22px] bg-surface p-4 shadow-float md:bottom-4">
          <label className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-ink-2">
              Keep {accountName}’s balance as it is
              <span className="block text-[12px] text-ink-3">{keepBalance ? 'Its starting balance changes instead' : 'The balance moves by what’s added'}</span>
            </span>
            <Toggle checked={keepBalance} onChange={setKeepBalance} label="Keep the balance as it is" />
          </label>
          <Button size="lg" className="w-full" loading={adding} onClick={onAdd}>
            Add {picked.size.toLocaleString()} to Kosh
          </Button>
        </div>
      )}
    </>
  )
}

function List({ items, empty, hint }: { items: ReactNode[]; empty?: string; hint?: string }) {
  const [shown, setShown] = useState(PAGE)
  if (items.length === 0) return <p className="rounded-[22px] bg-surface px-5 py-6 text-center text-[15px] text-ink-2">{empty}</p>
  return (
    <>
      {hint && <p className="mb-2 px-1 text-[13px] text-ink-3">{hint}</p>}
      <div className="divide-y divide-line overflow-hidden rounded-[22px] bg-surface shadow-card">{items.slice(0, shown)}</div>
      {items.length > shown && (
        <Button variant="secondary" className="mt-3 w-full" onClick={() => setShown(shown + PAGE * 4)}>
          Show more ({(items.length - shown).toLocaleString()} left)
        </Button>
      )}
    </>
  )
}

function Row({ row, status, ok }: { row: StatementRow; status?: string; ok?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <RowBody row={row} status={status} ok={ok} />
    </div>
  )
}

function RowBody({ row, status, ok }: { row: StatementRow; status?: string; ok?: boolean }) {
  return (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium">{row.note || (row.kind === 'income' ? 'Money in' : 'Money out')}</p>
        <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
          {shortDate(row.at.slice(0, 10))}
          {row.label && <span className="rounded-full bg-accent/12 px-1.5 py-px text-[11px] font-semibold text-accent">{LABELS[row.label]}</span>}
          {status && <span className={cn('font-medium', ok ? 'text-pos' : 'text-warn')}>· {status}</span>}
        </p>
      </div>
      <Amount value={row.kind === 'income' ? row.amount : -row.amount} />
    </>
  )
}

function Amount({ value }: { value: number }) {
  return <span className={cn('shrink-0 text-[15px] font-semibold tnum', value > 0 ? 'text-pos' : 'text-ink')}>{money(value, { sign: true })}</span>
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: 'pos' | 'warn' }) {
  return (
    <div className="rounded-[22px] bg-surface p-4 shadow-card">
      <p className="truncate text-[12px] font-medium text-ink-3">{label}</p>
      <p className="mt-0.5 text-[20px] font-bold tracking-tight tnum">{value}</p>
      <p className={cn('truncate text-[12px] font-medium', tone === 'pos' ? 'text-pos' : tone === 'warn' ? 'text-warn' : 'text-ink-3')}>{sub}</p>
    </div>
  )
}

function Note({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="mb-2 flex items-start gap-2 rounded-2xl bg-surface px-4 py-3 text-[13px] text-ink-2">
      <span className="mt-px shrink-0">{icon}</span>
      {children}
    </p>
  )
}

