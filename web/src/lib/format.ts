import { format, isToday, isYesterday, isThisYear, parseISO, differenceInCalendarDays } from 'date-fns'

let currency = 'INR'

export function setCurrency(c: string | undefined) {
  if (c && c !== currency) {
    currency = c
    cache.clear()
  }
}
export function getCurrency() {
  return currency
}

const cache = new Map<string, Intl.NumberFormat>()
function nf(decimals: 0 | 2, compact = false): Intl.NumberFormat {
  const key = `${currency}:${decimals}:${compact}`
  let f = cache.get(key)
  if (!f) {
    const locale = currency === 'INR' ? 'en-IN' : undefined
    f = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: compact ? 0 : decimals,
      maximumFractionDigits: compact ? 1 : decimals,
      notation: compact ? 'compact' : 'standard',
    })
    cache.set(key, f)
  }
  return f
}

/** Formats minor units as money: 12345050 → ₹1,23,450.50. Whole amounts drop the decimals. */
export function money(minor: number, opts: { sign?: boolean; compact?: boolean; abs?: boolean } = {}): string {
  const v = opts.abs ? Math.abs(minor) : minor
  const decimals = v % 100 === 0 ? 0 : 2
  const s = nf(decimals, opts.compact && Math.abs(v) >= 100_000_00).format(Math.abs(v) / 100)
  if (v < 0) return '−' + s
  if (opts.sign && v > 0) return '+' + s
  return s
}

export function currencySymbol(): string {
  const parts = nf(0).formatToParts(0)
  return parts.find((p) => p.type === 'currency')?.value ?? currency
}

/** Splits money into whole and fraction parts for big-number display. */
export function moneyParts(minor: number): { symbol: string; whole: string; fraction: string; negative: boolean } {
  const abs = Math.abs(minor)
  const parts = nf(2).formatToParts(abs / 100)
  let whole = ''
  let fraction = ''
  let symbol = ''
  let inFraction = false
  for (const p of parts) {
    if (p.type === 'currency') symbol = p.value
    else if (p.type === 'decimal') inFraction = true
    else if (p.type === 'fraction') fraction = p.value
    else if (p.type === 'integer' || p.type === 'group') {
      if (!inFraction) whole += p.value
    }
  }
  return { symbol, whole, fraction, negative: minor < 0 }
}

/** Parses user text like "1,250.5" into minor units. */
export function parseMoney(text: string): number | null {
  const clean = text.replace(/[,\s₹$€£]/g, '')
  if (!clean) return null
  const n = Number(clean)
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

// ---- Dates (all local, as 'YYYY-MM-DD' strings) ----

export const pad = (n: number) => String(n).padStart(2, '0')

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localNow(): string {
  const d = new Date()
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dayLabel(date: string): string {
  const d = parseISO(date)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  if (Math.abs(differenceInCalendarDays(new Date(), d)) < 7) return format(d, 'EEEE')
  return format(d, isThisYear(d) ? 'EEE, d MMM' : 'EEE, d MMM yyyy')
}

export function shortDate(date: string): string {
  const d = parseISO(date)
  if (isToday(d)) return 'Today'
  if (isYesterday(d)) return 'Yesterday'
  return format(d, isThisYear(d) ? 'd MMM' : 'd MMM yyyy')
}

export function timeLabel(occurredAt: string): string {
  return format(parseISO(occurredAt), 'h:mm a')
}

export function relativeDays(date: string): string {
  if (!date) return ''
  const days = differenceInCalendarDays(new Date(), parseISO(date))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.round(days / 30)} mo ago`
  return `${Math.round(days / 365)} yr ago`
}

export function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Good night'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function percent(part: number, whole: number): number {
  if (!whole) return 0
  return Math.round((part / whole) * 100)
}
