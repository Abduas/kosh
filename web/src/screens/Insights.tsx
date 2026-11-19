import { addDays, addMonths, addYears, differenceInCalendarDays, endOfWeek, format, startOfWeek } from 'date-fns'
import { ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, ChartPie, HandCoins, Target } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Bars, Donut } from '../components/Charts'
import { Amount, BigAmount } from '../components/Money'
import { TxRow } from '../components/TxList'
import { Card, EmptyState, Glyph, ScreenHeader, SectionTitle, Segmented, TextLink, cn } from '../components/ui'
import { money, monthPeriod, percent, ymd } from '../lib/format'
import { useData, useInsights } from '../lib/queries'
import { navigate } from '../lib/router'

type Period = 'week' | 'month' | 'year'

function range(period: Period, anchor: Date, weekStart: 0 | 1, monthStart: number) {
  if (period === 'week') {
    const s = startOfWeek(anchor, { weekStartsOn: weekStart })
    const e = endOfWeek(anchor, { weekStartsOn: weekStart })
    return { from: s, to: e, label: `${format(s, 'd MMM')} – ${format(e, 'd MMM')}` }
  }
  if (period === 'month') {
    const m = monthPeriod(anchor, monthStart)
    return { from: m.start, to: m.end, label: m.label }
  }
  return { from: new Date(anchor.getFullYear(), 0, 1), to: new Date(anchor.getFullYear(), 11, 31), label: format(anchor, 'yyyy') }
}

function shift(period: Period, d: Date, n: number) {
  return period === 'week' ? addDays(d, 7 * n) : period === 'month' ? addMonths(d, n) : addYears(d, n)
}

export function Insights() {
  const d = useData()
  const [period, setPeriod] = useState<Period>('month')
  const [anchor, setAnchor] = useState(new Date())
  const [side, setSide] = useState<'expense' | 'income'>('expense')
  const [bar, setBar] = useState<number | null>(null)
  const [slice, setSlice] = useState<string | number | null>(null)

  const r = range(period, anchor, d.user.prefs.weekStart ?? 1, d.user.prefs.monthStart ?? 1)
  const from = ymd(r.from)
  const to = ymd(r.to)
  const atPresent = r.to >= new Date(new Date().setHours(0, 0, 0, 0))
  const q = useInsights(from, to)
  const data = q.data

  const total = data?.totals[side] ?? 0
  const prev = data?.prev[side] ?? 0
  const delta = prev > 0 ? Math.round(((total - prev) / prev) * 100) : null
  const today = ymd(new Date())
  // Only days that have happened count towards averages.
  const elapsedDays = data ? (atPresent ? differenceInCalendarDays(new Date(), r.from) + 1 : data.days) : 1
  const perDay = Math.round(total / Math.max(1, elapsedDays) / 100) * 100 // whole rupees

  const bars = useMemo(
    () =>
      (data?.series ?? []).map((p) => {
        const date = new Date(p.key.length === 7 ? p.key + '-01T00:00' : p.key + 'T00:00')
        const label = data!.bucket === 'month' ? format(date, 'MMM').slice(0, 1) : period === 'week' ? format(date, 'EEEEE') : format(date, 'd')
        return { key: p.key, label, value: p[side] }
      }),
    [data, side, period],
  )
  const pastBars = bars.filter((b) => b.key <= today.slice(0, b.key.length))
  const avg = pastBars.length ? pastBars.reduce((sum, b) => sum + b.value, 0) / pastBars.length : 0

  const cats = useMemo(() => {
    const list = (data?.categories ?? []).filter((c) => c.kind === side)
    return list.map((c) => {
      const cat = c.categoryId ? d.categoriesById.get(c.categoryId) : undefined
      return { id: c.categoryId ?? 0, name: cat?.name ?? 'Uncategorized', icon: cat?.icon ?? '🧾', color: cat?.color ?? '#94A3B8', total: c.total, count: c.count }
    })
  }, [data, side, d.categoriesById])
  // Slivers under 3% merge into one "Other" slice so the ring stays readable.
  const slices = useMemo(() => {
    const big = cats.filter((c) => c.total / Math.max(1, total) >= 0.03)
    const rest = cats.filter((c) => c.total / Math.max(1, total) < 0.03).reduce((sum, c) => sum + c.total, 0)
    const out = big.map((c) => ({ id: c.id as string | number, value: c.total, color: c.color }))
    if (rest > 0) out.push({ id: 'other', value: rest, color: '#94A3B8' })
    return out
  }, [cats, total])
  const focused = cats.find((c) => c.id === slice)

  const selectedBar = bar != null ? bars[bar] : null
  const income = data?.totals.income ?? 0
  const expense = data?.totals.expense ?? 0
  const saved = income - expense
  const lendingActive = data && (data.totals.lend || data.totals.borrow || data.totals.collect || data.totals.repay)

  const change = (n: number) => {
    setAnchor((a) => shift(period, period === 'month' ? r.from : a, n))
    setBar(null)
    setSlice(null)
  }

  return (
    <div>
      <ScreenHeader title="Insights" actions={<TextLink onClick={() => navigate('/budgets')}>Budgets</TextLink>} />

      <Segmented
        id="period"
        value={period}
        onChange={(p) => {
          setPeriod(p)
          setAnchor(new Date())
          setBar(null)
          setSlice(null)
        }}
        options={[
          { value: 'week', label: 'Week' },
          { value: 'month', label: 'Month' },
          { value: 'year', label: 'Year' },
        ]}
      />

      <div className="mt-3 flex items-center justify-between">
        <button onClick={() => change(-1)} aria-label="Previous" className="press grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface">
          <ChevronLeft className="size-5" />
        </button>
        <p className="text-[15px] font-semibold">{r.label}</p>
        <button onClick={() => change(1)} disabled={atPresent} aria-label="Next" className={cn('press grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface', atPresent && 'opacity-30')}>
          <ChevronRight className="size-5" />
        </button>
      </div>

      {/* Total and trend */}
      <Card className="mt-3 p-5">
        <div className="flex items-start justify-between">
          <div>
            <Segmented
              id="side"
              size="sm"
              className="w-[180px]"
              value={side}
              onChange={(s) => {
                setSide(s)
                setSlice(null)
              }}
              options={[
                { value: 'expense', label: 'Spent' },
                { value: 'income', label: 'Earned' },
              ]}
            />
            <div className="mt-4 text-[38px] font-bold leading-none tracking-[-0.04em]">
              <BigAmount value={selectedBar ? selectedBar.value : total} />
            </div>
            <p className="mt-2 text-[13px] font-medium text-ink-3">
              {selectedBar
                ? format(new Date(selectedBar.key.length === 7 ? selectedBar.key + '-01T00:00' : selectedBar.key + 'T00:00'), data?.bucket === 'month' ? 'MMMM yyyy' : 'EEEE, d MMMM')
                : <>About <Amount value={perDay} className="font-semibold text-ink-2" /> a day</>}
            </p>
          </div>
          {delta !== null && !selectedBar && (
            <span
              className={cn(
                'flex items-center gap-0.5 rounded-full px-2.5 py-1 text-[12px] font-bold',
                (side === 'expense' ? delta > 0 : delta < 0) ? 'bg-neg/10 text-neg' : 'bg-pos/10 text-pos',
              )}
              title={`Compared with ${money(prev)} in the previous ${period}`}
            >
              {delta >= 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}
              {Math.abs(delta)}%
            </span>
          )}
        </div>
        <div className="mt-6">
          <Bars
            bars={bars}
            selected={bar}
            onSelect={setBar}
            color={side === 'expense' ? 'var(--accent)' : 'var(--pos)'}
            labelEvery={bars.length > 20 ? 5 : 1}
            highlightKey={today}
            average={avg}
          />
        </div>
      </Card>

      {/* Categories */}
      <SectionTitle title={side === 'expense' ? 'Where it went' : 'Where it came from'} />
      <Card className="p-5">
        {cats.length === 0 ? (
          <EmptyState icon={<ChartPie className="size-7" />} title="No data yet" body={`Nothing ${side === 'expense' ? 'spent' : 'earned'} in this period.`} className="py-6" />
        ) : (
          <>
            <Donut slices={slices} selected={slice} onSelect={(id) => setSlice(id === 'other' ? null : id)}>
              <div>
                <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{focused ? focused.name : 'Total'}</p>
                <Amount value={focused ? focused.total : total} compact className="text-[24px] font-bold tracking-tight" />
                {focused && <p className="text-[12px] font-semibold text-ink-3">{percent(focused.total, total)}%</p>}
              </div>
            </Donut>
            <div className="mt-6 space-y-1">
              {cats.map((c) => (
                <button
                  key={c.id}
                  onClick={() => (slice === c.id ? navigate(`/activity?category=${c.id}&from=${from}&to=${to}`) : setSlice(c.id))}
                  className={cn('press flex w-full items-center gap-3 rounded-2xl p-2 text-left transition-colors', slice === c.id ? 'bg-surface-2' : 'hover:bg-surface-2/60')}
                >
                  <Glyph icon={c.icon} color={c.color} size={38} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-[15px] font-medium">{c.name}</span>
                      <Amount value={c.total} className="text-[15px] font-semibold" />
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3">
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${percent(c.total, total)}%`, background: c.color }} />
                      </div>
                      <span className="w-14 text-right text-[11px] font-semibold text-ink-3">
                        {percent(c.total, total)}% · {c.count}
                      </span>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* Cash flow */}
      <SectionTitle title="Cash flow" />
      <Card className="p-5">
        <div className="space-y-3">
          {[
            { label: 'Earned', value: income, color: 'var(--pos)' },
            { label: 'Spent', value: expense, color: 'var(--neg)' },
          ].map((row) => (
            <div key={row.label}>
              <div className="mb-1.5 flex justify-between text-[14px]">
                <span className="font-medium text-ink-2">{row.label}</span>
                <Amount value={row.value} className="font-semibold" />
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full transition-all duration-700" style={{ width: `${percent(row.value, Math.max(income, expense))}%`, background: row.color }} />
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-between border-t border-line pt-4">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{saved >= 0 ? 'Saved' : 'Overspent'}</p>
            <Amount value={Math.abs(saved)} className={cn('text-[22px] font-bold tracking-tight', saved >= 0 ? 'text-pos' : 'text-neg')} />
          </div>
          {income > 0 && (
            <div className="text-right">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">Savings rate</p>
              <p className={cn('text-[22px] font-bold tracking-tight', saved >= 0 ? 'text-ink' : 'text-neg')}>{percent(saved, income)}%</p>
            </div>
          )}
        </div>
      </Card>

      {/* Lending */}
      {lendingActive ? (
        <>
          <SectionTitle title="Lending" action={<TextLink onClick={() => navigate('/people')}>People</TextLink>} />
          <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line p-0">
            {[
              { label: 'Lent', v: data!.totals.lend, c: 'text-lend' },
              { label: 'Got back', v: data!.totals.collect, c: 'text-pos' },
              { label: 'Borrowed', v: data!.totals.borrow, c: 'text-ink' },
              { label: 'Paid back', v: data!.totals.repay, c: 'text-ink' },
            ].map((x) => (
              <div key={x.label} className="bg-surface p-4">
                <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-3">
                  <HandCoins className="size-3.5" /> {x.label}
                </p>
                <Amount value={x.v} className={cn('text-[19px] font-bold tracking-tight', x.c)} />
              </div>
            ))}
          </Card>
        </>
      ) : null}

      {/* Largest */}
      {data && data.largest.length > 0 && side === 'expense' && (
        <>
          <SectionTitle title="Biggest expenses" />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {data.largest.map((t, i) => (
              <div key={t.id}>
                {i > 0 && <div className="ml-[70px] h-px bg-line" />}
                <TxRow t={t} showDate />
              </div>
            ))}
          </div>
        </>
      )}

      <Card onClick={() => navigate('/budgets')} className="mt-6 flex items-center gap-4 p-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent/12 text-accent">
          <Target className="size-5" />
        </span>
        <div className="flex-1">
          <p className="text-[15px] font-semibold">Budgets</p>
          <p className="text-[13px] text-ink-2">Set limits and see what's safe to spend.</p>
        </div>
        <ChevronRight className="size-5 text-ink-3" />
      </Card>
    </div>
  )
}
