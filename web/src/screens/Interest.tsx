import { useMutation } from '@tanstack/react-query'
import { FileSearch, HandHeart } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { MoneyInput } from '../components/Forms'
import { Sheet } from '../components/Sheet'
import { Button, Chip, EmptyState, Field, ScreenHeader, Skeleton, TextInput, cn } from '../components/ui'
import { api, errorMessage, type InterestSummary } from '../lib/api'
import { localNow, money, shortDate } from '../lib/format'
import { invalidateMoney, queryClient, useData, useInterest } from '../lib/queries'
import { navigate } from '../lib/router'

/**
 * Interest to give away: what banks paid in interest (income in the Interest
 * category) less what's been given away, for people who don't keep interest.
 */
export function InterestScreen() {
  const q = useInterest()
  const d = useData()
  const [giving, setGiving] = useState(false)
  const s = q.data
  const accountName = (id: number) => d.accounts.find((a) => a.id === id)?.name ?? ''

  return (
    <div>
      <ScreenHeader title="Interest" back="/settings" subtitle="What your banks paid you in interest, to give away." />
      {!s ? (
        <Skeleton className="h-44 rounded-[24px]" />
      ) : s.entries.length === 0 ? (
        <EmptyState
          icon={<HandHeart className="size-7" />}
          title="No interest yet"
          body="Check a bank statement to find the interest it paid. Interest you record in the Interest category shows up here too."
          action={
            <Button icon={<FileSearch className="size-4" />} onClick={() => navigate('/statement')}>
              Check a statement
            </Button>
          }
        />
      ) : (
        <>
          <section className="rounded-[24px] bg-surface p-5 shadow-card">
            <p className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">To give away</p>
            <p className={cn('mt-1 text-[40px] font-bold leading-tight tracking-[-0.03em] tnum', s.toGive === 0 && 'text-pos')}>{money(s.toGive)}</p>
            <p className="text-[13px] text-ink-3">
              {money(s.earned)} earned · {money(s.given)} given away
            </p>
            <Button size="lg" className="mt-4 w-full" icon={<HandHeart className="size-5" />} onClick={() => setGiving(true)}>
              I gave some away
            </Button>
            <Button variant="ghost" className="mt-1 w-full" icon={<FileSearch className="size-4" />} onClick={() => navigate('/statement')}>
              Check a statement for more
            </Button>
          </section>

          {s.years.length > 1 && (
            <>
              <h2 className="mb-2.5 mt-8 px-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">By year</h2>
              <div className="divide-y divide-line overflow-hidden rounded-[22px] bg-surface shadow-card">
                {s.years.map((y) => (
                  <div key={y.year} className="flex items-center px-4 py-3">
                    <span className="flex-1 text-[15px] font-medium">{y.year}</span>
                    <span className="text-right text-[13px] text-ink-3">
                      <span className="block text-[15px] font-semibold text-ink tnum">{money(y.earned)}</span>
                      {y.given > 0 && `${money(y.given)} given`}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2 className="mb-2.5 mt-8 px-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">History</h2>
          <div className="divide-y divide-line overflow-hidden rounded-[22px] bg-surface shadow-card">
            {s.entries.map((e) => (
              <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-[17px]', e.given ? 'bg-pos/12' : 'bg-accent/12')}>{e.given ? '🤲' : '📈'}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-medium">{e.given ? e.note || 'Given away' : 'Interest from ' + accountName(e.accountId)}</p>
                  <p className="truncate text-[12px] text-ink-3">
                    {shortDate(e.at.slice(0, 10))}
                    {!e.given && e.note && ` · ${e.note}`}
                  </p>
                </div>
                <span className={cn('shrink-0 text-[15px] font-semibold tnum', e.given ? 'text-ink' : 'text-pos')}>{money(e.given ? -e.amount : e.amount, { sign: true })}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <Sheet open={giving} onOpenChange={setGiving} title="Gave interest away" description="Recorded as an expense, so the account’s balance goes down by it.">
        {giving && s && <GiveForm summary={s} onDone={() => setGiving(false)} />}
      </Sheet>
    </div>
  )
}

function GiveForm({ summary, onDone }: { summary: InterestSummary; onDone: () => void }) {
  const d = useData()
  const accounts = d.accounts.filter((a) => !a.archived)
  const [amount, setAmount] = useState(summary.toGive)
  const [accountId, setAccountId] = useState(summary.entries.find((e) => !e.given)?.accountId ?? accounts[0]?.id ?? 0)
  const [date, setDate] = useState(localNow().slice(0, 10))
  const [note, setNote] = useState('')
  const give = useMutation({
    mutationFn: () => api<InterestSummary>('POST', '/api/interest/give', { amount, accountId, note, occurredAt: `${date}T${localNow().slice(11, 16)}` }),
    onSuccess: (s) => {
      queryClient.setQueryData(['interest'], s)
      invalidateMoney()
      toast.success(s.toGive === 0 ? 'All given away' : `${money(s.toGive)} left to give`)
      onDone()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  return (
    <div className="space-y-5">
      <Field label="How much">
        <MoneyInput value={amount} onChange={setAmount} />
      </Field>
      <div>
        <p className="mb-1.5 px-1 text-[13px] font-medium text-ink-2">Paid from</p>
        <div className="no-scrollbar -mx-6 flex gap-2 overflow-x-auto px-6">
          {accounts.map((a) => (
            <Chip key={a.id} active={a.id === accountId} color={a.color} onClick={() => setAccountId(a.id)}>
              <span>{a.icon}</span> {a.name}
            </Chip>
          ))}
        </div>
      </div>
      <Field label="When">
        <TextInput type="date" value={date} max={localNow().slice(0, 10)} onChange={(e) => e.target.value && setDate(e.target.value)} className="appearance-none text-left" />
      </Field>
      <Field label="Note">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Masjid fund" maxLength={120} />
      </Field>
      <Button size="lg" className="w-full" loading={give.isPending} disabled={amount <= 0 || !accountId} onClick={() => give.mutate()}>
        Save
      </Button>
    </div>
  )
}
