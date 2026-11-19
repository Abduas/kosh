import { parseISO } from 'date-fns'
import { ListOrdered, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState, type RefObject } from 'react'
import { TxList } from '../components/TxList'
import { Chip, EmptyState, Skeleton } from '../components/ui'
import { rangeLabel, ymd } from '../lib/format'
import { useData, useTransactions, type TxFilters } from '../lib/queries'
import { navigate, useLocation } from '../lib/router'
import { openComposer } from '../lib/store'

const kindFilters = [
  { id: 'all', label: 'All', kinds: '' },
  { id: 'expense', label: 'Expenses', kinds: 'expense' },
  { id: 'income', label: 'Income', kinds: 'income' },
  { id: 'transfer', label: 'Transfers', kinds: 'transfer' },
  { id: 'people', label: 'Lending', kinds: 'lend,borrow,collect,repay' },
]

/**
 * Every transaction, newest first, grouped by day: the main list on Home.
 * Search and type filters show when searching. Links from Insights can narrow
 * it to a category, an account or a date range (?category=, ?account=,
 * ?from=&to=, or ?month=YYYY-MM from older links).
 */
export function Log({ searching, inputRef, onCloseSearch }: { searching: boolean; inputRef: RefObject<HTMLInputElement | null>; onCloseSearch: () => void }) {
  const d = useData()
  const { search } = useLocation()
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  const categoryId = Number(search.get('category')) || undefined
  const accountFilter = Number(search.get('account')) || undefined
  const month = search.get('month') ?? undefined
  const fromParam = search.get('from') ?? undefined
  const toParam = search.get('to') ?? undefined

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(t)
  }, [query])

  // Closing search clears it.
  useEffect(() => {
    if (!searching) {
      setQuery('')
      setDebounced('')
      setKind('all')
    }
  }, [searching])

  const dateRange = useMemo(() => {
    if (fromParam && toParam) return { from: fromParam, to: toParam, label: rangeLabel(parseISO(fromParam), parseISO(toParam)) }
    if (!month) return undefined
    const start = new Date(month + '-01T00:00')
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0)
    return { from: ymd(start), to: ymd(end), label: rangeLabel(start, end) }
  }, [month, fromParam, toParam])

  const filters: TxFilters = useMemo(
    () => ({
      ...(debounced || !dateRange ? {} : { from: dateRange.from, to: dateRange.to }),
      kind: kindFilters.find((k) => k.id === kind)?.kinds || undefined,
      q: debounced || undefined,
      category: categoryId,
      account: accountFilter,
    }),
    [dateRange, kind, debounced, categoryId, accountFilter],
  )
  const tx = useTransactions(filters)
  const items = useMemo(() => tx.data?.pages.flatMap((p) => p.items) ?? [], [tx.data])

  const category = categoryId ? d.categoriesById.get(categoryId) : undefined
  const account = accountFilter ? d.accountsById.get(accountFilter) : undefined
  const narrowed = !!(category || account || dateRange)

  return (
    <div>
      {searching && (
        <div className="sticky top-0 z-20 -mx-4 bg-bg/90 px-4 pb-3 pt-[max(env(safe-area-inset-top),8px)] backdrop-blur-xl md:-mx-8 md:px-8">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-ink-3" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Notes, people, amounts…"
                enterKeyHint="search"
                className="h-11 w-full rounded-xl bg-surface pl-10 pr-9 text-[16px] outline-none placeholder:text-ink-3"
              />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-surface-3 text-ink-2">
                  <X className="size-4" />
                </button>
              )}
            </div>
            <button onClick={onCloseSearch} className="press h-11 shrink-0 px-1 text-[16px] font-medium text-accent">
              Cancel
            </button>
          </div>
          <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 md:-mx-8 md:px-8">
            {kindFilters.map((k) => (
              <Chip key={k.id} active={kind === k.id} onClick={() => setKind(k.id)}>
                {k.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {narrowed && (
        <div className="no-scrollbar mb-3 flex gap-2 overflow-x-auto">
          <Chip active onClick={() => navigate('/', { replace: true })}>
            {[category && `${category.icon} ${category.name}`, account && `${account.icon} ${account.name}`, dateRange?.label].filter(Boolean).join(' · ')}
            <X className="size-3.5" />
          </Chip>
        </div>
      )}

      {debounced && (
        <p className="mb-2 px-1 text-[13px] font-medium text-ink-3">
          {tx.isFetching && items.length === 0 ? 'Searching…' : `${items.length}${tx.hasNextPage ? '+' : ''} results across all time`}
        </p>
      )}

      {tx.isLoading ? (
        <div className="space-y-3 pt-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-12 rounded-2xl" />
          ))}
        </div>
      ) : (
        <TxList
          items={items}
          accountId={accountFilter}
          stickyHeaders={!searching}
          hasMore={tx.hasNextPage}
          loadingMore={tx.isFetchingNextPage}
          onLoadMore={() => tx.fetchNextPage()}
          empty={
            debounced || narrowed || kind !== 'all' ? (
              <EmptyState icon={<Search className="size-7" />} title="No matches" body="Try a different word or an exact amount like 450." />
            ) : (
              <EmptyState
                icon={<ListOrdered className="size-7" />}
                title="Nothing here yet"
                body="Tap + to add what you spent, or scan a UPI QR to pay and record it in one go."
                action={
                  <button onClick={() => openComposer()} className="press h-11 rounded-full bg-accent px-5 text-[15px] font-semibold text-white">
                    Add an expense
                  </button>
                }
              />
            )
          }
        />
      )}
    </div>
  )
}
