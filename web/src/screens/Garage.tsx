import { parseISO, format } from 'date-fns'
import { motion } from 'motion/react'
import { CalendarCheck, Car, ChevronDown, ChevronRight, FileText, Fuel, Gauge, History, Pencil, Plus, Settings as SettingsIcon, TriangleAlert, Wrench } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { BigAmount } from '../components/Money'
import { Sheet } from '../components/Sheet'
import { VehicleGlyph } from '../components/VehicleForms'
import { RemindersPrompt } from '../components/Reminders'
import { Button, Card, Chip, EmptyState, Glyph, IconButton, ListRow, ScreenHeader, SectionTitle, Skeleton, cn } from '../components/ui'
import type { Garage as GarageData, ServiceRule, Vehicle, VehicleDoc, VehicleLog } from '../lib/api'
import { dayLabel, money, monthPeriod, ymd } from '../lib/format'
import { haptic } from '../lib/look'
import { useData, useGarage, useInsights, useSaveGarage } from '../lib/queries'
import { linkHandler, navigate } from '../lib/router'
import { openGarageSheet, showPaper } from '../lib/store'
import {
  currentDocs,
  docLabel,
  docStatus,
  docTypes,
  dueList,
  dueText,
  hasFinance,
  hasVehicles,
  isCurrent,
  keyDocs,
  km,
  kmPerDay,
  logKinds,
  logTitle,
  mileage,
  needsAttention,
  rememberSpace,
  ruleDue,
  ruleEvery,
  ruleTone,
  shortDay,
  suggestedRules,
  stateTone,
  vehicleSubtitle,
  type Space,
} from '../lib/vehicles'

// ---- Switching between Money and Vehicles ----

/** The title on each space's first screen; with both in use, it switches between them. */
export function SpaceSwitch({ space }: { space: Space }) {
  const d = useData()
  const [open, setOpen] = useState(false)
  const both = hasFinance(d.user.prefs) && hasVehicles(d.user.prefs)
  const label = space === 'vehicles' ? 'Vehicles' : 'Money'
  if (!both) return space === 'vehicles' ? <span className="text-[17px] font-semibold tracking-tight">{label}</span> : null
  return (
    <>
      <button onClick={() => { haptic(6); setOpen(true) }} className="press flex items-center gap-1 rounded-full px-3 py-1.5 text-[17px] font-semibold tracking-tight">
        {label} <ChevronDown className="size-4 text-ink-3" strokeWidth={2.6} />
      </button>
      <Sheet open={open} onOpenChange={setOpen} title="Switch to">
        {open && <SpaceChoices current={space} onDone={() => setOpen(false)} />}
      </Sheet>
    </>
  )
}

function SpaceChoices({ current, onDone }: { current: Space; onDone: () => void }) {
  const d = useData()
  const month = monthPeriod(new Date(), d.user.prefs.monthStart ?? 1)
  const spent = useInsights(month.from, month.to).data?.totals.expense
  const g = useGarage().data
  const due = needsAttention(g).length
  const go = (s: Space) => {
    haptic(10)
    rememberSpace(s)
    onDone()
    if (s !== current) setTimeout(() => navigate(s === 'vehicles' ? '/garage' : '/', { replace: true }), 60)
  }
  const row = (s: Space, icon: string, color: string, title: string, sub: string) => (
    <button onClick={() => go(s)} className={cn('press flex w-full items-center gap-3 rounded-[20px] p-3 text-left', current === s ? 'bg-ink text-bg' : 'bg-surface-2')}>
      <Glyph icon={icon} color={color} size={46} />
      <span className="min-w-0 flex-1">
        <span className="block text-[17px] font-semibold tracking-tight">{title}</span>
        <span className={cn('block text-[13px]', current === s ? 'opacity-70' : 'text-ink-3')}>{sub}</span>
      </span>
    </button>
  )
  const vehicles = g?.vehicles.filter((v) => !v.archived).length ?? 0
  return (
    <div className="space-y-2">
      {row('finance', '💰', '#7C5CFF', 'Money', spent != null ? `${money(spent)} spent this month` : 'Accounts, spending, people')}
      {row('vehicles', '🚗', '#0EA5E9', 'Vehicles', due ? `${due} ${due === 1 ? 'paper needs' : 'papers need'} attention` : vehicles ? `${vehicles} in your garage` : 'Papers, fuel, service')}
    </div>
  )
}

// ---- Garage: every vehicle ----

function useGarageData() {
  const q = useGarage()
  return q
}

function vehicleSpend(logs: VehicleLog[], from: string) {
  return logs.filter((l) => l.occurredOn >= from).reduce((s, l) => s + l.amount, 0)
}

export function Garage() {
  const d = useData()
  const q = useGarageData()
  const g = q.data
  const month = monthPeriod(new Date(), d.user.prefs.monthStart ?? 1)
  const active = g?.vehicles.filter((v) => !v.archived) ?? []
  const archived = g?.vehicles.filter((v) => v.archived) ?? []
  const attention = needsAttention(g)
  const [showArchived, setShowArchived] = useState(false)

  return (
    <div>
      <header className="flex items-center justify-between pt-1">
        <span className="size-10" />
        <SpaceSwitch space="vehicles" />
        <IconButton label="Settings" onClick={() => navigate('/settings')} className="md:invisible">
          <SettingsIcon className="size-[21px]" />
        </IconButton>
      </header>

      <section className="flex flex-col items-center pb-7 pt-3 text-center">
        <p className="rounded-full bg-surface px-3 py-1 text-[13px] font-medium text-ink-2">Spent on vehicles this month</p>
        <div className="mt-3 font-rounded text-[54px] font-medium leading-none tracking-[-0.02em]">
          {g ? <BigAmount value={vehicleSpend(g.logs, month.from)} /> : <Skeleton className="mx-auto h-12 w-40" />}
        </div>
        {g && g.logs.length > 0 && (
          <p className="mt-3 text-[14px] font-medium text-ink-3">{money(vehicleSpend(g.logs, `${new Date().getFullYear()}-01-01`))} this year</p>
        )}
      </section>

      {attention.length > 0 && <AttentionRow items={attention} vehicles={g!.vehicles} />}

      {!g && q.isLoading && <Skeleton className="h-40 w-full rounded-[22px]" />}
      {g && active.length === 0 && (
        <Card>
          <EmptyState
            icon={<Car className="size-7" />}
            title="Your garage is empty"
            body="Add your car or bike. Kosh keeps its papers, fuel and service, and tells you before anything expires."
            action={<Button onClick={() => openGarageSheet({ kind: 'vehicle' })}>Add a vehicle</Button>}
          />
        </Card>
      )}

      {active.length > 0 && (
        <div className="space-y-2.5">
          {active.map((v) => (
            <VehicleCard key={v.id} v={v} g={g!} />
          ))}
          <button onClick={() => openGarageSheet({ kind: 'vehicle' })} className="press flex w-full items-center justify-center gap-1.5 rounded-[20px] py-3 text-[14px] font-semibold text-accent">
            <Plus className="size-4" strokeWidth={2.6} /> Add a vehicle
          </button>
        </div>
      )}

      {archived.length > 0 && (
        <>
          <SectionTitle title={`Archived · ${archived.length}`} action={<button onClick={() => setShowArchived(!showArchived)} className="text-[13px] font-semibold text-accent">{showArchived ? 'Hide' : 'Show'}</button>} />
          {showArchived && (
            <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
              {archived.map((v) => (
                <ListRow key={v.id} left={<VehicleGlyph vehicle={v} />} title={v.name} subtitle={vehicleSubtitle(v)} onClick={() => navigate(`/garage/${v.id}`)} chevron className="opacity-70" />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function AttentionRow({ items, vehicles }: { items: ReturnType<typeof needsAttention>; vehicles: Vehicle[] }) {
  const first = items[0]
  const v = vehicles.find((x) => x.id === first.vehicleId)
  const expired = items.some((i) => i.status.state === 'expired')
  return (
    <button onClick={() => navigate('/due')} className="press mb-5 flex w-full items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left">
      <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', expired ? 'bg-neg/12 text-neg' : 'bg-warn/12 text-warn')}>
        <TriangleAlert className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold tracking-tight">
          {docTypes[first.type].short}
          {v ? ` · ${v.name}` : ''}: {dueText(first).replace(/^In /, 'in ').replace(/^Expire/, 'expire')}
        </span>
        <span className="block text-[12px] text-ink-3">{items.length > 1 ? `And ${items.length - 1} more to renew` : `Renew by ${shortDay(first.expiresOn!)}`}</span>
      </span>
      <ChevronRight className="size-4 text-ink-3" />
    </button>
  )
}

/** On Money's Home: one row when a paper expires within a week. */
export function DueSoonRow() {
  const d = useData()
  const g = useGarage(hasVehicles(d.user.prefs)).data
  if (!hasVehicles(d.user.prefs)) return null
  const items = needsAttention(g, 7)
  if (!items.length) return null
  return <AttentionRow items={items} vehicles={g!.vehicles} />
}

function VehicleCard({ v, g }: { v: Vehicle; g: GarageData }) {
  const docs = currentDocs(g.documents.filter((d) => d.vehicleId === v.id))
  const next = docs.filter((d) => d.expiresOn).sort((a, b) => a.expiresOn!.localeCompare(b.expiresOn!))[0]
  const st = next ? docStatus(next) : null
  return (
    <a href={`/garage/${v.id}`} onClick={linkHandler(`/garage/${v.id}`)} className="press block rounded-[22px] bg-surface p-4 shadow-card">
      <div className="flex items-center gap-3">
        <VehicleGlyph vehicle={v} size={48} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[17px] font-semibold tracking-tight">{v.name}</p>
          <p className="truncate text-[13px] text-ink-3">{vehicleSubtitle(v) || 'Add its registration number'}</p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-ink-3" />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {v.odometer != null && <Pill icon={<Gauge className="size-3.5" />}>{km(v.odometer)}</Pill>}
        {keyDocs.slice(0, 2).map((t) => {
          const doc = docs.find((x) => x.type === t)
          const s = doc ? docStatus(doc) : null
          return (
            <Pill key={t} tone={!s ? 'missing' : s.state === 'expired' ? 'neg' : s.state === 'soon' ? 'warn' : 'ok'}>
              {docTypes[t].short} {s ? (s.state === 'expired' ? 'expired' : s.state === 'lifetime' ? '✓' : s.state === 'soon' ? `${s.days}d` : '✓') : '—'}
            </Pill>
          )
        })}
        {g.services
          .filter((r) => r.vehicleId === v.id && (r.state === 'overdue' || r.state === 'soon'))
          .slice(0, 1)
          .map((r) => (
            <Pill key={r.id} tone={r.state === 'overdue' ? 'neg' : 'warn'} icon={<Wrench className="size-3.5" />}>
              {r.title} · {ruleDue(r).replace(/^In /, '').replace(/^Overdue by /, '−')}
            </Pill>
          ))}
        {next && st && st.state === 'ok' && <Pill>Next: {docTypes[next.type].short} · {shortDay(next.expiresOn!)}</Pill>}
      </div>
    </a>
  )
}

function Pill({ children, icon, tone }: { children: ReactNode; icon?: ReactNode; tone?: 'neg' | 'warn' | 'ok' | 'missing' }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-semibold',
        tone === 'neg' ? 'bg-neg/12 text-neg' : tone === 'warn' ? 'bg-warn/12 text-warn' : tone === 'ok' ? 'bg-pos/10 text-pos' : tone === 'missing' ? 'bg-surface-2 text-ink-3' : 'bg-surface-2 text-ink-2',
      )}
    >
      {icon}
      {children}
    </span>
  )
}

// ---- One vehicle ----

export function VehicleDetail({ id }: { id: number }) {
  const q = useGarageData()
  const g = q.data
  const v = g?.vehicles.find((x) => x.id === id)
  const logs = useMemo(() => g?.logs.filter((l) => l.vehicleId === id) ?? [], [g, id])

  if (!g) return <Skeleton className="mt-16 h-64 w-full rounded-[22px]" />
  if (!v) {
    return (
      <div>
        <ScreenHeader title="Not found" back="/garage" />
        <EmptyState icon={<Car className="size-7" />} title="This vehicle isn't in your garage" />
      </div>
    )
  }
  const docs = currentDocs(g.documents.filter((d) => d.vehicleId === id))
  const extra = docs.filter((d) => !keyDocs.includes(d.type))
  const m = mileage(logs)
  const perDay = kmPerDay(logs)
  const year = `${new Date().getFullYear()}-01-01`
  const spentYear = vehicleSpend(logs, year)
  const lastService = logs.find((l) => l.kind === 'service')

  return (
    <div>
      <ScreenHeader
        title={v.name}
        subtitle={vehicleSubtitle(v)}
        back="/garage"
        actions={
          <IconButton label="Edit vehicle" onClick={() => openGarageSheet({ kind: 'vehicle', editing: v })} className="bg-surface">
            <Pencil className="size-[18px]" />
          </IconButton>
        }
      />

      <div className="grid grid-cols-3 gap-2">
        <Stat label="Odometer" value={v.odometer != null ? km(v.odometer) : '—'} sub={perDay ? `~${Math.round(perDay)} km a day` : v.odometerOn ? dayLabel(v.odometerOn) : undefined} onClick={() => openGarageSheet({ kind: 'log', preset: { kind: 'odometer', vehicleId: id } })} />
        <Stat label="Mileage" value={m ? `${m.latest.toFixed(1)}` : '—'} sub={m ? `km/${v.fuel === 'ev' ? 'kWh' : 'L'} · avg ${m.average.toFixed(1)}` : 'After 2 full fills'} />
        <Stat label="This year" value={money(spentYear, { compact: true })} sub={(() => { const n = logs.filter((l) => l.occurredOn >= year && l.amount > 0).length; return `${n} ${n === 1 ? 'cost' : 'costs'}` })()} />
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <QuickAction icon={<Fuel className="size-5" />} label="Fuel" onClick={() => openGarageSheet({ kind: 'log', preset: { kind: 'fuel', vehicleId: id } })} />
        <QuickAction icon={<Wrench className="size-5" />} label="Service" onClick={() => openGarageSheet({ kind: 'log', preset: { kind: 'service', vehicleId: id } })} />
        <QuickAction icon={<FileText className="size-5" />} label="Paper" onClick={() => openGarageSheet({ kind: 'doc', preset: { vehicleId: id, scan: true } })} />
      </div>

      <SectionTitle title="Papers" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        {keyDocs.map((t, i) => {
          const doc = docs.find((x) => x.type === t)
          return (
            <div key={t}>
              {i > 0 && <div className="ml-[68px] h-px bg-line" />}
              {doc ? (
                <DocRow doc={doc} />
              ) : (
                <ListRow
                  left={<Glyph icon={docTypes[t].icon} color="#94A3B8" />}
                  title={docTypes[t].label}
                  subtitle="Not added"
                  right={<span className="text-[13px] font-semibold text-accent">Add</span>}
                  onClick={() => openGarageSheet({ kind: 'doc', preset: { vehicleId: id, type: t, scan: true } })}
                />
              )}
            </div>
          )
        })}
        {extra.map((doc) => (
          <div key={doc.id}>
            <div className="ml-[68px] h-px bg-line" />
            <DocRow doc={doc} />
          </div>
        ))}
      </div>

      <ServiceSection v={v} rules={g.services.filter((r) => r.vehicleId === id)} />

      {lastService && (
        <p className="mt-3 px-1 text-[13px] text-ink-3">
          Last service: {logTitle(lastService)}, {dayLabel(lastService.occurredOn)}
          {lastService.odometer != null && v.odometer != null && v.odometer > lastService.odometer ? ` · ${km(v.odometer - lastService.odometer)} ago` : ''}
        </p>
      )}

      <SectionTitle title="History" />
      {logs.length === 0 ? (
        <Card>
          <EmptyState icon={<History className="size-7" />} title="Nothing yet" body="Fuel fills, services and other costs show up here. Fuel added in Money for this vehicle does too." />
        </Card>
      ) : (
        <LogList logs={logs} vehicles={g.vehicles} />
      )}
    </div>
  )
}

function ServiceSection({ v, rules }: { v: Vehicle; rules: ServiceRule[] }) {
  const save = useSaveGarage<ServiceRule>('service-rules')
  const [adding, setAdding] = useState(false)
  const addSuggested = async () => {
    setAdding(true)
    try {
      for (const r of suggestedRules(v.kind, v.fuel)) await save.mutateAsync({ body: { vehicleId: v.id, ...r } })
      haptic(15)
    } finally {
      setAdding(false)
    }
  }
  return (
    <>
      <SectionTitle
        title="Service"
        action={
          rules.length > 0 ? (
            <button onClick={() => openGarageSheet({ kind: 'rule', vehicleId: v.id })} className="text-[13px] font-semibold text-accent">
              Add
            </button>
          ) : undefined
        }
      />
      {rules.length === 0 ? (
        <Card className="p-4">
          <p className="text-[15px] font-semibold tracking-tight">When is the next service?</p>
          <p className="mt-0.5 text-[13px] text-ink-3">Set how often oil and service are due, by km or months. Kosh works out the next one from your logs and reminds you.</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" loading={adding} onClick={addSuggested}>
              Use the usual
            </Button>
            <Button size="sm" variant="secondary" onClick={() => openGarageSheet({ kind: 'rule', vehicleId: v.id })}>
              Set my own
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            The usual for a {v.fuel === 'ev' ? 'electric vehicle' : v.kind}: {suggestedRules(v.kind, v.fuel).map((r) => `${r.title.toLowerCase()} ${ruleEvery(r).toLowerCase()}`).join('; ')}.
          </p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
          {rules.map((r, i) => (
            <div key={r.id}>
              {i > 0 && <div className="ml-[68px] h-px bg-line" />}
              <ListRow
                left={<Glyph icon={/oil/i.test(r.title) ? '🛢️' : /tyre|tire/i.test(r.title) ? '🛞' : /chain/i.test(r.title) ? '⛓️' : '🔧'} color={r.state === 'overdue' ? '#EF4444' : r.state === 'soon' ? '#F59E0B' : '#3B82F6'} />}
                title={r.title}
                subtitle={[ruleEvery(r), r.lastOn ? `last ${shortDay(r.lastOn)}${r.lastKm != null ? ` at ${km(r.lastKm)}` : ''}` : null].filter(Boolean).join(' · ')}
                right={<span className={cn('text-[13px] font-semibold', ruleTone[r.state])}>{ruleDue(r)}</span>}
                onClick={() =>
                  r.state === 'unknown'
                    ? openGarageSheet({ kind: 'log', preset: { kind: 'service', vehicleId: v.id } })
                    : openGarageSheet({ kind: 'rule', vehicleId: v.id, editing: r })
                }
              />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Stat({ label, value, sub, onClick }: { label: string; value: string; sub?: string; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} className={cn('rounded-[20px] bg-surface p-3 text-left shadow-card', onClick && 'press')}>
      <p className="text-[12px] font-medium text-ink-3">{label}</p>
      <p className="mt-0.5 truncate text-[17px] font-semibold tracking-tight tnum">{value}</p>
      {sub && <p className="truncate text-[11px] text-ink-3">{sub}</p>}
    </Comp>
  )
}

function QuickAction({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button onClick={() => { haptic(6); onClick() }} className="press flex h-12 items-center justify-center gap-2 rounded-2xl bg-accent/10 text-[14px] font-semibold text-accent">
      {icon}
      {label}
    </button>
  )
}

function DocRow({ doc, vehicle, showVehicle }: { doc: VehicleDoc; vehicle?: Vehicle; showVehicle?: boolean }) {
  const s = docStatus(doc)
  const row = (
    <ListRow
      left={showVehicle ? <VehicleGlyph vehicle={vehicle} /> : <Glyph icon={docTypes[doc.type].icon} color={s.state === 'expired' ? '#EF4444' : s.state === 'soon' ? '#F59E0B' : '#22C55E'} />}
      title={showVehicle ? `${docLabel(doc)}${vehicle ? ` · ${vehicle.name}` : ''}` : docLabel(doc)}
      subtitle={[doc.expiresOn ? `${s.days < 0 ? 'Expired' : 'Expires'} ${shortDay(doc.expiresOn)}` : "Doesn't expire", doc.issuer, doc.number].filter(Boolean).join(' · ')}
      right={s.state === 'ok' || s.state === 'lifetime' ? undefined : <span className={cn('text-[13px] font-semibold', stateTone[s.state])}>{dueText(doc)}</span>}
      onClick={() => openGarageSheet({ kind: 'doc', editing: doc })}
      chevron={!doc.fileId}
    />
  )
  if (!doc.fileId) return row
  // With a file: a Show button beside the row opens it full screen, offline too.
  return (
    <div className="flex items-center">
      <div className="min-w-0 flex-1">{row}</div>
      <button
        onClick={() => {
          haptic(6)
          showPaper(doc)
        }}
        aria-label={`Show ${docLabel(doc)}`}
        className="press mr-3 h-8 shrink-0 rounded-full bg-accent/10 px-3 text-[13px] font-semibold text-accent"
      >
        Show
      </button>
    </div>
  )
}

// ---- Logs ----

function LogList({ logs, vehicles, showVehicle }: { logs: VehicleLog[]; vehicles: Vehicle[]; showVehicle?: boolean }) {
  const byMonth = useMemo(() => {
    const groups: { key: string; label: string; total: number; items: VehicleLog[] }[] = []
    for (const l of logs) {
      const key = l.occurredOn.slice(0, 7)
      let g = groups[groups.length - 1]
      if (!g || g.key !== key) {
        const dt = parseISO(l.occurredOn)
        g = { key, label: format(dt, dt.getFullYear() === new Date().getFullYear() ? 'MMMM' : 'MMMM yyyy'), total: 0, items: [] }
        groups.push(g)
      }
      g.items.push(l)
      g.total += l.amount
    }
    return groups
  }, [logs])
  const vById = new Map(vehicles.map((v) => [v.id, v]))
  return (
    <div className="space-y-5">
      {byMonth.map((g) => (
        <div key={g.key}>
          <div className="mb-1.5 flex items-center justify-between px-1 text-[13px] font-semibold text-ink-3">
            <span>{g.label}</span>
            {g.total > 0 && <span className="tnum">{money(g.total)}</span>}
          </div>
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {g.items.map((l, i) => {
              const v = vById.get(l.vehicleId)
              const meta = logKinds[l.kind]
              return (
                <div key={l.id}>
                  {i > 0 && <div className="ml-[68px] h-px bg-line" />}
                  <ListRow
                    left={<Glyph icon={meta.icon} color={meta.color} />}
                    title={logTitle(l)}
                    subtitle={[dayLabel(l.occurredOn), showVehicle && v?.name, l.odometer != null && km(l.odometer), l.kind === 'fuel' && l.litres && l.amount ? `${money(Math.round((l.amount * 1000) / l.litres))}/L` : null, l.note]
                      .filter(Boolean)
                      .join(' · ')}
                    right={l.amount > 0 ? <span className="text-[15px] font-semibold tnum">{money(l.amount)}</span> : undefined}
                    onClick={() => openGarageSheet({ kind: 'log', editing: l })}
                  />
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

export function Logs() {
  const g = useGarageData().data
  const [vehicle, setVehicle] = useState<number | null>(null)
  const vehicles = g?.vehicles ?? []
  const logs = (g?.logs ?? []).filter((l) => vehicle == null || l.vehicleId === vehicle)
  return (
    <div>
      <ScreenHeader title="Logs" subtitle="Fuel, service and every other cost" />
      {vehicles.length > 1 && (
        <div className="no-scrollbar -mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4">
          <Chip active={vehicle == null} onClick={() => setVehicle(null)}>
            All
          </Chip>
          {vehicles.map((v) => (
            <Chip key={v.id} active={vehicle === v.id} color={v.color === '#F8FAFC' ? '#94A3B8' : v.color} onClick={() => setVehicle(v.id)}>
              {v.name}
            </Chip>
          ))}
        </div>
      )}
      {!g ? (
        <Skeleton className="h-40 w-full rounded-[22px]" />
      ) : logs.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Fuel className="size-7" />}
            title="No logs yet"
            body="Add fuel, a service or any other cost with the + button."
            action={<Button onClick={() => openGarageSheet({ kind: 'menu' })}>Add</Button>}
          />
        </Card>
      ) : (
        <LogList logs={logs} vehicles={vehicles} showVehicle={vehicles.length > 1 && vehicle == null} />
      )}
    </div>
  )
}

// ---- Due: what to renew, soonest first ----

export function Due() {
  const g = useGarageData().data
  if (!g) return <Skeleton className="mt-16 h-40 w-full rounded-[22px]" />
  const list = dueList(g)
  const today = ymd(new Date())
  const groups: { title: string; items: typeof list }[] = [
    { title: 'Expired', items: list.filter((d) => d.status.state === 'expired') },
    { title: 'Next 30 days', items: list.filter((d) => d.status.state === 'soon') },
    { title: 'Later', items: list.filter((d) => d.status.state === 'ok') },
  ]
  const vById = new Map(g.vehicles.map((v) => [v.id, v]))
  const services = g.services.filter((r) => (r.state === 'overdue' || r.state === 'soon') && !vById.get(r.vehicleId)?.archived)
  // Vehicles missing insurance or PUC: worth adding, so they can be reminded.
  const missing = g.vehicles
    .filter((v) => !v.archived)
    .flatMap((v) => (['insurance', 'puc'] as const).filter((t) => !g.documents.some((d) => d.vehicleId === v.id && d.type === t)).map((t) => ({ v, t })))

  return (
    <div>
      <ScreenHeader title="Due" subtitle={list.length ? `Next: ${dueText(list.find((d) => d.expiresOn! >= today) ?? list[0]).toLowerCase()}` : 'Renewals, soonest first'} />
      <RemindersPrompt />
      {list.length === 0 && missing.length === 0 && services.length === 0 && (
        <Card>
          <EmptyState icon={<CalendarCheck className="size-7" />} title="Nothing to renew" body="Add insurance, PUC and tax papers, and they show up here before they expire." />
        </Card>
      )}
      {groups.map(
        (grp) =>
          grp.items.length > 0 && (
            <div key={grp.title}>
              <SectionTitle title={grp.title} />
              <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
                {grp.items.map((d, i) => (
                  <div key={d.id}>
                    {i > 0 && <div className="ml-[68px] h-px bg-line" />}
                    <DocRow doc={d} vehicle={d.vehicleId ? vById.get(d.vehicleId) : undefined} showVehicle />
                  </div>
                ))}
              </div>
            </div>
          ),
      )}
      {services.length > 0 && (
        <>
          <SectionTitle title="Service" />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {services.map((r, i) => {
              const v = vById.get(r.vehicleId)
              return (
                <div key={r.id}>
                  {i > 0 && <div className="ml-[68px] h-px bg-line" />}
                  <ListRow
                    left={<VehicleGlyph vehicle={v} />}
                    title={`${r.title} · ${v?.name ?? ''}`}
                    subtitle={ruleEvery(r)}
                    right={<span className={cn('text-[13px] font-semibold', ruleTone[r.state])}>{ruleDue(r)}</span>}
                    onClick={() => navigate(`/garage/${r.vehicleId}`)}
                    chevron
                  />
                </div>
              )
            })}
          </div>
        </>
      )}
      {missing.length > 0 && (
        <>
          <SectionTitle title="Not added yet" />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {missing.map(({ v, t }, i) => (
              <div key={`${v.id}-${t}`}>
                {i > 0 && <div className="ml-[68px] h-px bg-line" />}
                <ListRow
                  left={<VehicleGlyph vehicle={v} />}
                  title={`${docTypes[t].label} · ${v.name}`}
                  subtitle="Add it to be reminded before it expires"
                  right={<span className="text-[13px] font-semibold text-accent">Add</span>}
                  onClick={() => openGarageSheet({ kind: 'doc', preset: { vehicleId: v.id, type: t, scan: true } })}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ---- Papers: every document, by vehicle ----

export function Papers() {
  const owner = useData().user.isOwner
  const g = useGarageData().data
  const [past, setPast] = useState(false)
  if (!g) return <Skeleton className="mt-16 h-40 w-full rounded-[22px]" />
  const owners: { key: string; vehicle?: Vehicle; title: string }[] = [
    ...g.vehicles.filter((v) => !v.archived || g.documents.some((d) => d.vehicleId === v.id)).map((v) => ({ key: String(v.id), vehicle: v, title: v.name })),
    { key: 'me', title: 'You' },
  ]
  const older = g.documents.filter((d) => !isCurrent(d, g.documents))
  return (
    <div>
      <ScreenHeader
        title="Papers"
        subtitle={g.documents.some((d) => d.fileId) ? 'Tap Show to open one, even with no signal' : 'Insurance, PUC, tax, RC and your licence'}
        actions={
          <IconButton label="Add a paper" onClick={() => openGarageSheet({ kind: 'doc', preset: { scan: true } })} className="bg-surface">
            <Plus className="size-5" />
          </IconButton>
        }
      />
      {g.documents.length === 0 && (
        <Card>
          <EmptyState
            icon={<FileText className="size-7" />}
            title="No papers yet"
            body="Scan a photo or PDF of your insurance, PUC or licence. Kosh reads the expiry date."
            action={<Button onClick={() => openGarageSheet({ kind: 'doc', preset: { scan: true } })}>Scan a paper</Button>}
          />
        </Card>
      )}
      {owners.map((o) => {
        const docs = currentDocs(g.documents.filter((d) => (o.vehicle ? d.vehicleId === o.vehicle.id : d.vehicleId == null)))
        if (!docs.length) return null
        return (
          <div key={o.key}>
            <SectionTitle title={o.title} />
            <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
              {docs.map((d, i) => (
                <div key={d.id}>
                  {i > 0 && <div className="ml-[68px] h-px bg-line" />}
                  <DocRow doc={d} />
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {!g.documents.some((d) => d.type === 'licence') && g.documents.length > 0 && (
        <button onClick={() => openGarageSheet({ kind: 'doc', preset: { type: 'licence', scan: true } })} className="press mt-4 flex w-full items-center justify-center gap-1.5 py-2 text-[14px] font-semibold text-accent">
          <Plus className="size-4" strokeWidth={2.6} /> Add your driving licence
        </button>
      )}
      {!g.storage && g.documents.length > 0 && (
        <p className="mt-5 px-1 text-[12px] text-ink-3">
          {owner
            ? "Kosh reads dates from scans but can't keep the files yet. Connect a bucket in Sideyard's Storage tab for this project to keep copies you can show offline."
            : "This Kosh can't keep copies of files yet; ask its owner to connect storage."}
        </p>
      )}
      {older.length > 0 && (
        <>
          <SectionTitle title={`Earlier · ${older.length}`} action={<button onClick={() => setPast(!past)} className="text-[13px] font-semibold text-accent">{past ? 'Hide' : 'Show'}</button>} />
          {past && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="overflow-hidden rounded-[22px] bg-surface opacity-80 shadow-card">
              {older.map((d, i) => (
                <div key={d.id}>
                  {i > 0 && <div className="ml-[68px] h-px bg-line" />}
                  <DocRow doc={d} vehicle={d.vehicleId ? g.vehicles.find((v) => v.id === d.vehicleId) : undefined} showVehicle />
                </div>
              ))}
            </motion.div>
          )}
        </>
      )}
    </div>
  )
}
