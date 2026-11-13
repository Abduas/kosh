import { ArrowDownLeft, ArrowUpRight, Inbox, X } from 'lucide-react'
import { useState } from 'react'
import { Amount } from '../components/Money'
import { EmptyState, ScreenHeader, Skeleton, cn } from '../components/ui'
import type { Capture } from '../lib/api'
import { dayLabel, timeLabel } from '../lib/format'
import { haptic } from '../lib/look'
import { useCaptures, useData, useDismissCapture } from '../lib/queries'
import { navigate } from '../lib/router'
import { openComposer } from '../lib/store'

/** Where a captured message came from: "HDFC Bank ••4521". */
export function captureSource(c: { bank: string; last4: string }) {
  return [c.bank, c.last4 && `••${c.last4}`].filter(Boolean).join(' ') || 'Bank message'
}

/** Bank messages Kosh couldn't file by itself. Tap one to save it, or dismiss it. */
export function Review() {
  const list = useCaptures()
  const items = list.data ?? []

  return (
    <div>
      <ScreenHeader title="To review" subtitle="Payments read from your bank messages. Tap one to save it." back="/" />

      {list.isPending ? (
        <div className="space-y-3">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Inbox className="size-7" />}
          title="All caught up"
          body="New bank messages show up here when Kosh isn't sure how to file them."
          action={
            <button onClick={() => navigate('/settings/capture')} className="press text-[15px] font-semibold text-accent">
              Auto-capture settings
            </button>
          }
        />
      ) : (
        <div>
          {items.map((c) => (
            <CaptureRow key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  )
}

function CaptureRow({ c }: { c: Capture }) {
  const d = useData()
  const dismiss = useDismissCapture()
  // Dismissing takes two taps, like deleting: one stray touch can't lose a payment.
  const [confirm, setConfirm] = useState(false)
  const out = c.direction === 'debit'
  const s = c.suggestion
  const category = s.categoryId ? d.categoriesById.get(s.categoryId) : undefined
  const person = s.personId ? d.peopleById.get(s.personId) : undefined
  const account = c.accountId ? d.accountsById.get(c.accountId) : undefined

  const open = () => {
    haptic(8)
    openComposer({
      kind: s.kind,
      amount: c.amount,
      accountId: account && !account.archived ? account.id : undefined,
      categoryId: category && !category.archived ? category.id : undefined,
      personId: person && !person.archived ? person.id : undefined,
      note: s.note,
      occurredAt: c.occurredAt,
      captureId: c.id,
    })
  }

  return (
    <div className="flex items-center gap-1">
      <button onClick={open} className="press flex min-w-0 flex-1 items-center gap-3.5 rounded-2xl px-1 py-2.5 text-left">
        <span className={cn('grid size-[42px] shrink-0 place-items-center rounded-[14px]', out ? 'bg-neg/10 text-neg' : 'bg-pos/12 text-pos')}>
          {out ? <ArrowUpRight className="size-5" strokeWidth={2.4} /> : <ArrowDownLeft className="size-5" strokeWidth={2.4} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-medium tracking-tight">{c.merchant || (out ? 'Payment' : 'Money in')}</div>
          <div className="truncate text-[13px] text-ink-3">
            {dayLabel(c.occurredAt.slice(0, 10))} · {timeLabel(c.occurredAt)} · {account?.name ?? captureSource(c)}
            {category && ` · ${category.name}?`}
          </div>
        </div>
        <Amount value={out ? -c.amount : c.amount} sign tone={out ? 'none' : 'pos'} className="font-rounded text-[16px] font-semibold tracking-tight" />
      </button>
      <button
        onClick={() => {
          if (!confirm) {
            haptic(6)
            setConfirm(true)
            setTimeout(() => setConfirm(false), 3000)
            return
          }
          haptic(12)
          dismiss.mutate(c)
        }}
        aria-label={confirm ? 'Tap again to dismiss' : 'Dismiss'}
        className={cn('press grid h-9 shrink-0 place-items-center rounded-full transition-all', confirm ? 'w-[84px] bg-neg text-[13px] font-semibold text-white' : 'w-9 bg-surface-2 text-ink-3')}
      >
        {confirm ? 'Dismiss' : <X className="size-4" />}
      </button>
    </div>
  )
}
