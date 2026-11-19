import { ChevronDown, ChevronRight, Eye, EyeOff, Inbox, ScanLine, Search, Settings as SettingsIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { Amount, BigAmount } from '../components/Money'
import { IconButton } from '../components/ui'
import { monthPeriod, ymd } from '../lib/format'
import { haptic } from '../lib/look'
import { useBudgets, useCaptures, useData, useInsights } from '../lib/queries'
import { clearParam, navigate, useBackToClose, useLocation } from '../lib/router'
import { openScanner, privacy, togglePrivacy } from '../lib/store'
import { Log } from './Activity'

type Period = 'week' | 'month'

function readPeriod(): Period {
  try {
    return localStorage.getItem('kosh:homePeriod') === 'week' ? 'week' : 'month'
  } catch {
    return 'month'
  }
}

function range(period: Period, weekStart: number, monthStart: number) {
  const now = new Date()
  if (period === 'month') return monthPeriod(now, monthStart)
  const back = (now.getDay() - weekStart + 7) % 7
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)
  return { from: ymd(start), to: ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)) }
}

/**
 * Home is your log, like a ledger: what you've spent at the top, every
 * transaction below. Accounts, people and insights have their own tabs.
 */
export function Home() {
  const d = useData()
  const hidden = privacy.use((s) => s.hidden)
  const { search } = useLocation()
  const [period, setPeriod] = useState<Period>(readPeriod)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useBackToClose(searching, () => setSearching(false))

  const monthStart = d.user.prefs.monthStart ?? 1
  const r = range(period, d.user.prefs.weekStart ?? 1, monthStart)
  const totals = useInsights(r.from, r.to).data?.totals
  const overall = useBudgets(monthPeriod(new Date(), monthStart).from).data?.find((b) => b.categoryId === null)
  const toReview = useCaptures().data?.length ?? 0

  // Focus right inside the tap, so iPhone opens the keyboard.
  const openSearch = () => {
    flushSync(() => setSearching(true))
    inputRef.current?.focus()
  }

  // "/" on desktop and old links to /activity?focus=1 open search.
  useEffect(() => {
    if (search.get('focus')) {
      openSearch()
      clearParam('focus')
    }
  }, [search])

  const switchPeriod = () => {
    haptic(6)
    const next = period === 'month' ? 'week' : 'month'
    setPeriod(next)
    try {
      localStorage.setItem('kosh:homePeriod', next)
    } catch {}
  }

  return (
    <div>
      {!searching && (
        <>
          <header className="flex items-center justify-between pt-1">
            <IconButton label="Search" onClick={openSearch}>
              <Search className="size-[21px]" />
            </IconButton>
            <div className="flex items-center">
              <IconButton label={hidden ? 'Show amounts' : 'Hide amounts'} onClick={() => { haptic(); togglePrivacy() }}>
                {hidden ? <EyeOff className="size-[21px]" /> : <Eye className="size-[21px]" />}
              </IconButton>
              <IconButton label="Settings" onClick={() => navigate('/settings')} className="md:hidden">
                <SettingsIcon className="size-[21px]" />
              </IconButton>
            </div>
          </header>

          <section className="flex flex-col items-center pb-8 pt-3 text-center">
            <button onClick={switchPeriod} className="press flex items-center gap-1 rounded-full bg-surface px-3 py-1 text-[13px] font-medium text-ink-2">
              Spent {period === 'month' ? 'this month' : 'this week'}
              <ChevronDown className="size-3.5" />
            </button>
            <div className="mt-3 font-rounded text-[54px] font-medium leading-none tracking-[-0.02em]">
              <BigAmount value={totals?.expense ?? 0} />
            </div>
            <p className="mt-3 flex flex-wrap items-center justify-center gap-x-2 text-[14px] font-medium text-ink-3">
              <span>
                <Amount value={totals?.income ?? 0} className="text-pos" /> in
              </span>
              {overall && period === 'month' && (
                <>
                  <span className="opacity-50">|</span>
                  <button onClick={() => navigate('/budgets')} className={overall.spent > overall.amount ? 'text-neg' : ''}>
                    {overall.spent > overall.amount ? (
                      <>
                        <Amount value={overall.spent - overall.amount} /> over budget
                      </>
                    ) : (
                      <>
                        <Amount value={overall.amount - overall.spent} /> left in budget
                      </>
                    )}
                  </button>
                </>
              )}
            </p>
            <button
              onClick={() => {
                haptic(10)
                openScanner()
              }}
              className="press mt-6 flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-[15px] font-semibold text-white"
            >
              <ScanLine className="size-[18px]" /> Scan & pay
            </button>
          </section>

          {toReview > 0 && (
            <button
              onClick={() => navigate('/review')}
              className="press mb-5 flex w-full items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
                <Inbox className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-semibold tracking-tight">
                  {toReview} {toReview === 1 ? 'payment' : 'payments'} to review
                </span>
                <span className="block text-[12px] text-ink-3">From your bank messages</span>
              </span>
              <ChevronRight className="size-4 text-ink-3" />
            </button>
          )}
        </>
      )}

      <Log searching={searching} inputRef={inputRef} onCloseSearch={() => setSearching(false)} />
    </div>
  )
}
