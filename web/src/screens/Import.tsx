import { useMutation } from '@tanstack/react-query'
import { ChevronDown, FileUp, RotateCcw } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button, Glyph, ScreenHeader, SectionTitle, Toggle, cn } from '../components/ui'
import { api, errorMessage, type ImportPreview, type ImportResult } from '../lib/api'
import { suggestEmoji } from '../lib/emoji'
import { money, shortDate } from '../lib/format'
import { invalidateMoney, useData } from '../lib/queries'
import { navigate } from '../lib/router'

const APPS = 'Dime, Money Manager, Wallet, Spendee, Monefy, Money Lover, your bank’s statement, or Kosh'

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'Asia/Kolkata'
  }
}

/** Bring your history over from another app's CSV export. */
export function ImportScreen() {
  const d = useData()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [accountId, setAccountId] = useState(0)
  const [accountMap, setAccountMap] = useState<Record<string, number>>({})
  const [categoryMap, setCategoryMap] = useState<Record<string, number>>({})
  const [keepBalances, setKeepBalances] = useState(true)
  const [includeSimilar, setIncludeSimilar] = useState(false)

  const accounts = d.accounts.filter((a) => !a.archived)

  const read = useMutation({
    mutationFn: (f: { name: string; csv: string }) => api<ImportPreview>('POST', '/api/import/preview', { csv: f.csv, timezone: timezone() }),
    onSuccess: (p) => {
      setPreview(p)
      setAccountMap(Object.fromEntries(p.accounts.map((a) => [a.name, a.match ?? 0])))
      setCategoryMap(Object.fromEntries(p.categories.map((c) => [c.key, c.match ?? 0])))
      const upi = accounts.find((a) => a.id === d.user.prefs.upiAccountId)
      setAccountId((upi ?? accounts[0])?.id ?? 0)
    },
    onError: (e) => {
      setFile(null)
      toast.error(errorMessage(e))
    },
  })

  const run = useMutation({
    mutationFn: () =>
      api<ImportResult>('POST', '/api/import', {
        csv: file!.csv,
        timezone: timezone(),
        accountId,
        accounts: accountMap,
        categories: Object.fromEntries(
          preview!.categories.map((c) => [c.key, { id: categoryMap[c.key] ?? 0, icon: suggestEmoji(c.name) ?? '🏷️' }]),
        ),
        keepBalances,
        includeSimilar,
      }),
    onSuccess: (r) => {
      invalidateMoney()
      toast.success(r.imported === 1 ? 'Imported 1 transaction' : `Imported ${r.imported.toLocaleString()} transactions`)
      navigate('/activity', { replace: true })
    },
  })

  const pick = async (f: File | undefined) => {
    if (!f) return
    if (f.size > 10 * 1024 * 1024) {
      toast.error('That file is over 10 MB. Export a shorter period and try again.')
      return
    }
    const next = { name: f.name, csv: await f.text() }
    setFile(next)
    setPreview(null)
    setIncludeSimilar(false)
    read.mutate(next)
  }

  const reset = () => {
    setFile(null)
    setPreview(null)
    if (input.current) input.current.value = ''
  }

  const count = preview ? preview.new + (includeSimilar ? preview.similar : 0) : 0
  const spent = preview ? (preview.totals.expense ?? 0) + (preview.totals.lend ?? 0) + (preview.totals.repay ?? 0) : 0
  const earned = preview ? (preview.totals.income ?? 0) + (preview.totals.borrow ?? 0) + (preview.totals.collect ?? 0) : 0
  const newCategories = preview?.categories.filter((c) => !categoryMap[c.key]).length ?? 0

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
      className="hidden"
      onChange={(e) => pick(e.target.files?.[0])}
    />
  )

  if (!preview) {
    return (
      <div>
        <ScreenHeader title="Import" back="/settings" />
        {fileInput}
        <div className="rounded-[24px] bg-surface p-6 text-center shadow-card">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/12 text-accent">
            <FileUp className="size-7" />
          </span>
          <h2 className="mt-4 text-[20px] font-bold tracking-tight">Bring your history</h2>
          <p className="mx-auto mt-1.5 max-w-[320px] text-[14px] text-ink-2">Pick a CSV export from {APPS}. You’ll see what Kosh found before anything is saved.</p>
          <Button size="lg" className="mt-5 w-full" loading={read.isPending} onClick={() => input.current?.click()}>
            {read.isPending ? `Reading ${file?.name ?? ''}` : 'Choose a CSV file'}
          </Button>
        </div>

        <SectionTitle title="Getting the file" />
        <div className="space-y-3 rounded-[22px] bg-surface p-4 text-[14px] text-ink-2 shadow-card">
          <p>In your old app, look for <b className="text-ink">Export</b> or <b className="text-ink">Backup</b> in its settings and choose <b className="text-ink">CSV</b>. Save the file to Files (or Downloads), then choose it here.</p>
          <p>Bank statement? Download it from net banking as CSV or Excel, and save Excel files as CSV first.</p>
          <p>Importing the same file twice is safe: transactions already imported are skipped.</p>
        </div>
      </div>
    )
  }

  return (
    <div>
      <ScreenHeader title="Import" back="/settings" />
      {fileInput}

      <div className="rounded-[24px] bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink-3">{preview.format ? `From ${preview.format}` : file?.name}</p>
            <p className="mt-0.5 text-[28px] font-bold leading-tight tracking-[-0.03em]">
              {preview.count.toLocaleString()} <span className="text-[17px] font-semibold text-ink-2">transactions</span>
            </p>
            <p className="text-[14px] text-ink-2">
              {shortDate(preview.from.slice(0, 10))} – {shortDate(preview.to.slice(0, 10))}
            </p>
          </div>
          <button onClick={reset} className="press flex items-center gap-1 rounded-full bg-surface-2 px-3 py-1.5 text-[13px] font-semibold text-ink-2">
            <RotateCcw className="size-3.5" /> Change
          </button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-surface-2 px-3 py-2.5">
            <p className="text-[12px] text-ink-3">Out</p>
            <p className="text-[16px] font-semibold tabular-nums">{money(spent)}</p>
          </div>
          <div className="rounded-2xl bg-surface-2 px-3 py-2.5">
            <p className="text-[12px] text-ink-3">In</p>
            <p className="text-[16px] font-semibold tabular-nums text-pos">{money(earned)}</p>
          </div>
        </div>
      </div>

      {(preview.needsAccount || preview.accounts.length > 0) && (
        <>
          <SectionTitle title="Accounts" />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {preview.needsAccount && (
              <Row
                left={<Glyph icon={accounts.find((a) => a.id === accountId)?.icon ?? '💵'} color={accounts.find((a) => a.id === accountId)?.color ?? '#22C55E'} size={36} />}
                title={preview.accounts.length ? 'Rows without an account' : 'Put them in'}
                subtitle={preview.format === 'Dime' ? 'Dime doesn’t keep accounts' : undefined}
              >
                <Select value={accountId} onChange={setAccountId} label="Account">
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Row>
            )}
            {preview.accounts.map((a, i) => {
              const target = accounts.find((x) => x.id === accountMap[a.name])
              return (
                <Row key={a.name} border={i > 0 || preview.needsAccount} left={<Glyph icon={target?.icon ?? '🏦'} color={target?.color ?? '#94A3B8'} size={36} />} title={a.name} subtitle={`${a.count.toLocaleString()} transactions`}>
                  <Select value={accountMap[a.name] ?? 0} onChange={(v) => setAccountMap((m) => ({ ...m, [a.name]: v }))} label={`Account for ${a.name}`}>
                    <option value={0}>New account</option>
                    {accounts.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                </Row>
              )
            })}
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
              <div className="min-w-0">
                <p className="text-[15px] font-medium">Keep today’s balances</p>
                <p className="text-[12px] text-ink-3">Old transactions fill in your history without changing what your accounts show now.</p>
              </div>
              <Toggle checked={keepBalances} onChange={setKeepBalances} label="Keep today’s balances" />
            </div>
          </div>
        </>
      )}

      {preview.categories.length > 0 && (
        <>
          <SectionTitle title="Categories" action={newCategories > 0 ? <span className="text-[13px] font-medium text-ink-3">{newCategories} new</span> : undefined} />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {preview.categories.map((c, i) => {
              const target = d.categoriesById.get(categoryMap[c.key])
              return (
                <Row
                  key={c.key}
                  border={i > 0}
                  left={<Glyph icon={target?.icon ?? suggestEmoji(c.name) ?? '🏷️'} color={target?.color ?? '#94A3B8'} size={36} />}
                  title={c.name}
                  subtitle={`${c.kind === 'income' ? 'Income' : 'Expense'} · ${c.count.toLocaleString()}`}
                >
                  <Select value={categoryMap[c.key] ?? 0} onChange={(v) => setCategoryMap((m) => ({ ...m, [c.key]: v }))} label={`Category for ${c.name}`}>
                    <option value={0}>New: {c.name}</option>
                    {d.categories
                      .filter((x) => x.kind === c.kind && !x.archived)
                      .map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.icon} {x.name}
                        </option>
                      ))}
                  </Select>
                </Row>
              )
            })}
          </div>
        </>
      )}

      {preview.newPeople.length > 0 && (
        <p className="mt-3 px-1 text-[13px] text-ink-3">Adds {preview.newPeople.length === 1 ? '1 person' : `${preview.newPeople.length} people`}: {preview.newPeople.slice(0, 6).join(', ')}{preview.newPeople.length > 6 ? '…' : ''}</p>
      )}

      {(preview.similar > 0 || preview.imported > 0 || preview.problemCount > 0) && <SectionTitle title="Skipped" />}
      <div className="space-y-2.5">
        {preview.similar > 0 && (
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[15px] font-medium">{preview.similar === 1 ? '1 is' : `${preview.similar} are`} probably already in Kosh</p>
                <p className="text-[12px] text-ink-3">Same amount within a day of one you have. Import them anyway?</p>
              </div>
              <Toggle checked={includeSimilar} onChange={setIncludeSimilar} label="Import them anyway" />
            </div>
            <Details label="Show them">
              {preview.similarRows.map((r, i) => (
                <div key={i} className="flex justify-between gap-3 py-1 text-[13px]">
                  <span className="min-w-0 truncate text-ink-2">
                    {shortDate(r.at.slice(0, 10))} · {r.note || r.kind}
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{money(r.amount)}</span>
                </div>
              ))}
            </Details>
          </div>
        )}
        {preview.imported > 0 && (
          <div className="rounded-[22px] bg-surface px-4 py-3 shadow-card">
            <p className="text-[15px] font-medium">{preview.imported.toLocaleString()} imported before</p>
            <p className="text-[12px] text-ink-3">They’re already here from an earlier import.</p>
          </div>
        )}
        {preview.problemCount > 0 && (
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            <div className="px-4 py-3">
              <p className="text-[15px] font-medium">{preview.problemCount === 1 ? '1 row' : `${preview.problemCount.toLocaleString()} rows`} couldn’t be read</p>
              <p className="text-[12px] text-ink-3">Everything else imports fine.</p>
            </div>
            <Details label="Show rows">
              {preview.problems.map((p) => (
                <p key={p.line} className="py-0.5 text-[13px] text-ink-2">
                  Line {p.line}: {p.reason}
                </p>
              ))}
            </Details>
          </div>
        )}
      </div>

      <Button size="lg" className="mt-6 w-full" disabled={count === 0 || (preview.needsAccount && !accountId)} loading={run.isPending} onClick={() => run.mutate()}>
        {count === 0 ? 'Nothing new to import' : `Import ${count.toLocaleString()} transaction${count === 1 ? '' : 's'}`}
      </Button>
    </div>
  )
}

function Row({ left, title, subtitle, border, children }: { left: ReactNode; title: string; subtitle?: string; border?: boolean; children: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-3 px-4 py-2.5', border && 'border-t border-line')}>
      {left}
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium tracking-tight">{title}</p>
        {subtitle && <p className="truncate text-[12px] text-ink-3">{subtitle}</p>}
      </div>
      {children}
    </div>
  )
}

function Select({ value, onChange, label, children }: { value: number; onChange: (v: number) => void; label: string; children: ReactNode }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      aria-label={label}
      className="h-9 max-w-[46%] shrink-0 truncate rounded-xl bg-surface-2 px-3 text-[14px] font-semibold outline-none"
    >
      {children}
    </select>
  )
}

function Details({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useMemo(() => Math.random().toString(36).slice(2), [])
  return (
    <div className="border-t border-line">
      <button onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={id} className="press flex w-full items-center justify-between px-4 py-2.5 text-[13px] font-semibold text-accent">
        {open ? 'Hide' : label}
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div id={id} className="max-h-64 overflow-y-auto px-4 pb-3">
          {children}
        </div>
      )}
    </div>
  )
}
