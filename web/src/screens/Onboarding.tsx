import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { INDIAN_BANKS, MoneyInput, WALLETS } from '../components/Forms'
import { Button, Glyph, TextInput, cn } from '../components/ui'
import { api, errorMessage, type Module, type VehicleKind } from '../lib/api'
import { invalidateMoney, queryClient, useData, useUpdateMe } from '../lib/queries'
import { navigate } from '../lib/router'
import { rememberSpace, vehicleKinds } from '../lib/vehicles'
import { PAY_APPS, adoptFavourite } from '../lib/payapps'
import { AGENTS, type AgentKind } from './Agents'
import { IMPORT_APPS, OTHER_SOURCES, findImportApp } from '../lib/importapps'
import { AppMark } from './Import'

type Pick = { name: string; color: string; kind: 'bank' | 'wallet' }
type Step = 'modules' | 'switch' | 'banks' | 'balances' | 'payapps' | 'vehicle' | 'agent'

const vehicleColor: Record<VehicleKind, string> = { car: '#3B82F6', bike: '#EF4444', scooter: '#22C55E', other: '#64748B' }

/** First run: what Kosh is for, then where your money lives and/or your first vehicle. */
export function Onboarding() {
  const d = useData()
  const updateMe = useUpdateMe()
  const [modules, setModules] = useState<Module[]>(['finance'])
  const [step, setStep] = useState<Step>('modules')
  const [picked, setPicked] = useState<Pick[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [vKind, setVKind] = useState<VehicleKind>('bike')
  const [vName, setVName] = useState('')
  const [vReg, setVReg] = useState('')
  const [vOdo, setVOdo] = useState('')
  const [payApps, setPayApps] = useState<string[]>([])
  const [agent, setAgent] = useState<AgentKind | null>(null)
  // The app they're coming from; its file brings the accounts too.
  const [fromApp, setFromApp] = useState<string | null>(null)
  const from = findImportApp(fromApp)
  const [busy, setBusy] = useState(false)
  const cash = d.accounts.find((a) => a.kind === 'cash')

  const steps: Step[] = [
    'modules',
    ...(modules.includes('finance') ? (['switch', ...(from?.hasAccounts ? [] : ['banks', 'balances']), 'payapps'] as Step[]) : []),
    ...(modules.includes('vehicles') ? (['vehicle'] as Step[]) : []),
    'agent',
  ]
  const at = steps.indexOf(step)
  const next = () => setStep(steps[at + 1])
  const back = () => setStep(steps[at - 1])
  const isLast = at === steps.length - 1

  const toggle = (p: Pick) => setPicked((list) => (list.some((x) => x.name === p.name) ? list.filter((x) => x.name !== p.name) : [...list, p]))
  const toggleModule = (m: Module) =>
    setModules((list) => {
      const on = list.includes(m)
      if (on && list.length === 1) return list
      return on ? list.filter((x) => x !== m) : (['finance', 'vehicles'] as Module[]).filter((x) => x === m || list.includes(x))
    })

  const done = async () => {
    // Save the flag first, so the refresh below can't bring back an older copy without it.
    rememberSpace(modules.includes('finance') ? 'finance' : 'vehicles')
    adoptFavourite(payApps)
    await updateMe.mutateAsync({ prefs: { onboarded: true, modules, ...(payApps.length ? { payApps } : {}) } })
    invalidateMoney()
    queryClient.invalidateQueries({ queryKey: ['garage'] })
    if (from && modules.includes('finance')) navigate(`/settings/import?from=${from.id}`, { replace: true })
    else if (agent) navigate(`/settings/agents?connect=${agent}`, { replace: true })
    else if (!modules.includes('finance')) navigate('/garage', { replace: true })
  }

  const finish = async () => {
    setBusy(true)
    try {
      if (modules.includes('finance')) {
        for (const p of picked) {
          await api('POST', '/api/accounts', {
            name: p.name,
            kind: p.kind,
            institution: p.name,
            icon: p.kind === 'bank' ? '🏦' : '👛',
            color: p.color,
            openingBalance: balances[p.name] ?? 0,
          })
        }
        if (cash && balances.Cash) await api('PATCH', `/api/accounts/${cash.id}`, { openingBalance: balances.Cash })
      }
      if (modules.includes('vehicles') && (vName.trim() || vReg.trim())) {
        await api('POST', '/api/vehicles', {
          kind: vKind,
          name: vName.trim() || vehicleKinds[vKind].label,
          regNumber: vReg,
          color: vehicleColor[vKind],
          ...(vOdo ? { odometer: Number(vOdo) } : {}),
        })
      }
      await done()
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const skip = () => {
    rememberSpace(modules.includes('finance') ? 'finance' : 'vehicles')
    updateMe.mutate({ prefs: { onboarded: true, modules } })
    if (!modules.includes('finance')) navigate('/garage', { replace: true })
  }

  const primary = (label: ReactNode) =>
    isLast ? (
      <Button size="lg" className="flex-1" loading={busy} onClick={finish}>
        {from && modules.includes('finance') ? `Start, then import from ${from.name}` : agent ? `Start, then connect ${AGENTS.find((a) => a.id === agent)?.name}` : 'Start using Kosh'}
      </Button>
    ) : (
      <Button size="lg" className="flex-1" onClick={next}>
        {label} <ArrowRight className="size-5" />
      </Button>
    )

  return (
    <div className="mx-auto flex min-h-dvh max-w-[520px] flex-col px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)]">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {steps.map((s, i) => (
            <span key={s} className={cn('h-1.5 rounded-full transition-all duration-500', i <= at ? 'w-8 bg-accent' : 'w-4 bg-surface-3')} />
          ))}
        </div>
        <button onClick={skip} className="press rounded-full px-3 py-1.5 text-[14px] font-semibold text-ink-3">
          Skip
        </button>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-1 flex-col"
        >
          {step === 'modules' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">
                Hi {d.user.name.split(' ')[0]} 👋<br />What's Kosh for?
              </h1>
              <p className="mt-2 text-[15px] text-ink-2">Pick one or both. You can change this later in Settings.</p>
              <div className="mt-8 space-y-3">
                <ModuleTile on={modules.includes('finance')} onClick={() => toggleModule('finance')} icon="💰" color="#7C5CFF" title="Money" body="Accounts, spending, budgets, money lent and borrowed" />
                <ModuleTile on={modules.includes('vehicles')} onClick={() => toggleModule('vehicles')} icon="🚗" color="#0EA5E9" title="Vehicles" body="Insurance, PUC and tax reminders, fuel, mileage and service" />
              </div>
              <div className="mt-auto flex pt-8">{primary('Continue')}</div>
            </>
          )}

          {step === 'switch' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">Used another money app?</h1>
              <p className="mt-2 text-[15px] text-ink-2">Bring your history along. Pick it, and once setup is done Kosh shows you how to get the file out.</p>
              <button
                onClick={() => setFromApp(null)}
                className={cn('press mt-7 flex w-full items-center gap-3 rounded-[20px] p-3 text-left', !fromApp ? 'bg-ink text-bg' : 'bg-surface shadow-card')}
              >
                <Glyph icon="🌱" color="#22C55E" size={40} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold tracking-tight">No, starting fresh</span>
                  <span className={cn('block text-[12px]', !fromApp ? 'opacity-70' : 'text-ink-3')}>You can import later from Settings</span>
                </span>
                {!fromApp && <Check className="size-5 text-accent" strokeWidth={3} />}
              </button>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[...IMPORT_APPS, ...OTHER_SOURCES].map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setFromApp(fromApp === a.id ? null : a.id)}
                    className={cn('press flex flex-col items-center gap-1.5 rounded-2xl px-1 py-3 text-center text-[12px] font-semibold leading-tight', fromApp === a.id ? 'bg-ink text-bg' : 'bg-surface text-ink-2 shadow-card')}
                  >
                    <AppMark app={a} size={36} />
                    {a.id === 'other' ? 'Another app' : a.name}
                  </button>
                ))}
              </div>
              {from?.hasAccounts && <p className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-2">Your accounts come over from {from.name} too, so Kosh won’t ask for them now.</p>}
              <div className="mt-auto flex gap-2 pt-8">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                {primary(fromApp ? 'Continue' : 'Skip')}
              </div>
            </>
          )}

          {step === 'banks' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">Where's your money?</h1>
              <p className="mt-2 text-[15px] text-ink-2">Pick your banks and wallets. Cash is already set up. You can add more later.</p>

              <p className="mb-2.5 mt-8 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Banks</p>
              <div className="flex flex-wrap gap-2">
                {INDIAN_BANKS.map((b) => (
                  <PickChip key={b.name} on={picked.some((p) => p.name === b.name)} color={b.color} label={b.name} onClick={() => toggle({ ...b, kind: 'bank' })} />
                ))}
              </div>

              <p className="mb-2.5 mt-7 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Wallets</p>
              <div className="flex flex-wrap gap-2">
                {WALLETS.map((w) => (
                  <PickChip key={w.name} on={picked.some((p) => p.name === w.name)} color={w.color} label={w.name} onClick={() => toggle({ ...w, kind: 'wallet' })} />
                ))}
              </div>

              <div className="mt-auto flex gap-2 pt-8">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                {primary('Continue')}
              </div>
            </>
          )}

          {step === 'balances' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">How much is in each?</h1>
              <p className="mt-2 text-[15px] text-ink-2">Today's balance is enough. Kosh keeps it up to date from here.</p>
              <div className="mt-8 space-y-2.5">
                {[...picked, { name: 'Cash', color: '#22C55E', kind: 'cash' as const }].map((p) => (
                  <div key={p.name} className="flex items-center gap-3 rounded-[20px] bg-surface p-2.5 pl-3 shadow-card">
                    <Glyph icon={p.kind === 'bank' ? '🏦' : p.kind === 'wallet' ? '👛' : '💵'} color={p.color} size={40} />
                    <span className="flex-1 truncate text-[15px] font-semibold">{p.name}</span>
                    <div className="w-[150px]">
                      <MoneyInput value={balances[p.name] ?? 0} onChange={(v) => setBalances((b) => ({ ...b, [p.name]: v }))} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-auto flex gap-2 pt-8">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                {primary('Continue')}
              </div>
            </>
          )}

          {step === 'payapps' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">How do you pay?</h1>
              <p className="mt-2 text-[15px] text-ink-2">Pick the apps you use. Tap your favourite first: Scan & pay opens it with the amount filled in.</p>
              <div className="mt-8 grid grid-cols-3 gap-2">
                {PAY_APPS.map((app) => {
                  const at = payApps.indexOf(app.id)
                  return (
                    <button
                      key={app.id}
                      onClick={() => setPayApps((l) => (l.includes(app.id) ? l.filter((x) => x !== app.id) : [...l, app.id]))}
                      className={cn('press relative flex flex-col items-center gap-1.5 rounded-2xl px-1 py-3 text-center text-[12px] font-semibold leading-tight', at >= 0 ? 'bg-ink text-bg' : 'bg-surface text-ink-2 shadow-card')}
                    >
                      <span className="grid size-10 place-items-center rounded-full text-[16px] font-bold text-white" style={{ background: app.color }}>
                        {app.letter}
                      </span>
                      {app.name}
                      {at === 0 && <span className="absolute right-1.5 top-1.5 rounded-full bg-accent px-1.5 text-[9px] font-bold uppercase text-white">Fav</span>}
                    </button>
                  )
                })}
              </div>
              <p className="mt-4 rounded-2xl bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-2">
                Whichever you use, Kosh can also record payments by itself from your bank's SMS. Set it up later in Settings → Auto-capture.
              </p>
              <div className="mt-auto flex gap-2 pt-8">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                {primary(payApps.length ? 'Continue' : 'Skip')}
              </div>
            </>
          )}

          {step === 'agent' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">Use an AI agent?</h1>
              <p className="mt-2 text-[15px] text-ink-2">Text “spent ₹200 on lunch” to your agent and it lands here. Optional; you can do this later in Settings.</p>
              <div className="mt-8 space-y-2">
                {AGENTS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setAgent(agent === a.id ? null : a.id)}
                    className={cn('press flex w-full items-center gap-3 rounded-[20px] p-3 text-left', agent === a.id ? 'bg-ink text-bg' : 'bg-surface shadow-card')}
                  >
                    <Glyph icon={a.icon} color={a.color} size={40} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-semibold tracking-tight">{a.name}</span>
                      <span className={cn('block text-[12px]', agent === a.id ? 'opacity-70' : 'text-ink-3')}>{a.blurb}</span>
                    </span>
                    {agent === a.id && <Check className="size-5 text-accent" strokeWidth={3} />}
                  </button>
                ))}
              </div>
              <div className="mt-auto flex gap-2 pt-8">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                {primary('Continue')}
              </div>
            </>
          )}

          {step === 'vehicle' && (
            <>
              <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">Your first vehicle</h1>
              <p className="mt-2 text-[15px] text-ink-2">Add the rest, and its papers, from the garage.</p>
              <div className="mt-8 grid grid-cols-4 gap-2">
                {(Object.keys(vehicleKinds) as VehicleKind[]).map((k) => (
                  <button
                    key={k}
                    onClick={() => setVKind(k)}
                    className={cn('press flex flex-col items-center gap-1 rounded-2xl py-3 text-[13px] font-semibold', vKind === k ? 'bg-ink text-bg' : 'bg-surface text-ink-2 shadow-card')}
                  >
                    <span className="text-[26px]">{vehicleKinds[k].icon}</span>
                    {vehicleKinds[k].label}
                  </button>
                ))}
              </div>
              <div className="mt-5 space-y-3">
                <TextInput value={vName} onChange={(e) => setVName(e.target.value)} placeholder={`Name, like ${vKind === 'car' ? 'Swift' : vKind === 'scooter' ? 'Activa' : 'Pulsar'}`} maxLength={40} />
                <TextInput value={vReg} onChange={(e) => setVReg(e.target.value.toUpperCase())} placeholder="Registration, like KA 01 AB 1234" autoCapitalize="characters" spellCheck={false} className="uppercase" />
                <TextInput value={vOdo} onChange={(e) => setVOdo(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" placeholder="Odometer today (km)" />
              </div>
              <div className="mt-auto flex gap-2 pt-8">
                <Button variant="secondary" size="lg" onClick={back}>
                  Back
                </Button>
                {primary('Continue')}
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function ModuleTile({ on, onClick, icon, color, title, body }: { on: boolean; onClick: () => void; icon: string; color: string; title: string; body: string }) {
  return (
    <button onClick={onClick} className={cn('press flex w-full items-center gap-4 rounded-[24px] p-4 text-left transition-colors', on ? 'bg-ink text-bg' : 'bg-surface shadow-card')}>
      <Glyph icon={icon} color={color} size={52} />
      <span className="min-w-0 flex-1">
        <span className="block text-[18px] font-semibold tracking-tight">{title}</span>
        <span className={cn('block text-[13px] leading-snug', on ? 'opacity-70' : 'text-ink-3')}>{body}</span>
      </span>
      <span className={cn('grid size-7 shrink-0 place-items-center rounded-full', on ? 'bg-accent text-white' : 'bg-surface-2')}>{on && <Check className="size-4" strokeWidth={3} />}</span>
    </button>
  )
}

function PickChip({ on, color, label, onClick }: { on: boolean; color: string; label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={cn('press flex h-10 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-[14px] font-semibold transition-colors', on ? 'bg-ink text-bg' : 'bg-surface text-ink-2 shadow-card')}>
      <span className="grid size-7 place-items-center rounded-full text-white" style={{ background: color }}>
        {on ? <Check className="size-4" strokeWidth={3} /> : null}
      </span>
      {label}
    </button>
  )
}
