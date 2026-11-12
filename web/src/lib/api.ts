// Typed client for the Go API. Amounts are integers in minor units (paise).

export type TxKind = 'expense' | 'income' | 'transfer' | 'lend' | 'borrow' | 'collect' | 'repay'
export type AccountKind = 'bank' | 'cash' | 'wallet' | 'card' | 'savings' | 'investment'

export type Prefs = {
  currency?: string
  theme?: 'system' | 'light' | 'dark'
  accent?: string
  upiId?: string
  hideAmounts?: boolean
  onboarded?: boolean
  weekStart?: 0 | 1
  /** Account scan & pay uses by default; 0 or missing means none chosen. */
  upiAccountId?: number
}

export type User = {
  id: number
  name: string
  username: string
  prefs: Prefs
  /** The first account: invites and removes other people. */
  isOwner: boolean
  /** False for someone who signed up with Google and hasn't set one. */
  hasPassword: boolean
  /** The connected Google account, or null. */
  googleEmail: string | null
}

export type AuthStatus = { needsSetup: boolean; signedIn: boolean; google: boolean }

export type Member = { id: number; name: string; username: string; isOwner: boolean; googleEmail: string | null; createdAt: string }

export type Account = {
  id: number
  name: string
  kind: AccountKind
  institution: string
  last4: string
  color: string
  icon: string
  openingBalance: number
  balance: number
  includeInTotal: boolean
  archived: boolean
  sortOrder: number
  txCount: number
}

export type Category = {
  id: number
  kind: 'expense' | 'income'
  name: string
  icon: string
  color: string
  archived: boolean
  sortOrder: number
  useCount: number
}

export type Person = {
  id: number
  name: string
  phone: string
  note: string
  color: string
  archived: boolean
  balance: number // positive: they owe you
  lastActivity: string
  txCount: number
}

export type Transaction = {
  id: number
  kind: TxKind
  amount: number
  accountId: number
  toAccountId: number | null
  categoryId: number | null
  personId: number | null
  note: string
  occurredAt: string // local 'YYYY-MM-DDTHH:MM'
  source: string
  ref: string
  payee: string // UPI ID for payments made from Kosh's scanner
  createdAt: string
  updatedAt: string
}

export type TxInput = Pick<Transaction, 'kind' | 'amount' | 'accountId' | 'toAccountId' | 'categoryId' | 'personId' | 'note' | 'occurredAt'> & {
  source?: 'manual' | 'upi-scan'
  payee?: string
}

/** What Kosh remembers about a UPI ID from the last payment to it. */
export type PayeeMemory = {
  known: boolean
  kind?: TxKind
  accountId?: number
  categoryId?: number | null
  personId?: number | null
  note?: string
  count: number
  lastAmount?: number
  lastAt?: string
  lastSavedAt?: string // UTC, when the last payment was saved
}

export type Bootstrap = { user: User; accounts: Account[]; categories: Category[]; people: Person[] }

export type TxPage = { items: Transaction[]; nextCursor: string | null }

export type CategoryTotal = { kind: 'expense' | 'income'; categoryId: number | null; total: number; count: number }
export type SeriesPoint = { key: string; expense: number; income: number }

export type Insights = {
  from: string
  to: string
  days: number
  prevFrom: string
  prevTo: string
  totals: Record<TxKind, number>
  counts: Partial<Record<TxKind, number>>
  prev: { expense: number; income: number }
  categories: CategoryTotal[]
  bucket: 'day' | 'month'
  series: SeriesPoint[]
  largest: Transaction[]
}

export type BalancePoint = { date: string; balance: number }
export type Budget = { id: number; categoryId: number | null; amount: number; spent: number }

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, "You're offline. Check your connection and try again.")
  }
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event('kosh:signed-out'))
  }
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = (await res.json()).error ?? msg
    } catch {}
    throw new ApiError(res.status, msg)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong'
}
