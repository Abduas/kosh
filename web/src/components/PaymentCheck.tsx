import { Check, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { money } from '../lib/format'
import { haptic } from '../lib/look'
import { useData, useSaveTxs } from '../lib/queries'
import { closeComposer } from '../lib/store'
import { kindMeta } from '../lib/tx'
import { readPending, writePending, type PendingPayment } from '../lib/upi'
import { Sheet } from './Sheet'
import { Avatar, Button, Glyph } from './ui'

/**
 * After Kosh opens a UPI app, the page goes to the background. When it comes
 * back, this asks whether the payment went through and saves it on "yes".
 * The question survives the PWA being closed while you were paying.
 */
export function PaymentCheck() {
  const d = useData()
  const save = useSaveTxs()
  // pending stays set while the sheet animates closed.
  const [pending, setPending] = useState<PendingPayment | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const check = () => {
      const p = readPending()
      if (document.visibilityState === 'hidden') {
        // Leaving within a few seconds of tapping Pay means the UPI app opened.
        if (p && !p.left && Date.now() - p.startedAt < 30_000) {
          writePending({ ...p, left: true })
          closeComposer()
        }
        return
      }
      if (p?.left) {
        setPending(p)
        setOpen(true)
      } else setOpen(false)
    }
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', check)
    window.addEventListener('kosh:pending-payment', check)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', check)
      window.removeEventListener('kosh:pending-payment', check)
    }
  }, [])

  if (!pending) return null

  const first = pending.items[0]
  const account = d.accountsById.get(first.accountId)
  const category = first.categoryId ? d.categoriesById.get(first.categoryId) : undefined
  const person = first.personId ? d.peopleById.get(first.personId) : undefined
  const split = pending.splitWith.filter(Boolean)

  const yes = () => {
    save.mutate(pending.items, {
      onSuccess: () => {
        haptic(15)
        writePending(null)
        toast.success(`Paid ${money(pending.total)} to ${pending.payeeName}`)
      },
    })
  }
  const no = () => {
    haptic(10)
    writePending(null)
    toast('Not saved')
  }
  const retry = () => {
    haptic(10)
    writePending({ ...pending, startedAt: Date.now(), left: false })
    window.location.href = pending.link
  }

  const detail =
    first.kind === 'expense'
      ? [category ? `${category.icon} ${category.name}` : 'No category', split.length > 0 && `split with ${split.join(', ')}`].filter(Boolean).join(' · ')
      : `${kindMeta[first.kind].label}${person ? ` · ${person.name}` : ''}`

  return (
    <Sheet open={open} onOpenChange={() => {}} dismissible={false} title="Did the payment go through?" description={`Kosh opened ${pending.appName}. Check it there, then tell Kosh what happened.`}>
      <div className="flex items-center gap-3 rounded-[22px] bg-surface-2 p-4">
        {person ? (
          <Avatar name={person.name} color={person.color} size={46} />
        ) : category ? (
          <Glyph icon={category.icon} color={category.color} size={46} />
        ) : (
          <Avatar name={pending.payeeName} color="#64748B" size={46} />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[16px] font-semibold">{pending.payeeName}</p>
          <p className="truncate text-[13px] text-ink-3">
            {pending.payee}
            {account && ` · from ${account.name}`}
          </p>
          <p className="truncate text-[12px] font-medium text-ink-3">{detail}</p>
        </div>
        <p className="text-[22px] font-bold tracking-[-0.03em] tnum">{money(pending.total)}</p>
      </div>

      <div className="mt-5 grid gap-2">
        <Button size="lg" loading={save.isPending} icon={<Check className="size-5" strokeWidth={2.6} />} onClick={yes}>
          Yes, it's paid
        </Button>
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={no}>
            No, it failed
          </Button>
          <Button variant="secondary" disabled={save.isPending} icon={<RotateCcw className="size-4" />} onClick={retry}>
            Try again
          </Button>
        </div>
      </div>
    </Sheet>
  )
}
