import { animate, motion, useMotionValue, useTransform, type PanInfo } from 'motion/react'
import { ArrowLeftRight, Trash2, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Transaction } from '../lib/api'
import { dayLabel, timeLabel } from '../lib/format'
import { haptic } from '../lib/look'
import { useData, useDeleteTx, type Data } from '../lib/queries'
import { editTransaction } from '../lib/store'
import { describeTx, isPersonKind, txSign } from '../lib/tx'
import { Amount } from './Money'
import { Avatar, Glyph, cn } from './ui'

export function TxIcon({ t, d, size = 42 }: { t: Transaction; d: Data; size?: number }) {
  if (isPersonKind(t.kind)) {
    const p = d.peopleById.get(t.personId ?? 0)
    const out = t.kind === 'lend' || t.kind === 'repay'
    return (
      <span className="relative shrink-0">
        <Avatar name={p?.name ?? '?'} color={p?.color ?? '#64748B'} size={size} />
        <span
          className={cn('absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full border-2 border-surface text-[10px] font-bold text-white', out ? 'bg-lend' : 'bg-pos')}
        >
          {out ? '↑' : '↓'}
        </span>
      </span>
    )
  }
  if (t.kind === 'transfer') {
    return (
      <span className="grid shrink-0 place-items-center bg-accent/12 text-accent" style={{ width: size, height: size, borderRadius: size * 0.34 }}>
        <ArrowLeftRight className="size-[45%]" strokeWidth={2.2} />
      </span>
    )
  }
  const c = t.categoryId ? d.categoriesById.get(t.categoryId) : undefined
  return <Glyph icon={c?.icon ?? (t.kind === 'income' ? '💰' : '🧾')} color={c?.color ?? '#94A3B8'} size={size} />
}

export function TxAmount({ t, accountId, className }: { t: Transaction; accountId?: number; className?: string }) {
  const sign = txSign(t, accountId)
  const value = sign === 0 ? t.amount : sign * t.amount
  const person = isPersonKind(t.kind)
  return (
    <Amount
      value={value}
      sign={sign !== 0}
      tone={sign > 0 ? 'pos' : 'none'}
      className={cn('font-rounded text-[16px] font-semibold tracking-tight', person && sign < 0 && 'text-lend', sign === 0 && 'text-ink-2', className)}
    />
  )
}

const OPEN_X = -88
/** Closes the row whose Delete button is showing, so only one is ever open. */
let closeOpenRow: (() => void) | null = null

/**
 * One transaction. Tap to edit; swipe left to show a Delete button.
 * A swipe never deletes by itself, however fast or far: on a phone a quick
 * sideways flick happens by accident while scrolling or switching pages, so
 * deleting always takes a tap on the revealed button (and the toast has Undo).
 */
export function TxRow({ t, accountId, showDate }: { t: Transaction; accountId?: number; showDate?: boolean }) {
  const d = useData()
  const del = useDeleteTx()
  const x = useMotionValue(0)
  const [open, setOpen] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  const dragged = useRef(false) // a swipe must not also count as a tap
  const reveal = useTransform(x, [OPEN_X, -20, 0], [1, 0.4, 0])
  const { title, subtitle } = describeTx(t, d)

  const settle = (to: number) => animate(x, to, { type: 'spring', stiffness: 500, damping: 40 })
  const close = () => {
    setOpen(false)
    settle(0)
  }
  const onDragEnd = (_: unknown, info: PanInfo) => {
    // Where the row would come to rest: a flick helps open or close it, nothing more.
    const rest = x.get() + info.velocity.x * 0.1
    if (rest < OPEN_X / 2) {
      setOpen(true)
      settle(OPEN_X)
    } else close()
  }

  // While open: any touch outside this row, or any scroll, closes it, so a
  // forgotten Delete button can't catch a stray tap later.
  useEffect(() => {
    if (!open) return
    closeOpenRow?.()
    closeOpenRow = close
    const outside = (e: PointerEvent) => {
      if (!row.current?.contains(e.target as Node)) close()
    }
    const scrolled = () => close()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', scrolled, { capture: true, passive: true })
    return () => {
      if (closeOpenRow === close) closeOpenRow = null
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', scrolled, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return (
    <div ref={row} className="relative overflow-hidden rounded-2xl">
      <motion.button
        style={{ opacity: reveal }}
        tabIndex={open ? 0 : -1}
        onClick={() => {
          if (!open || del.isPending) return
          haptic(12)
          del.mutate(t)
        }}
        className={cn(
          'absolute inset-y-0 right-0 flex w-[88px] flex-col items-center justify-center gap-0.5 rounded-2xl bg-neg text-[12px] font-semibold text-white',
          !open && 'pointer-events-none',
        )}
        aria-label="Delete transaction"
        aria-hidden={!open}
      >
        <Trash2 className="size-5" />
        Delete
      </motion.button>
      <motion.div
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: OPEN_X, right: 0 }}
        dragElastic={{ left: 0.15, right: 0 }}
        dragMomentum={false}
        onPointerDown={() => (dragged.current = false)}
        onDragStart={() => (dragged.current = true)}
        onDragEnd={onDragEnd}
        style={{ x, touchAction: 'pan-y' }}
        onTap={() => {
          if (dragged.current) return
          if (open) close()
          else editTransaction(t)
        }}
        className="relative flex cursor-pointer items-center gap-3.5 bg-bg px-1 py-2.5 transition-colors hover:bg-surface/60"
      >
        <TxIcon t={t} d={d} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-medium tracking-tight">{title}</div>
          <div className="truncate text-[13px] text-ink-3">{showDate ? `${dayLabel(t.occurredAt.slice(0, 10))} · ${subtitle}` : subtitle}</div>
        </div>
        <div className="flex flex-col items-end">
          <TxAmount t={t} accountId={accountId} />
          <span className="text-[11px] font-medium text-ink-3">{timeLabel(t.occurredAt)}</span>
        </div>
      </motion.div>
    </div>
  )
}

/** Transactions grouped into days, each with its net total, loading more as you scroll. */
export function TxList({
  items,
  accountId,
  hasMore,
  loadingMore,
  onLoadMore,
  empty,
  stickyHeaders = true,
}: {
  items: Transaction[]
  stickyHeaders?: boolean
  accountId?: number
  hasMore?: boolean
  loadingMore?: boolean
  onLoadMore?: () => void
  empty?: ReactNode
}) {
  const groups = useMemo(() => {
    const out: { day: string; items: Transaction[]; net: number }[] = []
    for (const t of items) {
      const day = t.occurredAt.slice(0, 10)
      let g = out[out.length - 1]
      if (!g || g.day !== day) {
        g = { day, items: [], net: 0 }
        out.push(g)
      }
      g.items.push(t)
      if (t.kind === 'expense') g.net -= t.amount
      if (t.kind === 'income') g.net += t.amount
    }
    return out
  }, [items])

  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!hasMore || !onLoadMore || !sentinel.current) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && onLoadMore(), { rootMargin: '600px' })
    io.observe(sentinel.current)
    return () => io.disconnect()
  }, [hasMore, onLoadMore])

  if (items.length === 0) return <>{empty}</>

  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <section key={g.day}>
          <div className={cn(stickyHeaders && 'sticky top-0 z-10', 'mb-1 flex items-center justify-between border-b border-line bg-bg/90 px-1 pb-1.5 pt-1 backdrop-blur-xl')}>
            <h3 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">{dayLabel(g.day)}</h3>
            {g.net !== 0 && <Amount value={g.net} sign tone={g.net > 0 ? 'pos' : 'none'} className="font-rounded text-[12px] font-semibold text-ink-3" />}
          </div>
          <div>
            {g.items.map((t) => (
              <TxRow key={t.id} t={t} accountId={accountId} />
            ))}
          </div>
        </section>
      ))}
      <div ref={sentinel} className="flex h-10 items-center justify-center">
        {loadingMore && <LoaderCircle className="size-5 animate-spin text-ink-3" />}
      </div>
    </div>
  )
}
