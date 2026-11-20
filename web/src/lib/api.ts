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
  /** Day of the month a month begins on, like payday (1–28). Default 1. */
  monthStart?: number
  /** Account scan & pay uses by default; 0 or missing means none chosen. */
  upiAccountId?: number
  /** Auto-capture saves a bank message straight away when it knows the payee. Default on. */
  captureAuto?: boolean
  /** The parts of Kosh in use. Missing means money only. */
  modules?: Module[]
  /** Payment apps they use (ids from PAY_APPS), favourite first. */
  payApps?: string[]
}

/** An AI agent connected to Kosh: a key they handed it, or an assistant signed in with OAuth. */
export type AgentConn = {
  id: number
  name: string
  kind: 'key' | 'oauth'
  scope: 'read' | 'write'
  lastUsedAt: string | null
  createdAt: string
}

export type AgentKey = { connection: AgentConn; key: string; link: string; message: string; owner: string }

export type Module = 'finance' | 'vehicles'


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
  /** The vehicle an expense was for. */
  vehicle: VehicleLink | null
}

export type TxInput = Pick<Transaction, 'kind' | 'amount' | 'accountId' | 'toAccountId' | 'categoryId' | 'personId' | 'note' | 'occurredAt'> & {
  source?: 'manual' | 'upi-scan' | 'sms'
  payee?: string
  /** The reviewed bank message this saves (auto-capture). */
  captureId?: number
  /** Left out, an edit keeps the vehicle; null means not for a vehicle. */
  vehicle?: VehicleLink | null
}

// ---- Vehicles ----

export type VehicleKind = 'car' | 'bike' | 'scooter' | 'other'
export type FuelKind = 'petrol' | 'diesel' | 'cng' | 'ev' | 'hybrid'
export type LogKind = 'fuel' | 'service' | 'expense' | 'odometer'
export type DocType = 'rc' | 'insurance' | 'puc' | 'road_tax' | 'fitness' | 'permit' | 'licence' | 'warranty' | 'other'

export type Vehicle = {
  id: number
  kind: VehicleKind
  name: string
  make: string
  model: string
  year: number | null
  regNumber: string // "KA01AB1234"
  fuel: FuelKind
  color: string
  archived: boolean
  sortOrder: number
  /** The highest odometer reading, km. */
  odometer: number | null
  odometerOn: string | null
  createdAt: string
}

export type VehicleLog = {
  id: number
  vehicleId: number
  kind: LogKind
  occurredOn: string // YYYY-MM-DD
  odometer: number | null
  litres: number | null // millilitres
  fullTank: boolean
  title: string
  amount: number
  note: string
  /** The expense in Money it was paid with. */
  transactionId: number | null
  accountId: number | null
}

export type VehicleDoc = {
  id: number
  /** null: yours, like a driving licence. */
  vehicleId: number | null
  type: DocType
  title: string
  number: string
  issuer: string
  issuedOn: string | null
  /** null: doesn't expire. */
  expiresOn: string | null
  amount: number
  note: string
  fileName: string
  fileType: string
  fileSize: number
  /** Changes with every upload; empty without a file. */
  fileId: string
  transactionId: number | null
  accountId: number | null
  createdAt: string
  updatedAt: string
}

/** What an expense in Money says about its vehicle. */
export type VehicleLink = {
  vehicleId: number
  kind: 'fuel' | 'service' | 'expense'
  odometer: number | null
  litres: number | null
  fullTank: boolean
  title: string
}

/** A service schedule, with what's due worked out by the server. */
export type ServiceRule = {
  id: number
  vehicleId: number
  title: string
  everyKm: number | null
  everyMonths: number | null
  lastOn: string | null
  lastKm: number | null
  nextKm: number | null
  /** To go; negative means past it. */
  kmLeft: number | null
  nextOn: string | null
  /** When you'll likely reach nextKm, from how much you drive. */
  guessOn: string | null
  state: 'overdue' | 'soon' | 'ok' | 'unknown'
}

export type Garage = { vehicles: Vehicle[]; logs: VehicleLog[]; documents: VehicleDoc[]; services: ServiceRule[]; storage: boolean }

/** How Kosh would file a captured message, from the last payment to the same payee. */
export type CaptureSuggestion = {
  known: boolean
  kind: TxKind
  categoryId: number | null
  personId: number | null
  note: string
}

/** A bank or UPI message waiting for review. */
export type Capture = {
  id: number
  direction: 'debit' | 'credit'
  amount: number
  accountId: number | null
  bank: string
  last4: string
  payee: string
  merchant: string
  ref: string
  occurredAt: string
  text: string
  suggestion: CaptureSuggestion
}

export type CaptureSetup = {
  enabled: boolean
  token?: string
  timezone?: string
  lastUsedAt: string | null // UTC
  saved: number
  /** The shared Kosh shortcut's iCloud link, when this server has one. */
  shortcutUrl?: string
}

export type CaptureTest =
  | { recognised: false }
  | {
      recognised: true
      sms: { direction: 'debit' | 'credit'; amount: number; last4: string; bank: string; payee: string; merchant: string; ref: string }
      accountId: number | null
      suggestion: CaptureSuggestion
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

/** What Kosh read from a CSV, before importing it. */
export type ImportPreview = {
  /** The app the file came from, when Kosh recognises it ('Dime', 'a bank statement'…). */
  format: string
  count: number
  new: number
  /** Imported from this file before; skipped. */
  imported: number
  /** Look like transactions already in Kosh; skipped unless asked. */
  similar: number
  similarRows: { at: string; kind: TxKind; amount: number; note: string }[]
  from: string
  to: string
  totals: Partial<Record<TxKind, number>>
  categories: { key: string; kind: 'expense' | 'income'; name: string; count: number; match: number | null }[]
  accounts: { name: string; count: number; match: number | null }[]
  /** Some rows name no account, so one has to be picked. */
  needsAccount: boolean
  newPeople: string[]
  problems: { line: number; reason: string }[]
  problemCount: number
}

export type ImportResult = {
  imported: number
  skippedImported: number
  skippedSimilar: number
  createdCategories: number
  createdAccounts: number
  createdPeople: number
}

/** What a bank statement row is, when Kosh recognises it. */
export type StatementLabel = '' | 'interest' | 'interest-paid' | 'tds' | 'charges'

export type StatementRow = {
  index: number
  at: string
  kind: 'income' | 'expense'
  amount: number
  note: string
  balance: number | null
  label: StatementLabel
  /** The Kosh transaction it matched. */
  match: { id: number; at: string; kind: string; categoryId: number | null; note: string } | null
}

/** A statement set against Kosh (POST /api/statements/check). Nothing is changed by it. */
export type StatementCheck = {
  accountId: number
  from: string
  to: string
  count: number
  moneyIn: number
  moneyOut: number
  opening: number | null
  closing: number | null
  /** Rows whose balance doesn't follow from the one before. */
  breaks: number[]
  /** Kosh's balance at the end of the statement's last day. */
  koshClosing: number
  interest: number
  interestPaid: number
  tds: number
  charges: number
  rows: StatementRow[]
  matched: number
  missing: number
  koshOnly: { id: number; at: string; kind: string; in: boolean; amount: number; note: string }[]
  interestCategoryId: number | null
  chargesCategoryId: number | null
  problems: { line: number; reason: string }[]
}

/** Interest earned (income in the Interest category) and given away. */
export type InterestSummary = {
  earned: number
  given: number
  toGive: number
  years: { year: string; earned: number; given: number }[]
  entries: { id: number; at: string; amount: number; note: string; accountId: number; given: boolean }[]
}

/** Another Kosh account that the Google account just connected signs in to. */
export type MergeOffer = { name: string; username: string; googleEmail: string; transactions: number; accounts: number; people: number }

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
