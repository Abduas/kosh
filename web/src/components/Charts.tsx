import { motion } from 'motion/react'
import { useId, useMemo, useRef, useState, type ReactNode, type PointerEvent } from 'react'
import { cn } from './ui'

// ---- Donut ----

export type DonutSlice = { id: string | number; value: number; color: string }

/** A ring split by value, with rounded gaps between slices. Tap a slice to focus it. */
export function Donut({
  slices,
  size = 210,
  thickness = 22,
  selected,
  onSelect,
  children,
}: {
  slices: DonutSlice[]
  size?: number
  thickness?: number
  selected?: string | number | null
  onSelect?: (id: string | number | null) => void
  children?: ReactNode
}) {
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const total = slices.reduce((s, x) => s + x.value, 0)
  const gap = slices.length > 1 ? 3 : 0

  let offset = 0
  const arcs = slices.map((s) => {
    const len = total ? (s.value / total) * c : 0
    const arc = { ...s, start: offset, len: Math.max(0.5, len - gap) }
    offset += len
    return arc
  })

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90 overflow-visible">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={thickness} opacity={total ? 0.35 : 1} />
        {arcs.map((a, i) => {
          const dim = selected != null && selected !== a.id
          return (
            <motion.circle
              key={a.id}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={a.color}
              strokeLinecap="butt"
              initial={{ strokeDasharray: `0 ${c}`, strokeWidth: thickness }}
              animate={{
                strokeDasharray: `${a.len} ${c - a.len}`,
                strokeDashoffset: -a.start - gap / 2,
                opacity: dim ? 0.25 : 1,
                strokeWidth: selected === a.id ? thickness + 6 : thickness,
              }}
              transition={{ duration: 0.9, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
              onClick={() => onSelect?.(selected === a.id ? null : a.id)}
              className={onSelect ? 'cursor-pointer' : undefined}
            />
          )
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  )
}

// ---- Bars ----

export type Bar = { key: string; label: string; value: number; secondary?: number }

/** Vertical bars. Tapping one selects it; the parent shows the details. */
export function Bars({
  bars,
  height = 150,
  selected,
  onSelect,
  color = 'var(--accent)',
  labelEvery = 1,
  highlightKey,
  average,
}: {
  bars: Bar[]
  height?: number
  selected: number | null
  onSelect: (i: number | null) => void
  color?: string
  labelEvery?: number
  highlightKey?: string
  average?: number
}) {
  const max = Math.max(1, ...bars.map((b) => Math.max(b.value, b.secondary ?? 0)))
  return (
    <div>
      <div className="relative flex items-end gap-[3px]" style={{ height }}>
        {average != null && average > 0 && (
          <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-ink-3/40" style={{ bottom: (average / max) * height }}>
            <span className="absolute -top-4 right-0 text-[10px] font-semibold uppercase tracking-wide text-ink-3">avg</span>
          </div>
        )}
        {bars.map((b, i) => {
          const h = b.value > 0 ? Math.max(4, (b.value / max) * height) : 3
          const active = selected === i
          const dim = selected != null && !active
          return (
            <button key={b.key} onClick={() => onSelect(active ? null : i)} className="relative flex h-full flex-1 items-end justify-center" aria-label={b.label}>
              <motion.span
                initial={{ scaleY: 0 }}
                animate={{ scaleY: 1, opacity: dim ? 0.35 : 1 }}
                transition={{ duration: 0.7, delay: Math.min(i * 0.012, 0.4), ease: [0.16, 1, 0.3, 1] }}
                style={{
                  height: h,
                  originY: 1,
                  background: b.value > 0 ? (b.key === highlightKey && !active ? `color-mix(in oklab, ${color} 55%, transparent)` : color) : 'var(--surface-3)',
                }}
                className="block w-full max-w-[22px] rounded-[5px]"
              />
            </button>
          )
        })}
      </div>
      <div className="mt-2 flex gap-[3px]">
        {bars.map((b, i) => (
          <span key={b.key} className={cn('relative h-3 flex-1 text-[10px] font-medium text-ink-3', selected === i && 'text-ink')}>
            {(i % labelEvery === 0 || selected === i) && <span className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap">{b.label}</span>}
          </span>
        ))}
      </div>
    </div>
  )
}

// ---- Area line with scrubbing ----

function smoothPath(pts: [number, number][]): string {
  if (pts.length < 2) return ''
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[Math.max(0, i - 1)]
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[i + 1]
    const [x3, y3] = pts[Math.min(pts.length - 1, i + 2)]
    const t = 0.18
    d += ` C${x1 + (x2 - x0) * t},${y1 + (y2 - y0) * t} ${x2 - (x3 - x1) * t},${y2 - (y3 - y1) * t} ${x2},${y2}`
  }
  return d
}

/** A smooth line with a soft fill. Drag across it to scrub through values. */
export function AreaLine({
  values,
  height = 64,
  stroke = 'currentColor',
  onScrub,
  className,
}: {
  values: number[]
  height?: number
  stroke?: string
  onScrub?: (index: number | null) => void
  className?: string
}) {
  const id = useId().replace(/:/g, '')
  const ref = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)
  const W = 300
  const pad = 4
  const { line, area, pts } = useMemo(() => {
    const min = Math.min(...values)
    const max = Math.max(...values)
    const span = max - min || 1
    const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * W, pad + (1 - (v - min) / span) * (height - pad * 2)] as [number, number])
    const line = smoothPath(pts)
    return { line, area: `${line} L${W},${height} L0,${height} Z`, pts }
  }, [values, height])

  if (values.length < 2) return null

  const move = (e: PointerEvent) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const i = Math.round(((e.clientX - box.left) / box.width) * (values.length - 1))
    const clamped = Math.max(0, Math.min(values.length - 1, i))
    setHover(clamped)
    onScrub?.(clamped)
  }
  const leave = () => {
    setHover(null)
    onScrub?.(null)
  }

  return (
    <div className={cn('relative', className)} style={{ height }}>
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      className="h-full w-full touch-pan-y overflow-visible"
      onPointerMove={onScrub ? move : undefined}
      onPointerDown={onScrub ? move : undefined}
      onPointerLeave={onScrub ? leave : undefined}
      onPointerUp={onScrub ? leave : undefined}
      onPointerCancel={onScrub ? leave : undefined}
    >
      <defs>
        <linearGradient id={`fill-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="1" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <motion.path d={area} fill={`url(#fill-${id})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.3 }} />
      <motion.path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2.2}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
      />
    </svg>
      {hover != null && (
        <div className="pointer-events-none absolute inset-y-0" style={{ left: `${(pts[hover][0] / W) * 100}%` }}>
          <div className="absolute inset-y-0 w-px -translate-x-1/2 opacity-40" style={{ background: stroke }} />
          <div className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-white/25" style={{ top: pts[hover][1], background: stroke }} />
        </div>
      )}
    </div>
  )
}
