import { animate, useMotionValue, useMotionValueEvent } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { money, moneyParts } from '../lib/format'
import { privacy } from '../lib/store'
import { cn } from './ui'

/**
 * An amount of money. tone colours it (green in, red out); sign adds + or −.
 * Every amount respects privacy mode.
 */
export function Amount({
  value,
  sign,
  tone,
  compact,
  className,
}: {
  value: number
  sign?: boolean
  tone?: 'auto' | 'pos' | 'neg' | 'none'
  compact?: boolean
  className?: string
}) {
  const hidden = privacy.use((s) => s.hidden)
  const t = tone === 'auto' ? (value > 0 ? 'pos' : value < 0 ? 'neg' : 'none') : tone
  return (
    <span className={cn('font-rounded tnum whitespace-nowrap', t === 'pos' && 'text-pos', t === 'neg' && 'text-neg', hidden && 'privacy-blur select-none', className)}>
      {money(value, { sign, compact })}
    </span>
  )
}

/** A large balance: small currency symbol and paise, big rupees. Counts up when it changes. */
export function BigAmount({ value, className, fractionClassName }: { value: number; className?: string; fractionClassName?: string }) {
  const hidden = privacy.use((s) => s.hidden)
  const mv = useMotionValue(value)
  const [shown, setShown] = useState(value)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      mv.set(value)
      setShown(value)
      return
    }
    const controls = animate(mv, value, { duration: 0.8, ease: [0.16, 1, 0.3, 1] })
    return () => controls.stop()
  }, [value, mv])
  useMotionValueEvent(mv, 'change', (v) => setShown(Math.round(v)))

  const p = moneyParts(shown)
  return (
    <span className={cn('font-rounded tnum inline-flex items-baseline whitespace-nowrap', hidden && 'privacy-blur select-none', className)}>
      {p.negative && <span>−</span>}
      <span className="mr-0.5 text-[0.55em] font-semibold opacity-80">{p.symbol}</span>
      <span>{p.whole}</span>
      {p.fraction !== '00' && <span className={cn('text-[0.5em] font-semibold opacity-70', fractionClassName)}>.{p.fraction}</span>}
    </span>
  )
}
