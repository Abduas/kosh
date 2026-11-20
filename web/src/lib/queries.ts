import { QueryClient, useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister'
import { useMemo } from 'react'
import { toast } from 'sonner'
import {
  api,
  ApiError,
  errorMessage,
  type Account,
  type BalancePoint,
  type Bootstrap,
  type Budget,
  type Capture,
  type Category,
  type Garage,
  type Insights,
  type InterestSummary,
  type Person,
  type Prefs,
  type Transaction,
  type TxInput,
  type TxPage,
  type User,
} from './api'
import { ymd } from './format'
import { forgetPapers } from './offline'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      gcTime: 1000 * 60 * 60 * 24 * 7,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: {
      onError: (err) => toast.error(errorMessage(err)),
    },
  },
})

// The last data seen is kept on the device so the app opens instantly, even offline.
export const CACHE_KEY = 'kosh:cache'
export const CACHE_BUSTER = 'v1'
export const persister = createSyncStoragePersister({ storage: window.localStorage, key: CACHE_KEY })
export const dehydrateOptions = {
  shouldDehydrateQuery: (q: { state: { status: string }; queryKey: readonly unknown[] }) => q.state.status === 'success' && q.queryKey[0] !== 'auth',
}

/**
 * Drops everything but the sign-in status. Only call it once the signed-in
 * screens are gone: they read this data and would crash without it.
 */
export function clearSignedInData() {
  forgetPapers()
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'auth' })
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {}
}

export function clearLocalData() {
  forgetPapers()
  queryClient.clear()
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {}
}

// ---- Bootstrap: user, accounts, categories, people ----

export function useBootstrap(enabled = true) {
  return useQuery({ queryKey: ['bootstrap'], queryFn: () => api<Bootstrap>('GET', '/api/bootstrap'), enabled })
}

export type Data = Bootstrap & {
  accountsById: Map<number, Account>
  categoriesById: Map<number, Category>
  peopleById: Map<number, Person>
  activeAccounts: Account[]
  totalBalance: number
  owedToMe: number
  iOwe: number
}

/** Bootstrap data with lookups. Only call below the point where it has loaded. */
export function useData(): Data {
  const { data } = useBootstrap()
  return useMemo(() => {
    const b = data!
    const activeAccounts = b.accounts.filter((a) => !a.archived)
    return {
      ...b,
      accountsById: new Map(b.accounts.map((a) => [a.id, a])),
      categoriesById: new Map(b.categories.map((c) => [c.id, c])),
      peopleById: new Map(b.people.map((p) => [p.id, p])),
      activeAccounts,
      totalBalance: b.accounts.filter((a) => a.includeInTotal).reduce((s, a) => s + a.balance, 0),
      owedToMe: b.people.reduce((s, p) => s + Math.max(0, p.balance), 0),
      iOwe: b.people.reduce((s, p) => s + Math.max(0, -p.balance), 0),
    }
  }, [data])
}

// ---- Transactions ----

export type TxFilters = {
  from?: string
  to?: string
  account?: number
  category?: number
  person?: number
  kind?: string
  q?: string
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') sp.set(k, String(v))
  return sp.toString()
}

export function useTransactions(filters: TxFilters, limit = 60) {
  return useInfiniteQuery({
    queryKey: ['tx', filters, limit],
    queryFn: ({ pageParam }) => api<TxPage>('GET', '/api/transactions?' + qs({ ...filters, cursor: pageParam, limit })),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
}

export function useInsights(from: string, to: string) {
  return useQuery({
    queryKey: ['insights', from, to],
    queryFn: () => api<Insights>('GET', '/api/insights?' + qs({ from, to })),
    placeholderData: (prev) => prev,
  })
}

export function useBalanceHistory(days: number) {
  const today = ymd(new Date())
  return useQuery({
    queryKey: ['balance', days, today],
    queryFn: () => api<BalancePoint[]>('GET', '/api/insights/balance?' + qs({ days, today })),
  })
}

/** Budgets with what's spent in the month beginning on `from` (YYYY-MM-DD, see monthPeriod). */
export function useBudgets(from: string) {
  return useQuery({
    queryKey: ['budgets', from],
    queryFn: () => api<Budget[]>('GET', '/api/budgets?' + qs({ from })),
    placeholderData: (prev) => prev,
  })
}

/** Interest earned and given away, for the Interest screen and the Home card. */
export function useInterest() {
  return useQuery({
    queryKey: ['interest'],
    queryFn: () => api<InterestSummary>('GET', '/api/interest'),
  })
}

/** Money changed: refresh balances, lists and charts. */
export function invalidateMoney() {
  for (const key of ['bootstrap', 'tx', 'insights', 'balance', 'budgets', 'captures', 'garage', 'interest']) {
    queryClient.invalidateQueries({ queryKey: [key] })
  }
}

export function txInput(t: Transaction): TxInput {
  return {
    kind: t.kind,
    amount: t.amount,
    accountId: t.accountId,
    toAccountId: t.toAccountId,
    categoryId: t.categoryId,
    personId: t.personId,
    note: t.note,
    occurredAt: t.occurredAt,
    source: t.source === 'upi-scan' || t.source === 'sms' ? t.source : 'manual',
    payee: t.payee,
    vehicle: t.vehicle,
  }
}

export function useSaveTx() {
  return useMutation({
    mutationFn: ({ id, input }: { id?: number; input: TxInput }) =>
      id ? api<Transaction>('PATCH', `/api/transactions/${id}`, input) : api<Transaction>('POST', '/api/transactions', input),
    onSuccess: invalidateMoney,
  })
}

/** Saves one transaction, or several at once (a split bill) so they're all saved or none. */
export function saveTransactions(items: TxInput[]): Promise<unknown> {
  return items.length === 1 ? api('POST', '/api/transactions', items[0]) : api('POST', '/api/transactions/batch', { items })
}

export function useSaveTxs() {
  return useMutation({ mutationFn: saveTransactions, onSuccess: invalidateMoney })
}

/** Deletes a transaction, with an Undo button in the toast. */
export function useDeleteTx() {
  return useMutation({
    mutationFn: (t: Transaction) => api('DELETE', `/api/transactions/${t.id}`),
    onSuccess: (_, t) => {
      invalidateMoney()
      toast('Transaction deleted', {
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: () => api('POST', '/api/transactions', txInput(t)).then(invalidateMoney, (e) => toast.error(errorMessage(e))),
        },
      })
    },
  })
}

// ---- Accounts, categories, people ----

type Entity = 'accounts' | 'categories' | 'people'

export function useSaveEntity<T>(entity: Entity) {
  return useMutation({
    mutationFn: ({ id, body }: { id?: number; body: Record<string, unknown> }) =>
      id ? api<T>('PATCH', `/api/${entity}/${id}`, body) : api<T>('POST', `/api/${entity}`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bootstrap'] })
      queryClient.invalidateQueries({ queryKey: ['balance'] })
    },
  })
}

export function useDeleteEntity(entity: Entity) {
  return useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/${entity}/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bootstrap'] }),
  })
}

export function useUpdateMe() {
  return useMutation({
    mutationFn: (body: { name?: string; prefs?: Prefs; currentPassword?: string; newPassword?: string }) =>
      api<User>('PATCH', '/api/me', body),
    onSuccess: async (user) => {
      // A refresh started before this change would overwrite it with old settings.
      await queryClient.cancelQueries({ queryKey: ['bootstrap'] })
      queryClient.setQueryData<Bootstrap>(['bootstrap'], (b) => (b ? { ...b, user } : b))
    },
  })
}

export function useSetBudget() {
  return useMutation({
    mutationFn: (body: { categoryId: number | null; amount: number }) => api('PUT', '/api/budgets', body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['budgets'] }),
  })
}

export function useDeleteBudget() {
  return useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/budgets/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['budgets'] }),
  })
}

// ---- Auto-capture: bank messages waiting for review ----

export function useCaptures() {
  return useQuery({
    queryKey: ['captures'],
    queryFn: () => api<{ items: Capture[] }>('GET', '/api/captures'),
    select: (r) => r.items,
    refetchOnWindowFocus: 'always',
  })
}

export function useDismissCapture() {
  return useMutation({
    mutationFn: (c: Capture) => api('POST', `/api/captures/${c.id}/dismiss`),
    onMutate: (c) => {
      queryClient.setQueryData<{ items: Capture[] }>(['captures'], (r) => r && { items: r.items.filter((x) => x.id !== c.id) })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['captures'] }),
  })
}

// ---- Vehicles ----

export function useGarage(enabled = true) {
  return useQuery({ queryKey: ['garage'], queryFn: () => api<Garage>('GET', '/api/vehicles'), enabled })
}

/** A vehicle cost can also be an expense in Money, so refresh both. */
export function invalidateGarage() {
  invalidateMoney()
}

type GarageEntity = 'vehicles' | 'vehicle-logs' | 'vehicle-documents' | 'service-rules'

export function useSaveGarage<T>(entity: GarageEntity) {
  return useMutation({
    mutationFn: ({ id, body }: { id?: number; body: Record<string, unknown> }) =>
      id ? api<T>('PATCH', `/api/${entity}/${id}`, body) : api<T>('POST', `/api/${entity}`, body),
    onSuccess: invalidateGarage,
  })
}

export function useDeleteGarage(entity: GarageEntity) {
  return useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/${entity}/${id}`),
    onSuccess: invalidateGarage,
  })
}

/** Uploads a document's photo or PDF, replacing the one it had. */
export async function uploadDocFile(id: number, file: File) {
  const form = new FormData()
  form.append('file', file, file.name)
  let res: Response
  try {
    res = await fetch(`/api/vehicle-documents/${id}/file`, { method: 'PUT', body: form, credentials: 'same-origin' })
  } catch {
    throw new ApiError(0, "You're offline. The document is saved; add the file again later.")
  }
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = (await res.json()).error ?? msg
    } catch {}
    throw new ApiError(res.status, msg)
  }
  queryClient.invalidateQueries({ queryKey: ['garage'] })
}
