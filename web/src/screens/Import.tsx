import { useMutation } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, FileUp, RotateCcw, ShieldCheck } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button, Glyph, ScreenHeader, SectionTitle, Toggle, cn } from '../components/ui'
import { api, errorMessage, type ImportPreview, type ImportResult } from '../lib/api'
import { suggestEmoji } from '../lib/emoji'
import { money, shortDate } from '../lib/format'
import { invalidateMoney, useData } from '../lib/queries'
import { IMPORT_ACCEPT, IMPORT_APPS, OTHER_SOURCES, findImportApp, type ImportApp } from '../lib/importapps'
import { readImportFile } from '../lib/importfile'
import { navigate, useLocation } from '../lib/router'

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'Asia/Kolkata'
  }
}

/** Bring your history over from another app: pick the app, follow its steps, choose the file. */
export function ImportScreen() {
  const d = useData()
  const { search } = useLocation()
  const app = findImportApp(search.get('from'))
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

  const [opening, setOpening] = useState(false)
  const pick = async (f: File | undefined) => {
    if (!f) return
    setOpening(true)
    setFile({ name: f.name, csv: '' })
    try {
      const next = { name: f.name, csv: await readImportFile(f) }
      setFile(next)
      setPreview(null)
      setIncludeSimilar(false)
      read.mutate(next)
    } catch (e) {
      setFile(null)
      toast.error(e instanceof Error ? e.message : 'Couldn’t open that file.')
    } finally {
      setOpening(false)
      if (input.current) input.current.value = ''
    }
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
      accept={IMPORT_ACCEPT}
      className="hidden"
      onChange={(e) => pick(e.target.files?.[0])}
    />
  )

  if (!preview && !app) return <ImportPicker />

  if (!preview && app) {
    const busy = opening || read.isPending
    return (
      <div>
        <ScreenHeader title={`From ${app.name}`} back="/settings/import" />
        {fileInput}
        <div className="rounded-[24px] bg-surface p-5 shadow-card">
          <div className="flex items-center gap-3">
            <AppMark app={app} size={48} />
            <div className="min-w-0">
              <p className="text-[18px] font-bold tracking-tight">Get your file</p>
              <p className="text-[13px] text-ink-3">Takes a minute in {app.id === 'bank' || app.id === 'other' ? 'the app' : app.name}</p>
            </div>
          </div>
          <ol className="mt-4 space-y-3">
            {app.steps.map((step, i) => (
              <li key={i} className="flex gap-3 text-[15px] leading-snug">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/12 text-[13px] font-bold text-accent">{i + 1}</span>
                <span className="pt-0.5">{step}</span>
              </li>
            ))}
          </ol>
          {app.note && <p className="mt-4 rounded-2xl bg-surface-2 px-3.5 py-2.5 text-[13px] text-ink-2">{app.note}</p>}
          <Button size="lg" className="mt-5 w-full" loading={busy} onClick={() => input.current?.click()}>
            <FileUp className="size-5" /> {busy ? `Reading ${file?.name ?? 'the file'}` : 'Choose the file'}
          </Button>
          <p className="mt-3 text-center text-[12px] text-ink-3">CSV, Excel or zip. If a menu has moved, look for Export or Backup in the app’s settings.</p>
        </div>

        <div className="mt-3 flex items-start gap-3 rounded-[22px] bg-surface px-4 py-3 text-[13px] text-ink-2 shadow-card">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-pos" />
          <p>You’ll see everything Kosh found before anything is saved. Importing the same file twice is safe: what’s already here is skipped.</p>
        </div>
      </div>
    )
  }
  if (!preview) return null

  return (
    <div>
      <ScreenHeader title="Import" back="/settings" />
      {fileInput}

      <div className="rounded-[24px] bg-surface p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-ink-3">{preview.format ? `From ${preview.format}` : app && app.id !== 'other' && app.id !== 'bank' ? `From ${app.name}` : file?.name}</p>
            <p className="mt-0.5 text-[28px] font-bold leading-tight tracking-[-0.03em]">
              {preview.count.toLocaleString()} <span className="text-[17px] font-semibold text-ink-2">{preview.count === 1 ? 'transaction' : 'transactions'}</span>
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
                <Row key={a.name} border={i > 0 || preview.needsAccount} left={<Glyph icon={target?.icon ?? '🏦'} color={target?.color ?? '#94A3B8'} size={36} />} title={a.name} subtitle={a.count ? `${a.count.toLocaleString()} transaction${a.count === 1 ? '' : 's'}` : 'Opening balance'}>
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

/** Which app you're coming from. */
function ImportPicker() {
  const open = (a: ImportApp) => navigate(`/settings/import?from=${a.id}`)
  return (
    <div>
      <ScreenHeader title="Import" subtitle="Bring your history from the app you used before." back="/settings" />
      <div className="grid grid-cols-3 gap-2">
        {IMPORT_APPS.map((a) => (
          <button key={a.id} onClick={() => open(a)} className="press flex flex-col items-center gap-1.5 rounded-2xl bg-surface px-1 pb-2.5 pt-3 text-center shadow-card">
            <AppMark app={a} size={40} />
            <span className="text-[13px] font-semibold leading-tight">{a.name}</span>
            <span className="line-clamp-1 text-[11px] text-ink-3">{a.where}</span>
          </button>
        ))}
      </div>
      <SectionTitle title="Or" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        {OTHER_SOURCES.map((a, i) => (
          <button key={a.id} onClick={() => open(a)} className={cn('press flex w-full items-center gap-3 px-4 py-3 text-left', i > 0 && 'border-t border-line')}>
            <AppMark app={a} size={36} />
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium">{a.name}</span>
              <span className="block text-[12px] text-ink-3">{a.where}</span>
            </span>
            <ChevronRight className="size-5 text-ink-3" />
          </button>
        ))}
      </div>
      <p className="mt-4 px-1 text-[13px] text-ink-3">Nothing is saved until you’ve seen what Kosh found. Your old app isn’t changed.</p>
    </div>
  )
}

export function AppMark({ app, size }: { app: ImportApp; size: number }) {
  const emoji = /\p{Extended_Pictographic}/u.test(app.letter)
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-bold text-white"
      style={{ width: size, height: size, background: emoji ? `${app.color}22` : app.color, fontSize: size * (emoji ? 0.5 : 0.42) }}
      aria-hidden
    >
      {app.letter}
    </span>
  )
}
