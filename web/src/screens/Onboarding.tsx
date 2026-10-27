import { AnimatePresence, motion } from 'motion/react'
import { ArrowRight, Check } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { INDIAN_BANKS, MoneyInput, WALLETS } from '../components/Forms'
import { Button, Glyph, cn } from '../components/ui'
import { api, errorMessage } from '../lib/api'
import { invalidateMoney, useData, useUpdateMe } from '../lib/queries'

type Pick = { name: string; color: string; kind: 'bank' | 'wallet' }

/** First run: pick where your money lives and enter today's balances. */
export function Onboarding() {
  const d = useData()
  const updateMe = useUpdateMe()
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<Pick[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState(false)
  const cash = d.accounts.find((a) => a.kind === 'cash')

  const toggle = (p: Pick) => setPicked((list) => (list.some((x) => x.name === p.name) ? list.filter((x) => x.name !== p.name) : [...list, p]))

  const finish = async () => {
    setBusy(true)
    try {
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
      // Save the flag first, so the refresh below can't bring back an older copy without it.
      await updateMe.mutateAsync({ prefs: { onboarded: true } })
      invalidateMoney()
    } catch (e) {
      toast.error(errorMessage(e))
      setBusy(false)
    }
  }

  const skip = () => updateMe.mutate({ prefs: { onboarded: true } })

  return (
    <div className="mx-auto flex min-h-dvh max-w-[520px] flex-col px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)]">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {[0, 1].map((i) => (
            <span key={i} className={cn('h-1.5 rounded-full transition-all duration-500', i <= step ? 'w-8 bg-accent' : 'w-4 bg-surface-3')} />
          ))}
        </div>
        <button onClick={skip} className="press rounded-full px-3 py-1.5 text-[14px] font-semibold text-ink-3">
          Skip
        </button>
      </div>

      <AnimatePresence mode="wait">
        {step === 0 ? (
          <motion.div key="pick" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }} className="flex flex-1 flex-col">
            <h1 className="mt-10 text-[32px] font-bold leading-tight tracking-[-0.03em]">Hi {d.user.name.split(' ')[0]} 👋<br />Where's your money?</h1>
            <p className="mt-2 text-[15px] text-ink-2">Pick your banks and wallets. Cash is already set up. You can add more later.</p>

            <p className="mb-2.5 mt-8 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Banks</p>
            <div className="flex flex-wrap gap-2">
              {INDIAN_BANKS.map((b) => {
                const on = picked.some((p) => p.name === b.name)
                return (
                  <button key={b.name} onClick={() => toggle({ ...b, kind: 'bank' })} className={cn('press flex h-10 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-[14px] font-semibold transition-colors', on ? 'bg-ink text-bg' : 'bg-surface text-ink-2 shadow-card')}>
                    <span className="grid size-7 place-items-center rounded-full text-white" style={{ background: b.color }}>
                      {on ? <Check className="size-4" strokeWidth={3} /> : null}
                    </span>
                    {b.name}
                  </button>
                )
              })}
            </div>

            <p className="mb-2.5 mt-7 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">Wallets</p>
            <div className="flex flex-wrap gap-2">
              {WALLETS.map((w) => {
                const on = picked.some((p) => p.name === w.name)
                return (
                  <button key={w.name} onClick={() => toggle({ ...w, kind: 'wallet' })} className={cn('press flex h-10 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-[14px] font-semibold transition-colors', on ? 'bg-ink text-bg' : 'bg-surface text-ink-2 shadow-card')}>
                    <span className="grid size-7 place-items-center rounded-full text-white" style={{ background: w.color }}>
                      {on ? <Check className="size-4" strokeWidth={3} /> : null}
                    </span>
                    {w.name}
                  </button>
                )
              })}
            </div>

            <Button size="lg" className="mt-auto w-full" onClick={() => setStep(1)}>
              Continue <ArrowRight className="size-5" />
            </Button>
          </motion.div>
        ) : (
          <motion.div key="balances" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }} className="flex flex-1 flex-col">
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
              <Button variant="secondary" size="lg" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button size="lg" className="flex-1" loading={busy} onClick={finish}>
                Start using Kosh
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
