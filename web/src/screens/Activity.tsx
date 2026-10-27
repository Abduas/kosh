import { addMonths, format } from 'date-fns'
import { ChevronLeft, ChevronRight, ListOrdered, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Amount } from '../components/Money'
import { TxList } from '../components/TxList'
import { Chip, EmptyState, ScreenHeader, Skeleton, cn } from '../components/ui'
import { ymd } from '../lib/format'
import { useData, useInsights, useTransactions, type TxFilters } from '../lib/queries'
import { clearParam, navigate, useLocation } from '../lib/router'

const kindFilters = [
  { id: 'all', label: 'All', kinds: '' },
  { id: 'expense', label: 'Expenses', kinds: 'expense' },
  { id: 'income', label: 'Income', kinds: 'income' },
  { id: 'transfer', label: 'Transfers', kinds: 'transfer' },
  { id: 'people', label: 'Lending', kinds: 'lend,borrow,collect,repay' },
]

export function Activity() {
  const d = useData()
  const { search } = useLocation()
  const [cursorMonth, setCursorMonth] = useState(() => {
    const m = search.get('month')
    return m ? new Date(m + '-01T00:00') : new Date()
  })
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const categoryId = Number(search.get('category')) || undefined
  const accountFilter = Number(search.get('account')) || undefined

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    if (search.get('focus')) {
      inputRef.current?.focus()
      clearParam('focus')
    }
  }, [search])

  const from = ymd(new Date(cursorMonth.getFullYear(), cursorMonth.getMonth(), 1))
  const to = ymd(new Date(cursorMonth.getFullYear(), cursorMonth.getMonth() + 1, 0))
  const searching = debounced.length > 0
  const isCurrentMonth = format(cursorMonth, 'yyyy-MM') === format(new Date(), 'yyyy-MM')

  const filters: TxFilters = useMemo(
    () => ({
      ...(searching ? {} : { from, to }),
      kind: kindFilters.find((k) => k.id === kind)?.kinds || undefined,
      q: debounced || undefined,
      category: categoryId,
      account: accountFilter,
    }),
    [searching, from, to, kind, debounced, categoryId, accountFilter],
  )
  const tx = useTransactions(filters)
  const insights = useInsights(from, to)
  const items = useMemo(() => tx.data?.pages.flatMap((p) => p.items) ?? [], [tx.data])

  const category = categoryId ? d.categoriesById.get(categoryId) : undefined
  const account = accountFilter ? d.accountsById.get(accountFilter) : undefined

  return (
    <div>
      <ScreenHeader title="Activity" />

      <div className="sticky top-0 z-20 -mx-4 bg-bg/85 px-4 pb-3 pt-[max(env(safe-area-inset-top),8px)] backdrop-blur-xl md:-mx-8 md:px-8">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes, people, amounts…"
            className="h-11 w-full rounded-2xl bg-surface pl-11 pr-10 text-[15px] shadow-card outline-none placeholder:text-ink-3 focus:ring-4 focus:ring-accent/10"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-surface-3 text-ink-2">
              <X className="size-4" />
            </button>
          )}
        </div>
        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 md:-mx-8 md:px-8">
          {(category || account) && (
            <Chip active onClick={() => navigate('/activity', { replace: true })}>
              {category ? `${category.icon} ${category.name}` : `${account!.icon} ${account!.name}`}
              <X className="size-3.5" />
            </Chip>
          )}
          {kindFilters.map((k) => (
            <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)}>
              {k.label}
            </Chip>
          ))}
        </div>
      </div>

      {!searching && (
        <div className="mb-4 mt-1 flex items-center justify-between rounded-[22px] bg-surface p-2 shadow-card">
          <button onClick={() => setCursorMonth((m) => addMonths(m, -1))} aria-label="Previous month" className="press grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-2">
            <ChevronLeft className="size-5" />
          </button>
          <div className="text-center">
            <p className="text-[15px] font-semibold">{format(cursorMonth, 'MMMM yyyy')}</p>
            <p className="text-[12px] font-medium text-ink-3">
              <span className="text-pos">
                In <Amount value={insights.data?.totals.income ?? 0} />
              </span>
              <span className="mx-1.5">·</span>
              <span>
                Out <Amount value={insights.data?.totals.expense ?? 0} />
              </span>
            </p>
          </div>
          <button
            onClick={() => setCursorMonth((m) => addMonths(m, 1))}
            disabled={isCurrentMonth}
            aria-label="Next month"
            className={cn('press grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface-2', isCurrentMonth && 'opacity-30')}
          >
            <ChevronRight className="size-5" />
          </button>
        </div>
      )}
      {searching && (
        <p className="mb-3 mt-1 px-1 text-[13px] font-medium text-ink-3">
          {tx.isFetching && items.length === 0 ? 'Searching…' : `${items.length}${tx.hasNextPage ? '+' : ''} results across all time`}
        </p>
      )}

      {tx.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-[22px]" />
          ))}
        </div>
      ) : (
        <TxList
          items={items}
          accountId={accountFilter}
          stickyHeaders={false}
          hasMore={tx.hasNextPage}
          loadingMore={tx.isFetchingNextPage}
          onLoadMore={() => tx.fetchNextPage()}
          empty={
            <EmptyState
              icon={searching ? <Search className="size-7" /> : <ListOrdered className="size-7" />}
              title={searching ? 'No matches' : 'Nothing here yet'}
              body={searching ? 'Try a different word or an exact amount like 450.' : 'Transactions for this month will show up here.'}
            />
          }
        />
      )}
    </div>
  )
}
