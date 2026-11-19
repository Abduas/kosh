import { Archive, ArchiveRestore, Eye, FileText, KeyRound, LoaderCircle, Paperclip, ScanText, Sparkles, Trash2, X } from 'lucide-react'
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { Account, DocType, FuelKind, LogKind, ServiceRule, Vehicle, VehicleDoc, VehicleKind, VehicleLog } from '../lib/api'
import { INSURERS } from '../lib/docparse'
import { PasswordNeeded, readDocument, shrinkForUpload, type ReadResult } from '../lib/docread'
import { money, ymd } from '../lib/format'
import { haptic } from '../lib/look'
import { queryClient, uploadDocFile, useData, useDeleteGarage, useGarage, useSaveGarage } from '../lib/queries'
import { navigate } from '../lib/router'
import { closeGarageSheet, garageSheet, openGarageSheet, showPaper, type GarageSheet } from '../lib/store'
import {
  defaultExpiry,
  docLabel,
  docTypes,
  expenseTitles,
  formatReg,
  fuelKinds,
  hasFinance,
  km,
  lastVehicleId,
  logKinds,
  rememberVehicle,
  serviceTitles,
  shortDay,
  vehicleKinds,
} from '../lib/vehicles'
import { ColorPicker, MoneyInput } from './Forms'
import { Sheet } from './Sheet'
import { Button, Chip, Field, Glyph, TextInput, Toggle, cn } from './ui'

/** Hosts every vehicle sheet; open one with openGarageSheet. */
export function GarageSheets() {
  const { sheet, key } = garageSheet.use((s) => s)
  const [shown, setShown] = useState<GarageSheet | null>(sheet)
  // Keep the last sheet's content while it slides away.
  if (sheet && sheet !== shown) setShown(sheet)
  const open = !!sheet
  const s = sheet ?? shown
  const onOpenChange = (o: boolean) => !o && closeGarageSheet()
  const title =
    s?.kind === 'menu'
      ? 'Add'
      : s?.kind === 'vehicle'
        ? s.editing ? 'Edit vehicle' : 'Add a vehicle'
        : s?.kind === 'log'
          ? s.editing ? `Edit ${logKinds[s.editing.kind].label.toLowerCase()}` : logKinds[s.preset?.kind ?? 'fuel'].label
          : s?.kind === 'doc'
            ? s.editing ? docLabel(s.editing) : s.preset?.renew ? `Renew ${docTypes[s.preset.renew.type].short}` : 'Add a paper'
            : s?.kind === 'rule'
              ? s.editing ? 'Edit schedule' : 'Service schedule'
              : ''
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title}>
      {s?.kind === 'menu' && <AddMenu vehicleId={s.vehicleId} />}
      {s?.kind === 'vehicle' && <VehicleForm key={key} vehicle={s.editing} />}
      {s?.kind === 'log' && <LogForm key={key} log={s.editing} preset={s.preset} />}
      {s?.kind === 'doc' && <DocForm key={key} doc={s.editing} preset={s.preset} />}
      {s?.kind === 'rule' && <RuleForm key={key} vehicleId={s.vehicleId} rule={s.editing} />}
    </Sheet>
  )
}

// ---- The vehicles + button ----

function AddMenu({ vehicleId }: { vehicleId?: number }) {
  const g = useGarage().data
  const hasVehicle = (g?.vehicles.filter((v) => !v.archived).length ?? 0) > 0
  const item = (icon: string, label: string, hint: string, onClick: () => void, color: string) => (
    <button onClick={() => { haptic(6); onClick() }} className="press flex items-center gap-3 rounded-2xl bg-surface-2 p-3 text-left">
      <Glyph icon={icon} color={color} size={42} />
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold">{label}</span>
        <span className="block text-[12px] text-ink-3">{hint}</span>
      </span>
    </button>
  )
  if (!hasVehicle) {
    return (
      <div className="space-y-2">
        <p className="pb-1 text-[14px] text-ink-2">Start with your vehicle. Fuel, service and papers go under it.</p>
        {item('🚗', 'Add a vehicle', 'Car, bike or scooter', () => openGarageSheet({ kind: 'vehicle' }), '#3B82F6')}
        {item('🪪', 'Driving licence', 'Yours, not a vehicle’s', () => openGarageSheet({ kind: 'doc', preset: { type: 'licence', scan: true } }), '#8B5CF6')}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {item('⛽', 'Fuel', 'Litres, price and km', () => openGarageSheet({ kind: 'log', preset: { kind: 'fuel', vehicleId } }), logKinds.fuel.color)}
      {item('🔧', 'Service', 'Oil change, repairs…', () => openGarageSheet({ kind: 'log', preset: { kind: 'service', vehicleId } }), logKinds.service.color)}
      {item('📄', 'Paper', 'Insurance, PUC, tax… scan to fill in', () => openGarageSheet({ kind: 'doc', preset: { vehicleId, scan: true } }), '#8B5CF6')}
      {item('🧾', 'Other cost', 'Parking, toll, FASTag…', () => openGarageSheet({ kind: 'log', preset: { kind: 'expense', vehicleId } }), logKinds.expense.color)}
      {item('📍', 'Odometer', 'Today’s reading', () => openGarageSheet({ kind: 'log', preset: { kind: 'odometer', vehicleId } }), logKinds.odometer.color)}
      {item('🚗', 'Another vehicle', 'Add to your garage', () => openGarageSheet({ kind: 'vehicle' }), '#0EA5E9')}
    </div>
  )
}

// ---- Small pieces ----

function VehiclePicker({ vehicles, value, onChange }: { vehicles: Vehicle[]; value: number; onChange: (id: number) => void }) {
  if (vehicles.length <= 1) return null
  return (
    <div className="no-scrollbar -mx-6 flex gap-2 overflow-x-auto px-6">
      {vehicles.map((v) => (
        <Chip key={v.id} active={value === v.id} color={v.color} onClick={() => onChange(v.id)}>
          <span>{vehicleKinds[v.kind].icon}</span> {v.name}
        </Chip>
      ))}
    </div>
  )
}

/** Where a cost was paid from; "none" keeps it out of Money. */
function PaidFrom({ accounts, value, onChange }: { accounts: Account[]; value: number | null; onChange: (id: number | null) => void }) {
  return (
    <Field label="Paid from" hint={value ? 'Also saved as an expense in Money.' : 'Not added to Money.'}>
      <select
        value={value ?? 0}
        onChange={(e) => onChange(Number(e.target.value) || null)}
        className="h-12 w-full rounded-2xl bg-surface-2 px-4 text-[15px] font-medium outline-none"
      >
        <option value={0}>Not tracked in Money</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.icon} {a.name}
          </option>
        ))}
      </select>
    </Field>
  )
}

function DateInput({ value, onChange, ...rest }: { value: string; onChange: (v: string) => void; max?: string; min?: string }) {
  return (
    <TextInput type="date" value={value} onChange={(e) => onChange(e.target.value)} className="appearance-none text-left" {...rest} />
  )
}

function NumberInput({ value, onChange, placeholder, suffix, decimal }: { value: string; onChange: (v: string) => void; placeholder?: string; suffix?: string; decimal?: boolean }) {
  return (
    <div className="relative">
      <TextInput
        inputMode={decimal ? 'decimal' : 'numeric'}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, ''))}
        className={cn('font-semibold tnum', suffix && (suffix.length > 3 ? 'pr-20' : 'pr-12'))}
      />
      {suffix && <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[14px] font-semibold text-ink-3">{suffix}</span>}
    </div>
  )
}

function ConfirmDelete({ label, onConfirm, busy }: { label: string; onConfirm: () => void; busy?: boolean }) {
  const [sure, setSure] = useState(false)
  return (
    <Button
      variant="danger"
      size="lg"
      loading={busy}
      onClick={() => {
        if (!sure) {
          setSure(true)
          haptic(10)
          setTimeout(() => setSure(false), 3000)
          return
        }
        onConfirm()
      }}
      icon={<Trash2 className="size-5" />}
    >
      {sure ? 'Sure?' : label}
    </Button>
  )
}

function useVehicles() {
  const g = useGarage().data
  return { garage: g, vehicles: g?.vehicles.filter((v) => !v.archived) ?? [] }
}

function lastAccount(accounts: Account[]): number | null {
  try {
    const id = Number(localStorage.getItem('kosh:lastAccount'))
    return accounts.find((a) => a.id === id)?.id ?? accounts[0]?.id ?? null
  } catch {
    return accounts[0]?.id ?? null
  }
}

// ---- Vehicle ----

const vehicleColors = ['#3B82F6', '#EF4444', '#0F172A', '#64748B', '#F8FAFC', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899']

function VehicleForm({ vehicle }: { vehicle?: Vehicle }) {
  const save = useSaveGarage<Vehicle>('vehicles')
  const del = useDeleteGarage('vehicles')
  const [kind, setKind] = useState<VehicleKind>(vehicle?.kind ?? 'bike')
  const [name, setName] = useState(vehicle?.name ?? '')
  const [reg, setReg] = useState(vehicle ? formatReg(vehicle.regNumber) : '')
  const [make, setMake] = useState(vehicle?.make ?? '')
  const [model, setModel] = useState(vehicle?.model ?? '')
  const [year, setYear] = useState(vehicle?.year ? String(vehicle.year) : '')
  const [fuel, setFuel] = useState<FuelKind>(vehicle?.fuel ?? 'petrol')
  const [color, setColor] = useState(vehicle?.color ?? '#3B82F6')
  const [odo, setOdo] = useState('')

  const submit = () => {
    const body: Record<string, unknown> = { kind, name: name.trim() || [make, model].filter(Boolean).join(' '), regNumber: reg, make, model, year: Number(year) || 0, fuel, color }
    if (!vehicle && odo) body.odometer = Number(odo)
    save.mutate(
      { id: vehicle?.id, body },
      {
        onSuccess: (v) => {
          haptic(15)
          toast.success(vehicle ? 'Saved' : `${v.name} added`)
          rememberVehicle(v.id)
          closeGarageSheet()
        },
      },
    )
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-4 gap-2">
        {(Object.keys(vehicleKinds) as VehicleKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={cn('press flex flex-col items-center gap-1 rounded-2xl py-3 text-[13px] font-semibold', kind === k ? 'bg-ink text-bg' : 'bg-surface-2 text-ink-2')}
          >
            <span className="text-[24px]">{vehicleKinds[k].icon}</span>
            {vehicleKinds[k].label}
          </button>
        ))}
      </div>
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'car' ? 'Swift' : kind === 'scooter' ? 'Activa' : 'Pulsar'} maxLength={40} />
      </Field>
      <Field label="Registration number">
        <TextInput
          value={reg}
          onChange={(e) => setReg(e.target.value.toUpperCase())}
          placeholder="KA 01 AB 1234"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-semibold uppercase tracking-wide"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Make">
          <TextInput value={make} onChange={(e) => setMake(e.target.value)} placeholder="Honda" maxLength={40} />
        </Field>
        <Field label="Model">
          <TextInput value={model} onChange={(e) => setModel(e.target.value)} placeholder="Activa 6G" maxLength={40} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Year">
          <NumberInput value={year} onChange={(v) => setYear(v.slice(0, 4))} placeholder={String(new Date().getFullYear())} />
        </Field>
        <Field label="Fuel">
          <select value={fuel} onChange={(e) => setFuel(e.target.value as FuelKind)} className="h-12 w-full rounded-2xl bg-surface-2 px-4 text-[15px] font-medium outline-none">
            {(Object.keys(fuelKinds) as FuelKind[]).map((f) => (
              <option key={f} value={f}>
                {fuelKinds[f]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!vehicle && (
        <Field label="Odometer today" hint="Kosh uses it to work out mileage and when a service is due.">
          <NumberInput value={odo} onChange={setOdo} placeholder="12,345" suffix="km" />
        </Field>
      )}
      <Field label="Colour">
        <ColorPicker value={color} onChange={setColor} />
        <div className="mt-2 flex gap-2">
          {vehicleColors.map((c) => (
            <button key={c} type="button" aria-label={c} onClick={() => setColor(c)} className="press size-7 rounded-full ring-1 ring-line" style={{ background: c, boxShadow: color === c ? `0 0 0 3px var(--surface), 0 0 0 5px ${c === '#F8FAFC' ? '#94A3B8' : c}` : undefined }} />
          ))}
        </div>
      </Field>
      <div className="flex gap-2 pt-1">
        {vehicle && (
          <Button
            variant="secondary"
            size="lg"
            onClick={() => save.mutate({ id: vehicle.id, body: { archived: !vehicle.archived } }, { onSuccess: () => { toast.success(vehicle.archived ? 'Back in your garage' : 'Archived'); closeGarageSheet() } })}
            icon={vehicle.archived ? <ArchiveRestore className="size-5" /> : <Archive className="size-5" />}
            aria-label={vehicle.archived ? 'Unarchive' : 'Archive (sold)'}
          />
        )}
        <Button size="lg" className="flex-1" loading={save.isPending} onClick={submit}>
          {vehicle ? 'Save' : 'Add vehicle'}
        </Button>
      </div>
      {vehicle && (
        <div className="space-y-2 border-t border-line pt-4">
          <p className="px-1 text-[12px] text-ink-3">Sold it? Archive keeps its history. Deleting removes its logs and papers; expenses stay in Money.</p>
          <ConfirmDelete
            label="Delete vehicle"
            busy={del.isPending}
            onConfirm={() => del.mutate(vehicle.id, { onSuccess: () => { toast.success(`${vehicle.name} deleted`); closeGarageSheet(); setTimeout(() => navigate('/garage', { replace: true }), 50) } })}
          />
        </div>
      )}
    </div>
  )
}

// ---- Fuel, service, other cost, odometer ----

function LogForm({ log, preset }: { log?: VehicleLog; preset?: { vehicleId?: number; kind?: LogKind } }) {
  const d = useData()
  const { garage, vehicles } = useVehicles()
  const save = useSaveGarage<VehicleLog>('vehicle-logs')
  const del = useDeleteGarage('vehicle-logs')
  const finance = hasFinance(d.user.prefs)
  const kind: LogKind = log?.kind ?? preset?.kind ?? 'fuel'
  const firstVehicle = log?.vehicleId ?? preset?.vehicleId ?? vehicles.find((v) => v.id === lastVehicleId())?.id ?? vehicles[0]?.id ?? 0
  const [vehicleId, setVehicleId] = useState(firstVehicle)
  const [date, setDate] = useState(log?.occurredOn ?? ymd(new Date()))
  const [amount, setAmount] = useState(log?.amount ?? 0)
  const [odo, setOdo] = useState(log?.odometer != null ? String(log.odometer) : '')
  const [qty, setQty] = useState(log?.litres ? String(log.litres / 1000) : '')
  const [full, setFull] = useState(log?.fullTank ?? true)
  const [title, setTitle] = useState(log?.title ?? '')
  const [note, setNote] = useState(log?.note ?? '')
  const [account, setAccount] = useState<number | null>(log ? log.accountId : finance ? lastAccount(d.activeAccounts) : null)

  const vehicle = garage?.vehicles.find((v) => v.id === vehicleId)
  const lastOdo = vehicle?.odometer
  const ml = qty ? Math.round(Number(qty) * 1000) : 0
  const perLitre = ml > 0 && amount > 0 ? Math.round((amount * 1000) / ml) : 0
  const ev = vehicle?.fuel === 'ev'
  const odoLow = odo && lastOdo != null && !log && Number(odo) < lastOdo

  const submit = () => {
    if (!vehicleId) return toast.error('Add a vehicle first')
    const body: Record<string, unknown> = {
      vehicleId,
      kind,
      occurredOn: date,
      odometer: odo ? Number(odo) : null,
      litres: kind === 'fuel' && ml > 0 ? ml : null,
      fullTank: kind === 'fuel' && full,
      title: title.trim(),
      amount: kind === 'odometer' ? 0 : amount,
      note: note.trim(),
    }
    if (kind !== 'odometer' && (finance || log?.accountId)) body.accountId = amount > 0 ? account : null
    save.mutate(
      { id: log?.id, body },
      {
        onSuccess: () => {
          haptic(15)
          rememberVehicle(vehicleId)
          if (account) {
            try {
              localStorage.setItem('kosh:lastAccount', String(account))
            } catch {}
          }
          toast.success(log ? 'Saved' : kind === 'odometer' ? `${vehicle?.name}: ${km(Number(odo))}` : `${logKinds[kind].label} saved${amount ? ` · ${money(amount)}` : ''}`)
          closeGarageSheet()
        },
      },
    )
  }

  const ruleTitles = (garage?.services ?? []).filter((r) => r.vehicleId === vehicleId).map((r) => r.title)
  const titles = kind === 'service' ? [...new Set([...ruleTitles, ...serviceTitles])] : kind === 'expense' ? expenseTitles : []
  // A service can cover several jobs: "General service, Oil change".
  const picked = title.split(',').map((t) => t.trim()).filter(Boolean)
  const toggleTitle = (t: string) => {
    if (kind !== 'service') return setTitle(title === t ? '' : t)
    setTitle((picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]).join(', '))
  }

  return (
    <div className="space-y-5">
      <VehiclePicker vehicles={vehicles} value={vehicleId} onChange={setVehicleId} />

      {kind !== 'odometer' && (
        <Field label={kind === 'fuel' ? 'Amount' : 'Cost'} hint={perLitre ? `${money(perLitre)} per ${ev ? 'kWh' : 'litre'}` : undefined}>
          <MoneyInput value={amount} onChange={setAmount} />
        </Field>
      )}

      {kind === 'fuel' && (
        <div className="grid grid-cols-2 items-end gap-3">
          <Field label={ev ? 'Energy' : 'Litres'}>
            <NumberInput value={qty} onChange={setQty} placeholder="0.0" suffix={ev ? 'kWh' : 'L'} decimal />
          </Field>
          <label className="flex h-12 items-center justify-between gap-2 rounded-2xl bg-surface-2 px-4">
            <span className="text-[14px] font-medium">Full {ev ? 'charge' : 'tank'}</span>
            <Toggle checked={full} onChange={setFull} label="Full tank" />
          </label>
        </div>
      )}

      {titles.length > 0 && (
        <Field label={kind === 'service' ? 'What was done' : 'What for'}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder={titles[0]} maxLength={80} />
          <div className="no-scrollbar -mx-6 mt-2 flex gap-1.5 overflow-x-auto px-6">
            {titles.map((t) => (
              <Chip key={t} active={kind === 'service' ? picked.includes(t) : title === t} onClick={() => toggleTitle(t)} className="h-8">
                {t}
              </Chip>
            ))}
          </div>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Odometer" hint={odoLow ? <span className="text-warn">Lower than the last reading ({km(lastOdo!)})</span> : lastOdo != null ? `Last: ${km(lastOdo)}` : undefined}>
          <NumberInput value={odo} onChange={setOdo} placeholder={lastOdo != null ? String(lastOdo) : 'km'} suffix="km" />
        </Field>
        <Field label="Date">
          <DateInput value={date} onChange={setDate} max={ymd(new Date())} />
        </Field>
      </div>

      {kind !== 'odometer' && (finance || log?.accountId) && <PaidFrom accounts={d.activeAccounts} value={account} onChange={setAccount} />}

      {kind !== 'odometer' && (
        <Field label="Note">
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'fuel' ? 'Pump name' : 'Garage name'} maxLength={280} />
        </Field>
      )}

      <div className="flex gap-2 pt-1">
        {log && (
          <ConfirmDelete
            label=""
            busy={del.isPending}
            onConfirm={() => del.mutate(log.id, { onSuccess: () => { toast.success(log.transactionId ? 'Deleted, with its expense' : 'Deleted'); closeGarageSheet() } })}
          />
        )}
        <Button size="lg" className="flex-1" loading={save.isPending} onClick={submit} disabled={kind === 'odometer' ? !odo : false}>
          {log ? 'Save' : kind === 'odometer' ? 'Save reading' : 'Save'}
        </Button>
      </div>
    </div>
  )
}

// ---- Service schedules ----

function RuleForm({ vehicleId, rule }: { vehicleId: number; rule?: ServiceRule }) {
  const save = useSaveGarage<ServiceRule>('service-rules')
  const del = useDeleteGarage('service-rules')
  const [title, setTitle] = useState(rule?.title ?? 'Oil change')
  const [everyKm, setEveryKm] = useState(rule?.everyKm ? String(rule.everyKm) : '')
  const [everyMonths, setEveryMonths] = useState(rule?.everyMonths ? String(rule.everyMonths) : '')
  const submit = () =>
    save.mutate(
      { id: rule?.id, body: { vehicleId, title: title.trim(), everyKm: everyKm ? Number(everyKm) : null, everyMonths: everyMonths ? Number(everyMonths) : null } },
      { onSuccess: () => { haptic(15); toast.success('Schedule saved'); closeGarageSheet() } },
    )
  return (
    <div className="space-y-5">
      <Field label="What">
        <TextInput value={title} onChange={(e) => setTitle(e.target.value.replace(',', ''))} maxLength={40} />
        <div className="no-scrollbar -mx-6 mt-2 flex gap-1.5 overflow-x-auto px-6">
          {serviceTitles.slice(0, 6).map((t) => (
            <Chip key={t} active={title === t} onClick={() => setTitle(t)} className="h-8">
              {t}
            </Chip>
          ))}
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Every">
          <NumberInput value={everyKm} onChange={setEveryKm} placeholder="3000" suffix="km" />
        </Field>
        <Field label="Or every">
          <NumberInput value={everyMonths} onChange={setEveryMonths} placeholder="6" suffix="months" />
        </Field>
      </div>
      <p className="px-1 text-[12px] text-ink-3">Whichever comes first. Kosh counts from the last service log that mentions "{title || '…'}", and reminds you before the next one.</p>
      <div className="flex gap-2 pt-1">
        {rule && <ConfirmDelete label="" busy={del.isPending} onConfirm={() => del.mutate(rule.id, { onSuccess: () => { toast.success('Schedule deleted'); closeGarageSheet() } })} />}
        <Button size="lg" className="flex-1" loading={save.isPending} onClick={submit} disabled={!title.trim() || (!everyKm && !everyMonths)}>
          Save
        </Button>
      </div>
    </div>
  )
}

// ---- Papers ----

const docOrder: DocType[] = ['insurance', 'puc', 'road_tax', 'rc', 'licence', 'fitness', 'permit', 'warranty', 'other']

function DocForm({ doc, preset }: { doc?: VehicleDoc; preset?: { vehicleId?: number | null; type?: DocType; renew?: VehicleDoc; scan?: boolean } }) {
  const d = useData()
  const { garage, vehicles } = useVehicles()
  const save = useSaveGarage<VehicleDoc>('vehicle-documents')
  const del = useDeleteGarage('vehicle-documents')
  const finance = hasFinance(d.user.prefs)
  const renew = preset?.renew
  const base = doc ?? renew
  const [type, setType] = useState<DocType>(base?.type ?? preset?.type ?? 'insurance')
  const [vehicleId, setVehicleId] = useState<number>(
    base?.vehicleId ?? preset?.vehicleId ?? vehicles.find((v) => v.id === lastVehicleId())?.id ?? vehicles[0]?.id ?? 0,
  )
  const [issued, setIssued] = useState(doc?.issuedOn ?? (renew?.expiresOn ? nextDay(renew.expiresOn) : ''))
  const [expires, setExpires] = useState(doc ? (doc.expiresOn ?? '') : renew?.expiresOn ? (defaultExpiry(renew.type, nextDay(renew.expiresOn)) ?? '') : '')
  const [lifetime, setLifetime] = useState(doc ? !doc.expiresOn : (preset?.type ?? 'insurance') === 'road_tax')
  const [number, setNumber] = useState(doc?.number ?? renew?.number ?? '')
  const [issuer, setIssuer] = useState(doc?.issuer ?? renew?.issuer ?? '')
  const [title, setTitle] = useState(doc?.title ?? '')
  const [amount, setAmount] = useState(doc?.amount ?? 0)
  const [amountKey, setAmountKey] = useState(0)
  const [note, setNote] = useState(doc?.note ?? '')
  const [account, setAccount] = useState<number | null>(doc ? doc.accountId : finance ? lastAccount(d.activeAccounts) : null)
  const [file, setFile] = useState<File | null>(null)
  const [reading, setReading] = useState<string | null>(null)
  const [read, setRead] = useState<ReadResult | null>(null)
  const [pdfPassword, setPdfPassword] = useState<{ file: File; wrong: boolean } | null>(null)
  const [password, setPassword] = useState('')
  const [uploading, setUploading] = useState(false)
  const [removingFile, setRemovingFile] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const storage = garage?.storage ?? false
  const forVehicle = type !== 'licence'

  const scan = async (f: File, pw?: string) => {
    setFile(f)
    setPdfPassword(null)
    setReading('Reading…')
    try {
      const r = await readDocument(f, { password: pw, status: setReading })
      setRead(r)
      apply(r)
      haptic(12)
    } catch (e) {
      if (e instanceof PasswordNeeded) {
        setPdfPassword({ file: f, wrong: e.wrong })
      } else {
        console.error(e)
        toast.error("Couldn't read this one. Fill in the dates yourself; the file is still attached.")
      }
    } finally {
      setReading(null)
    }
  }

  const apply = (r: ReadResult) => {
    const found: string[] = []
    if (r.type && !doc) {
      setType(r.type)
      if (r.type !== 'road_tax') setLifetime(false)
    }
    if (r.expiresOn) {
      setExpires(r.expiresOn)
      setLifetime(false)
      found.push('expiry')
    }
    if (r.issuedOn) setIssued(r.issuedOn)
    if (r.number) setNumber(r.number)
    if (r.issuer) setIssuer(r.issuer)
    if (r.amount && !amount) {
      setAmount(r.amount)
      setAmountKey((k) => k + 1)
    }
    if (r.regNumber) {
      const v = vehicles.find((x) => x.regNumber === r.regNumber)
      if (v) setVehicleId(v.id)
    }
    if (!r.expiresOn && !r.issuedOn) toast("Couldn't find the dates. Add them below.")
  }

  const pick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (f) scan(f)
  }

  const onTypeChange = (t: DocType) => {
    setType(t)
    if (!doc && !read) {
      setLifetime(t === 'road_tax' || t === 'rc')
      if (!expires && docTypes[t].months) setExpires(defaultExpiry(t, issued || null) ?? '')
    }
  }

  const submit = async () => {
    if (forVehicle && !vehicleId) return toast.error('Add a vehicle first')
    if (!lifetime && !expires) return toast.error("Add the expiry date, or turn on Doesn't expire")
    const body: Record<string, unknown> = {
      vehicleId: forVehicle ? vehicleId : null,
      type,
      title: title.trim(),
      number: number.trim(),
      issuer: issuer.trim(),
      issuedOn: issued,
      expiresOn: lifetime ? '' : expires,
      amount,
      note: note.trim(),
    }
    if (finance || doc?.accountId) body.accountId = amount > 0 ? account : null
    try {
      const saved = await save.mutateAsync({ id: doc?.id, body })
      if (file && storage) {
        setUploading(true)
        try {
          await uploadDocFile(saved.id, await shrinkForUpload(file))
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Couldn't upload the file")
        } finally {
          setUploading(false)
        }
      }
      haptic(15)
      toast.success(doc ? 'Saved' : `${docTypes[type].short} saved${!lifetime && expires ? ` · till ${shortDay(expires)}` : ''}`)
      closeGarageSheet()
    } catch {
      // The mutation shows the error.
    }
  }

  const hasStoredFile = !!doc?.fileName && !file

  return (
    <div className="space-y-5">
      {/* Scan: a photo or a PDF, read on this phone */}
      <input ref={fileInput} type="file" accept="image/*,application/pdf" className="hidden" onChange={pick} />
      {reading ? (
        <div className="flex items-center gap-3 rounded-[20px] bg-accent/10 px-4 py-3.5 text-accent">
          <LoaderCircle className="size-5 animate-spin" />
          <span className="text-[14px] font-semibold">{reading}</span>
        </div>
      ) : pdfPassword ? (
        <div className="space-y-2 rounded-[20px] bg-surface-2 p-3">
          <p className="flex items-center gap-2 px-1 text-[14px] font-semibold">
            <KeyRound className="size-4" /> {pdfPassword.wrong ? 'That password is wrong' : 'This PDF is locked'}
          </p>
          <p className="px-1 text-[12px] text-ink-3">Insurers often use your date of birth (DDMMYYYY) or phone number.</p>
          <div className="flex gap-2">
            <TextInput value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" autoFocus />
            <Button onClick={() => scan(pdfPassword.file, password)} disabled={!password}>
              Open
            </Button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => fileInput.current?.click()}
          className="press flex w-full items-center gap-3 rounded-[20px] bg-accent/10 px-4 py-3.5 text-left text-accent"
        >
          <ScanText className="size-6 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold">{file || hasStoredFile ? 'Scan another photo or PDF' : 'Scan a photo or PDF'}</span>
            <span className="block text-[12px] opacity-80">Kosh reads the dates and numbers for you</span>
          </span>
        </button>
      )}

      {read && (read.expiresOn || read.issuedOn) && (
        <p className="flex items-start gap-2 rounded-2xl bg-pos/10 px-3 py-2.5 text-[13px] font-medium text-pos">
          <Sparkles className="mt-0.5 size-4 shrink-0" />
          Filled in from the {file?.type === 'application/pdf' ? 'PDF' : 'photo'}. Check the dates before saving.
        </p>
      )}

      {(file || hasStoredFile) && (
        <div className="flex items-center gap-3 rounded-2xl bg-surface-2 px-3 py-2.5">
          <FileText className="size-5 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{file?.name ?? doc?.fileName}</span>
          {hasStoredFile && (
            <button onClick={() => showPaper(doc!)} className="press grid size-8 place-items-center rounded-full bg-surface text-ink-2" aria-label="View file">
              <Eye className="size-4" />
            </button>
          )}
          <button
            aria-label="Remove file"
            disabled={removingFile}
            onClick={async () => {
              if (file) return setFile(null)
              setRemovingFile(true)
              try {
                await fetch(`/api/vehicle-documents/${doc!.id}/file`, { method: 'DELETE', credentials: 'same-origin' })
                queryClient.invalidateQueries({ queryKey: ['garage'] })
                toast.success('File removed')
                closeGarageSheet()
              } finally {
                setRemovingFile(false)
              }
            }}
            className="press grid size-8 place-items-center rounded-full bg-surface text-ink-2"
          >
            <X className="size-4" />
          </button>
        </div>
      )}
      {file && !storage && (
        <p className="flex items-start gap-2 px-1 text-[12px] text-ink-3">
          <Paperclip className="mt-0.5 size-3.5 shrink-0" />
          The dates are read, but this Kosh can't keep a copy of the file until storage is connected.
        </p>
      )}

      {!doc && (
        <div className="no-scrollbar -mx-6 flex gap-1.5 overflow-x-auto px-6">
          {docOrder.map((t) => (
            <Chip key={t} active={type === t} onClick={() => onTypeChange(t)}>
              <span>{docTypes[t].icon}</span> {docTypes[t].short}
            </Chip>
          ))}
        </div>
      )}

      {forVehicle && <VehiclePicker vehicles={vehicles} value={vehicleId} onChange={setVehicleId} />}

      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid from">
            <DateInput value={issued} onChange={(v) => { setIssued(v); if (!doc && !read && !lifetime && docTypes[type].months) setExpires(defaultExpiry(type, v) ?? expires) }} />
          </Field>
          <Field label="Expires on">
            <DateInput value={lifetime ? '' : expires} onChange={(v) => { setExpires(v); setLifetime(false) }} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {[6, 12, 36].map((m) => (
            <Chip
              key={m}
              className="h-8"
              onClick={() => {
                const from = issued || ymd(new Date())
                const [y, mo, dd] = from.split('-').map(Number)
                setExpires(ymd(new Date(y, mo - 1 + m, dd - 1)))
                setLifetime(false)
              }}
            >
              +{m === 36 ? '3 years' : m === 12 ? '1 year' : '6 months'}
            </Chip>
          ))}
          <Chip className="h-8" active={lifetime} onClick={() => setLifetime(!lifetime)}>
            Doesn't expire
          </Chip>
        </div>
      </div>

      <Field label={type === 'insurance' ? 'Policy number' : type === 'licence' ? 'Licence number' : type === 'puc' ? 'Certificate number' : 'Number'}>
        <TextInput value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} spellCheck={false} />
      </Field>
      {(type === 'insurance' || type === 'warranty' || type === 'other') && (
        <Field label={type === 'insurance' ? 'Insurer' : 'Issued by'}>
          <TextInput value={issuer} onChange={(e) => setIssuer(e.target.value)} list={type === 'insurance' ? 'insurers' : undefined} maxLength={60} />
          <datalist id="insurers">
            {INSURERS.map((i) => (
              <option key={i} value={i} />
            ))}
          </datalist>
        </Field>
      )}
      {type === 'other' && (
        <Field label="Name">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="FASTag, extended warranty…" maxLength={60} />
        </Field>
      )}

      <Field label={type === 'insurance' ? 'Premium' : 'Fee paid'}>
        <MoneyInput key={amountKey} value={amount} onChange={setAmount} />
      </Field>
      {(finance || doc?.accountId) && amount > 0 && <PaidFrom accounts={d.activeAccounts} value={account} onChange={setAccount} />}

      <Field label="Note">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={280} />
      </Field>

      <div className="flex gap-2 pt-1">
        {doc && (
          <ConfirmDelete
            label=""
            busy={del.isPending}
            onConfirm={() => del.mutate(doc.id, { onSuccess: () => { toast.success('Deleted'); closeGarageSheet() } })}
          />
        )}
        {doc && doc.expiresOn && (
          <Button variant="secondary" size="lg" onClick={() => openGarageSheet({ kind: 'doc', preset: { renew: doc, scan: true } })}>
            Renew
          </Button>
        )}
        <Button size="lg" className="flex-1" loading={save.isPending || uploading} onClick={submit} disabled={!!reading}>
          Save
        </Button>
      </div>
    </div>
  )
}

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + 1))
}

/** A row's colour dot by vehicle. Exported for lists. */
export function VehicleGlyph({ vehicle, size = 40 }: { vehicle?: Vehicle; size?: number }): ReactNode {
  return <Glyph icon={vehicle ? vehicleKinds[vehicle.kind].icon : '🪪'} color={vehicle?.color === '#F8FAFC' ? '#94A3B8' : (vehicle?.color ?? '#8B5CF6')} size={size} />
}

