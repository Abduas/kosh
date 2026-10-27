import { motion } from 'motion/react'
import { Check, Clock, Undo2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { api, errorMessage, type Transaction } from '../lib/api'
import { money } from '../lib/format'
import { haptic } from '../lib/look'
import { invalidateMoney, txInput, useData, usePendingTxs } from '../lib/queries'
import { describeTx } from '../lib/tx'
import { TxIcon } from './TxList'
import { Button, cn } from './ui'

/** A payment saved in one go: a split bill is several transactions. */
type Group = { key: string; items: Transaction[]; total: number; savedAt: string }

function ageText(utc: string): string {
  const h = (Date.now() - Date.parse(utc)) / 3_600_000
  if (h < 1) return 'pending for a few minutes'
  if (h < 24) return `pending for ${Math.round(h)} h`
  const days = Math.round(h / 24)
  return `pending for ${days} ${days === 1 ? 'day' : 'days'}`
}

/**
 * UPI payments you said were pending. They count in your balances (the money
 * left) until you mark them as gone through, or refunded.
 */
export function PendingPayments() {
  const d = useData()
  const q = usePendingTxs()
  const [busy, setBusy] = useState<string | null>(null)

  const groups = useMemo(() => {
    const map = new Map<string, Group>()
    for (const t of q.data?.items ?? []) {
      const key = `${t.createdAt}|${t.accountId}`
      const g = map.get(key) ?? { key, items: [], total: 0, savedAt: t.createdAt }
      g.items.push(t)
      g.total += t.amount
      map.set(key, g)
    }
    return [...map.values()]
  }, [q.data])

  if (groups.length === 0) return null

  const resolve = async (g: Group, how: 'done' | 'refunded') => {
    haptic(12)
    setBusy(g.key)
    try {
      for (const t of g.items) {
        if (how === 'done') await api('PATCH', `/api/transactions/${t.id}`, { ...txInput(t), status: 'done' })
        else await api('DELETE', `/api/transactions/${t.id}`)
      }
      const account = d.accountsById.get(g.items[0].accountId)
      toast.success(how === 'done' ? 'Marked as paid' : `Removed. ${money(g.total)} is back in ${account?.name ?? 'your account'}.`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
      invalidateMoney()
    }
  }

  return (
    <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-5 overflow-hidden rounded-[24px] bg-surface shadow-card">
      <div className="flex items-center gap-2 bg-warn/12 px-4 py-2.5 text-warn">
        <Clock className="size-4" />
        <p className="text-[13px] font-semibold">
          {groups.length === 1 ? 'A payment is pending' : `${groups.length} payments are pending`}
        </p>
      </div>
      {groups.map((g, i) => {
        const main = g.items.find((t) => t.payee) ?? g.items[0]
        const { title } = describeTx(main, d)
        const old = Date.now() - Date.parse(g.savedAt) > 24 * 3_600_000
        return (
          <div key={g.key} className={cn('px-4 py-3', i > 0 && 'border-t border-line')}>
            <div className="flex items-center gap-3">
              <TxIcon t={main} d={d} size={38} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold">{main.note || title}</p>
                <p className="truncate text-[12px] text-ink-3">
                  {main.payee || title} · {ageText(g.savedAt)}
                  {g.items.length > 1 && ` · split ${g.items.length} ways`}
                </p>
              </div>
              <p className="text-[16px] font-bold tracking-tight tnum">{money(g.total)}</p>
            </div>
            {old && (
              <p className="mt-2 rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-ink-2">
                Still not resolved? In your UPI app, open this payment and use Help or Raise a complaint. Banks must return failed UPI payments, usually by the next working day.
              </p>
            )}
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              <Button size="sm" variant="secondary" loading={busy === g.key} icon={<Check className="size-4 text-pos" />} onClick={() => resolve(g, 'done')}>
                Went through
              </Button>
              <Button size="sm" variant="secondary" disabled={busy === g.key} icon={<Undo2 className="size-4 text-ink-3" />} onClick={() => resolve(g, 'refunded')}>
                Refunded
              </Button>
            </div>
          </div>
        )
      })}
    </motion.section>
  )
}
