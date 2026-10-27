import type { TxInput } from './api'

// Reading UPI QR codes and handing the payment to a UPI app.
//
// A UPI QR holds a link like upi://pay?pa=shop@okaxis&pn=Shop&am=120.00&mc=5411.
// Kosh reads who it's for, opens a payment app with the same details, and
// asks when you come back whether it went through. No UPI app tells a web
// page the result, so that question is how the payment gets recorded.

export type UpiTarget = {
  /** The text the QR held, exactly. */
  raw: string
  /** The query string to hand to a UPI app, in the QR's own order and encoding. */
  query: string
  vpa: string
  /** Payee name from the QR, tidied up. */
  name: string
  /** Fixed amount in paise when the QR sets one; it can't be changed then. */
  amount: number | null
  note: string
  /** Merchant category code (mc), when the QR is a shop's. */
  mcc: string
  merchant: boolean
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

/** "MOHAMMED  ABDUL" -> "Mohammed Abdul" (names in QRs are often all caps). */
export function tidyName(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  if (clean !== clean.toUpperCase()) return clean
  return clean.toLowerCase().replace(/(^|[\s.&(-])(\p{L})/gu, (_, sep, c) => sep + c.toUpperCase())
}

function toPaise(s: string | undefined): number | null {
  if (!s) return null
  const n = Number(s.trim())
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100)
}

/** Reads a scanned QR. Returns null when it isn't a UPI payment QR. */
export function parseUpi(text: string): UpiTarget | null {
  const raw = text.trim()
  if (/^000201/.test(raw)) return parseBharatQR(raw)
  const m = raw.match(/^upi:\/\/pay\/?\?(.*)$/is)
  if (!m) return null
  const query = m[1]
  const params = new Map<string, string>()
  for (const part of query.split('&')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const key = part.slice(0, i).toLowerCase()
    if (!params.has(key)) params.set(key, safeDecode(part.slice(i + 1)))
  }
  const vpa = (params.get('pa') ?? '').trim()
  if (!/^[\w.-]+@[\w.-]+$/.test(vpa)) return null
  const mcc = (params.get('mc') ?? '').trim()
  return {
    raw,
    query,
    vpa,
    name: tidyName(params.get('pn') ?? '') || vpa,
    amount: toPaise(params.get('am')),
    note: (params.get('tn') ?? '').trim(),
    mcc,
    merchant: /^\d{4}$/.test(mcc) && mcc !== '0000',
  }
}

/** Bharat QR (EMVCo) codes from bank card machines carry a UPI ID inside. */
function parseBharatQR(raw: string): UpiTarget | null {
  const tlv = (s: string) => {
    const out = new Map<string, string>()
    let i = 0
    while (i + 4 <= s.length) {
      const tag = s.slice(i, i + 2)
      const len = Number(s.slice(i + 2, i + 4))
      if (!Number.isInteger(len)) break
      out.set(tag, s.slice(i + 4, i + 4 + len))
      i += 4 + len
    }
    return out
  }
  const top = tlv(raw)
  let vpa = ''
  for (let t = 26; t <= 51 && !vpa; t++) {
    const inner = top.get(String(t))
    if (!inner) continue
    for (const v of tlv(inner).values()) {
      if (/^[\w.-]+@[\w.-]+$/.test(v)) {
        vpa = v
        break
      }
    }
  }
  if (!vpa) return null
  const name = top.get('59') ?? ''
  const mcc = top.get('52') ?? ''
  const am = top.get('54')
  const q = new URLSearchParams({ pa: vpa, pn: name, cu: 'INR' })
  if (mcc) q.set('mc', mcc)
  if (am) q.set('am', am)
  return {
    raw,
    query: q.toString().replace(/\+/g, '%20'),
    vpa,
    name: tidyName(name) || vpa,
    amount: toPaise(am),
    note: '',
    mcc,
    merchant: /^\d{4}$/.test(mcc) && mcc !== '0000',
  }
}

// ---- Opening a UPI app ----

export type Platform = 'ios' | 'android' | 'other'

export const platform: Platform = (() => {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'other'
})()

export type UpiApp = { id: string; name: string; short: string; prefix: string; color: string }

/** iOS has no "pick an app" for upi:// links, so each app is opened by its own scheme. */
export const upiApps: UpiApp[] = [
  { id: 'gpay', name: 'Google Pay', short: 'GPay', prefix: 'tez://upi/pay', color: '#4285F4' },
  { id: 'phonepe', name: 'PhonePe', short: 'PhonePe', prefix: 'phonepe://pay', color: '#5F259F' },
  { id: 'paytm', name: 'Paytm', short: 'Paytm', prefix: 'paytmmp://upi/pay', color: '#00BAF2' },
  { id: 'bhim', name: 'BHIM', short: 'BHIM', prefix: 'bhim://upi/pay', color: '#F47920' },
  { id: 'cred', name: 'CRED', short: 'CRED', prefix: 'credpay://upi/pay', color: '#111111' },
  { id: 'super', name: 'super.money', short: 'super.money', prefix: 'super://pay', color: '#4F2CF5' },
]

/** On Android, upi://pay shows the system's list of UPI apps. */
export const ANDROID_CHOOSER: UpiApp = { id: 'any', name: 'UPI app', short: 'UPI app', prefix: 'upi://pay', color: '#097939' }

export function preferredApp(): UpiApp {
  if (platform !== 'ios') return ANDROID_CHOOSER
  let id = ''
  try {
    id = localStorage.getItem('kosh:upiApp') ?? ''
  } catch {}
  return upiApps.find((a) => a.id === id) ?? upiApps[0]
}

export function rememberApp(app: UpiApp) {
  try {
    localStorage.setItem('kosh:upiApp', app.id)
  } catch {}
}

/**
 * The link that opens a UPI app with this payment filled in. The QR's own
 * parameters go through untouched (shop QRs can be signed); an amount is
 * added only when the QR leaves it open.
 */
export function payLink(target: UpiTarget, amount: number, app: UpiApp): string {
  let query = target.query
  const has = (k: string) => new RegExp(`(^|&)${k}=`, 'i').test(query)
  if (target.amount == null && amount > 0) {
    query = query.replace(/(^|&)am=[^&]*/i, '')
    query += `${query ? '&' : ''}am=${(amount / 100).toFixed(2)}`
  }
  if (!has('cu')) query += '&cu=INR'
  return `${app.prefix}?${query.replace(/^&/, '')}`
}

/** Per-device setting: open the scanner whenever Kosh opens. */
export function launchScanEnabled(): boolean {
  try {
    return localStorage.getItem('kosh:launchScan') === '1'
  } catch {
    return false
  }
}

export function setLaunchScan(on: boolean) {
  try {
    localStorage.setItem('kosh:launchScan', on ? '1' : '0')
  } catch {}
}

// ---- A payment waiting for "did it go through?" ----

export type PendingPayment = {
  /** What to save: one transaction, or several for a split bill. */
  items: TxInput[]
  /** The amount handed to the UPI app. */
  total: number
  payee: string
  payeeName: string
  /** People sharing the bill, for the confirmation. */
  splitWith: string[]
  link: string
  appName: string
  startedAt: number
  /** Set once the page goes to the background, meaning the UPI app opened. */
  left: boolean
}

const PENDING_KEY = 'kosh:pendingPayment'

export function readPending(): PendingPayment | null {
  try {
    const p = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as (PendingPayment & { input?: TxInput & { payee: string } }) | null
    // After an hour it's stale; whatever happened, the person has moved on.
    if (!p || Date.now() - p.startedAt > 60 * 60 * 1000) return null
    // Saved by the first version, which held a single transaction.
    if (p.input && !p.items) return { ...p, items: [p.input], total: p.input.amount, payee: p.input.payee, splitWith: [] }
    return p
  } catch {}
  return null
}

export function writePending(p: PendingPayment | null) {
  try {
    if (p) localStorage.setItem(PENDING_KEY, JSON.stringify(p))
    else localStorage.removeItem(PENDING_KEY)
  } catch {}
  window.dispatchEvent(new Event('kosh:pending-payment'))
}

// ---- Guessing a category for a shop from its merchant code ----

const mccNames: [RegExp, string][] = [
  [/^(5411|5422|5441|5451|5462|5499)$/, 'Groceries'],
  [/^(5811|5812|5813|5814)$/, 'Food & Dining'],
  [/^(5541|5542|5983|5172)$/, 'Fuel'],
  [/^(4111|4112|4121|4131|4784|4789|7512|7523)$/, 'Transport'],
  [/^(4812|4814|4816|4899)$/, 'Recharge'],
  [/^(4900|4813)$/, 'Bills & Utilities'],
  [/^(5122|5912|5975|5976|8011|8021|8031|8041|8042|8043|8049|8050|8062|8071|8099)$/, 'Health'],
  [/^(7832|7841|7922|7929|7932|7933|7941|7991|7992|7994|7996|7997|7999)$/, 'Entertainment'],
  [/^(5815|5816|5817|5818|5968)$/, 'Subscriptions'],
  [/^(3\d{3}|4411|4511|4722|7011|7012)$/, 'Travel'],
  [/^(8211|8220|8241|8244|8249|8299|5942|5943)$/, 'Education'],
  [/^(5977|7230|7297|7298)$/, 'Personal Care'],
  [/^(6513)$/, 'Rent'],
  [/^(5\d{3})$/, 'Shopping'],
]

export function categoryNameForMcc(mcc: string): string | null {
  for (const [re, name] of mccNames) if (re.test(mcc)) return name
  return null
}

/** True when every word of a person's name appears in the QR's payee name. */
export function nameMatches(personName: string, payeeName: string): boolean {
  const words = (s: string) => s.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 2)
  const want = words(personName)
  const have = new Set(words(payeeName))
  return want.length > 0 && want.some((w) => w.length >= 3) && want.every((w) => have.has(w))
}
