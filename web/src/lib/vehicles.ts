import { addMonths, differenceInCalendarDays, format, isThisYear, parseISO } from 'date-fns'
import type { DocType, FuelKind, Garage, LogKind, Module, Prefs, Vehicle, VehicleDoc, VehicleKind, VehicleLog } from './api'
import { ymd } from './format'

// ---- Modules: which parts of Kosh someone uses ----

export function modulesOf(prefs: Prefs | undefined): Module[] {
  return prefs?.modules?.length ? prefs.modules : ['finance']
}

export const hasFinance = (prefs: Prefs | undefined) => modulesOf(prefs).includes('finance')
export const hasVehicles = (prefs: Prefs | undefined) => modulesOf(prefs).includes('vehicles')

// ---- Vehicles ----

export const vehicleKinds: Record<VehicleKind, { label: string; icon: string }> = {
  car: { label: 'Car', icon: '🚗' },
  bike: { label: 'Bike', icon: '🏍️' },
  scooter: { label: 'Scooter', icon: '🛵' },
  other: { label: 'Other', icon: '🚙' },
}

export const fuelKinds: Record<FuelKind, string> = { petrol: 'Petrol', diesel: 'Diesel', cng: 'CNG', ev: 'Electric', hybrid: 'Hybrid' }

/** "KA01AB1234" → "KA 01 AB 1234"; Bharat series "22BH1234AB" → "22 BH 1234 AB". */
export function formatReg(reg: string): string {
  const bh = reg.match(/^(\d{2})(BH)(\d{4})([A-Z]{1,2})$/)
  if (bh) return bh.slice(1).join(' ')
  const m = reg.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/)
  return m ? m.slice(1).filter(Boolean).join(' ') : reg
}

export function vehicleSubtitle(v: Vehicle): string {
  return [v.regNumber && formatReg(v.regNumber), [v.make, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
}

export const km = (n: number) => `${n.toLocaleString('en-IN')} km`
export const litres = (ml: number) => `${(ml / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L`

// ---- Logs ----

export const logKinds: Record<LogKind, { label: string; icon: string; color: string }> = {
  fuel: { label: 'Fuel', icon: '⛽', color: '#EF4444' },
  service: { label: 'Service', icon: '🔧', color: '#3B82F6' },
  expense: { label: 'Other cost', icon: '🧾', color: '#F59E0B' },
  odometer: { label: 'Odometer', icon: '📍', color: '#64748B' },
}

export const serviceTitles = ['General service', 'Oil change', 'Tyres', 'Battery', 'Brakes', 'Chain & sprocket', 'Repair', 'Wash']
export const expenseTitles = ['Parking', 'Toll', 'FASTag recharge', 'Wash', 'Accessories', 'Repair', 'Fine', 'EMI']

export function logTitle(l: Pick<VehicleLog, 'kind' | 'title' | 'litres'>): string {
  if (l.title) return l.title
  if (l.kind === 'fuel' && l.litres) return `Fuel · ${litres(l.litres)}`
  return logKinds[l.kind].label
}

/**
 * Fuel economy by the full-tank method: between two full-tank fills, the km
 * driven over the litres put in after the first. Returns km per litre for
 * the latest stretch and the average, or null without two full fills.
 */
export function mileage(logs: VehicleLog[]): { latest: number; average: number } | null {
  const fills = logs.filter((l) => l.kind === 'fuel' && l.odometer != null && l.litres).sort((a, b) => a.odometer! - b.odometer! || a.occurredOn.localeCompare(b.occurredOn))
  const stretches: { km: number; ml: number }[] = []
  let start: VehicleLog | null = null
  let ml = 0
  for (const f of fills) {
    if (start) ml += f.litres!
    if (f.fullTank) {
      if (start && f.odometer! > start.odometer! && ml > 0) stretches.push({ km: f.odometer! - start.odometer!, ml })
      start = f
      ml = 0
    }
  }
  if (!stretches.length) return null
  const per = (s: { km: number; ml: number }) => s.km / (s.ml / 1000)
  const total = stretches.reduce((a, s) => ({ km: a.km + s.km, ml: a.ml + s.ml }), { km: 0, ml: 0 })
  return { latest: per(stretches[stretches.length - 1]), average: per(total) }
}

/** Average km a day from the odometer readings, once they span two weeks. */
export function kmPerDay(logs: VehicleLog[]): number | null {
  const r = logs.filter((l) => l.odometer != null).sort((a, b) => a.occurredOn.localeCompare(b.occurredOn))
  if (r.length < 2) return null
  const days = differenceInCalendarDays(parseISO(r[r.length - 1].occurredOn), parseISO(r[0].occurredOn))
  const dist = r[r.length - 1].odometer! - r[0].odometer!
  return days >= 14 && dist > 0 ? dist / days : null
}

// ---- Papers ----

export const docTypes: Record<DocType, { label: string; short: string; icon: string; months: number | null }> = {
  insurance: { label: 'Insurance', short: 'Insurance', icon: '🛡️', months: 12 },
  puc: { label: 'Pollution (PUC)', short: 'PUC', icon: '💨', months: 6 },
  road_tax: { label: 'Road tax', short: 'Tax', icon: '🧾', months: null },
  rc: { label: 'Registration (RC)', short: 'RC', icon: '📘', months: 180 },
  fitness: { label: 'Fitness certificate', short: 'Fitness', icon: '✅', months: 24 },
  permit: { label: 'Permit', short: 'Permit', icon: '📜', months: 12 },
  licence: { label: 'Driving licence', short: 'Licence', icon: '🪪', months: null },
  warranty: { label: 'Warranty', short: 'Warranty', icon: '🔰', months: 24 },
  other: { label: 'Other paper', short: 'Paper', icon: '📄', months: null },
}

/** The papers every vehicle should have, in the order they're shown. */
export const keyDocs: DocType[] = ['insurance', 'puc', 'road_tax', 'rc']

export function docLabel(d: Pick<VehicleDoc, 'type' | 'title'>): string {
  return d.title || docTypes[d.type].label
}

/** The usual validity from an issue date (or today), for a starting guess. */
export function defaultExpiry(type: DocType, from?: string | null): string | null {
  const months = docTypes[type].months
  if (!months) return null
  const start = from ? parseISO(from) : new Date()
  return ymd(new Date(addMonths(start, months).getTime() - 86_400_000))
}

export type DueState = 'expired' | 'soon' | 'ok' | 'lifetime'

/** Within this many days, a renewal is due soon. */
export const SOON_DAYS = 30

export function docStatus(d: Pick<VehicleDoc, 'expiresOn'>, today = new Date()): { state: DueState; days: number } {
  if (!d.expiresOn) return { state: 'lifetime', days: Infinity }
  const days = differenceInCalendarDays(parseISO(d.expiresOn), today)
  return { state: days < 0 ? 'expired' : days <= SOON_DAYS ? 'soon' : 'ok', days }
}

export function dueText(d: Pick<VehicleDoc, 'expiresOn'>, today = new Date()): string {
  const { state, days } = docStatus(d, today)
  if (state === 'lifetime') return "Doesn't expire"
  if (days === 0) return 'Expires today'
  if (days === 1) return 'Expires tomorrow'
  if (days < 0) return days === -1 ? 'Expired yesterday' : `Expired ${-days} days ago`
  if (days <= 60) return `In ${days} days`
  return `Till ${shortDay(d.expiresOn!)}`
}

export function shortDay(date: string): string {
  const d = parseISO(date)
  return format(d, isThisYear(d) ? 'd MMM' : 'd MMM yyyy')
}

export const stateTone: Record<DueState, string> = {
  expired: 'text-neg',
  soon: 'text-warn',
  ok: 'text-ink-3',
  lifetime: 'text-ink-3',
}

const docKey = (d: VehicleDoc) => `${d.vehicleId ?? 0}:${d.type}:${d.type === 'other' || d.type === 'warranty' ? d.id : ''}`

/**
 * The paper in force for each vehicle and type: the one that runs latest.
 * A renewal is a new document, so the older ones are its history.
 */
export function currentDocs(docs: VehicleDoc[]): VehicleDoc[] {
  const best = new Map<string, VehicleDoc>()
  for (const d of docs) {
    const k = docKey(d)
    const cur = best.get(k)
    const rank = (x: VehicleDoc) => x.expiresOn ?? '9999-12-31'
    if (!cur || rank(d) > rank(cur) || (rank(d) === rank(cur) && d.id > cur.id)) best.set(k, d)
  }
  return [...best.values()]
}

export function isCurrent(d: VehicleDoc, docs: VehicleDoc[]): boolean {
  return currentDocs(docs.filter((x) => docKey(x) === docKey(d)))[0]?.id === d.id
}

/** Current papers that expire, soonest first, skipping archived vehicles. */
export function dueList(g: Garage, today = new Date()): (VehicleDoc & { status: ReturnType<typeof docStatus> })[] {
  const archived = new Set(g.vehicles.filter((v) => v.archived).map((v) => v.id))
  return currentDocs(g.documents)
    .filter((d) => d.expiresOn && !(d.vehicleId && archived.has(d.vehicleId)))
    .map((d) => ({ ...d, status: docStatus(d, today) }))
    .sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!))
}

/** What needs doing within `days`: expired or expiring papers. */
export function needsAttention(g: Garage | undefined, days = SOON_DAYS) {
  if (!g) return []
  return dueList(g).filter((d) => d.status.days <= days)
}

// ---- Which part of the app a screen belongs to ----

export type Space = 'finance' | 'vehicles'

const vehiclePaths = ['/garage', '/due', '/logs', '/papers']

export function spaceOfPath(path: string): Space | null {
  if (vehiclePaths.some((p) => path === p || path.startsWith(p + '/'))) return 'vehicles'
  if (path.startsWith('/settings') || path === '/members') return null
  return 'finance'
}

export function lastSpace(): Space {
  try {
    return localStorage.getItem('kosh:space') === 'vehicles' ? 'vehicles' : 'finance'
  } catch {
    return 'finance'
  }
}

export function rememberSpace(s: Space) {
  try {
    localStorage.setItem('kosh:space', s)
  } catch {}
}

export function lastVehicleId(): number | null {
  try {
    return Number(localStorage.getItem('kosh:lastVehicle')) || null
  } catch {
    return null
  }
}

export function rememberVehicle(id: number) {
  try {
    localStorage.setItem('kosh:lastVehicle', String(id))
  } catch {}
}
