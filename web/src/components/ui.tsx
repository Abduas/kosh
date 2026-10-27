import clsx from 'clsx'
import { motion } from 'motion/react'
import { LoaderCircle, ChevronRight, ChevronLeft } from 'lucide-react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'
import { goBack } from '../lib/router'

export const cn = clsx

// ---- Buttons ----

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'contrast'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cn(
        'press relative inline-flex items-center justify-center gap-2 rounded-2xl font-semibold tracking-tight disabled:opacity-50 disabled:active:scale-100',
        size === 'sm' && 'h-9 px-3.5 text-[13px]',
        size === 'md' && 'h-11 px-4 text-[15px]',
        size === 'lg' && 'h-14 px-6 text-base',
        variant === 'primary' && 'bg-accent text-white shadow-[0_8px_24px_-10px_var(--accent)]',
        variant === 'secondary' && 'bg-surface-2 text-ink hover:bg-surface-3',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'bg-neg/10 text-neg hover:bg-neg/15',
        variant === 'contrast' && 'bg-ink text-bg',
        className,
      )}
    >
      {loading ? <LoaderCircle className="size-5 animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ className, children, label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={cn('press grid size-10 shrink-0 place-items-center rounded-full text-ink-2 hover:bg-surface-2 hover:text-ink', className)}
    >
      {children}
    </button>
  )
}

// ---- Layout ----

export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} className={cn('block w-full rounded-[22px] bg-surface text-left shadow-card', onClick && 'press', className)}>
      {children}
    </Comp>
  )
}

export function SectionTitle({ title, action, className }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2.5 mt-7 flex items-center justify-between px-1', className)}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{title}</h2>
      {action}
    </div>
  )
}

export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="press flex items-center gap-0.5 text-[13px] font-semibold text-accent">
      {children}
      <ChevronRight className="size-4" />
    </button>
  )
}

/** iOS-style large title header with an optional back button and actions. */
export function ScreenHeader({ title, subtitle, back, actions }: { title: ReactNode; subtitle?: ReactNode; back?: string; actions?: ReactNode }) {
  return (
    <header className="mb-4 pt-2">
      {(back || actions) && (
        <div className="-mx-2 mb-1 flex h-10 items-center justify-between">
          {back ? (
            <button onClick={() => goBack(back)} className="press flex items-center gap-0.5 rounded-full px-2 py-2 text-[15px] font-medium text-accent">
              <ChevronLeft className="size-5" /> Back
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">{actions}</div>
        </div>
      )}
      <h1 className="text-[32px] font-bold leading-tight tracking-[-0.03em]">{title}</h1>
      {subtitle && <p className="mt-0.5 text-[15px] text-ink-2">{subtitle}</p>}
    </header>
  )
}

// ---- Inputs ----

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block px-1 text-[13px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block px-1 text-xs text-ink-3">{hint}</span>}
    </label>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={cn(
        'h-12 w-full rounded-2xl border border-transparent bg-surface-2 px-4 text-[15px] outline-none transition placeholder:text-ink-3 focus:border-accent/50 focus:bg-surface focus:ring-4 focus:ring-accent/10',
        className,
      )}
    />
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-[31px] w-[51px] shrink-0 rounded-full transition-colors duration-300', checked ? 'bg-accent' : 'bg-surface-3')}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 700, damping: 35 }}
        className={cn('absolute top-[2px] size-[27px] rounded-full bg-white shadow-md', checked ? 'right-[2px]' : 'left-[2px]')}
      />
    </button>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  id,
  size = 'md',
  className,
}: {
  options: { value: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  id: string
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div className={cn('flex rounded-2xl bg-surface-2 p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'relative flex-1 rounded-xl font-semibold transition-colors',
            size === 'sm' ? 'h-8 text-[13px]' : 'h-9 text-[14px]',
            value === o.value ? 'text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} transition={{ type: 'spring', stiffness: 500, damping: 38 }} className="absolute inset-0 rounded-xl bg-surface shadow-card dark:bg-surface-3" />
          )}
          <span className="relative z-10 flex items-center justify-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export function Chip({ active, onClick, children, color, className }: { active?: boolean; onClick?: () => void; children: ReactNode; color?: string; className?: string }) {
  return (
    <button
      onClick={onClick}
      style={active && color ? { backgroundColor: color + '22', color, boxShadow: `inset 0 0 0 1.5px ${color}` } : undefined}
      className={cn(
        'press inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-[13px] font-semibold transition-colors',
        active ? (color ? '' : 'bg-ink text-bg') : 'bg-surface-2 text-ink-2 hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ---- Visual atoms ----

/** An emoji in a softly tinted rounded square: categories and accounts. */
export function Glyph({ icon, color, size = 40, className }: { icon: string; color: string; size?: number; className?: string }) {
  return (
    <span
      className={cn('grid shrink-0 place-items-center', className)}
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.34,
        background: `linear-gradient(145deg, ${color}2E, ${color}14)`,
        boxShadow: `inset 0 0 0 1px ${color}22`,
        fontSize: size * 0.5,
        lineHeight: 1,
      }}
    >
      {icon}
    </span>
  )
}

export function Avatar({ name, color, size = 40, className }: { name: string; color: string; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('')
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(145deg, ${color}, color-mix(in oklab, ${color} 70%, black))` }}
    >
      {initials || '?'}
    </span>
  )
}

export function ProgressBar({ value, max, color, className }: { value: number; max: number; color?: string; className?: string }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0
  const over = value > max
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-surface-3', className)}>
      <motion.div
        initial={{ width: 0 }}
        animate={{ width: `${pct * 100}%` }}
        transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1] }}
        className="h-full rounded-full"
        style={{ background: over ? 'var(--neg)' : (color ?? 'var(--accent)') }}
      />
    </div>
  )
}

export function EmptyState({ icon, title, body, action, className }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center px-6 py-12 text-center', className)}>
      <div className="mb-4 grid size-16 place-items-center rounded-[22px] bg-accent/10 text-accent">{icon}</div>
      <p className="text-[17px] font-semibold tracking-tight">{title}</p>
      {body && <p className="mt-1 max-w-[280px] text-[14px] leading-relaxed text-ink-2">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-xl bg-surface-3/70', className)} />
}

export function ListRow({
  left,
  title,
  subtitle,
  right,
  onClick,
  chevron,
  className,
}: {
  left?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  right?: ReactNode
  onClick?: () => void
  chevron?: boolean
  className?: string
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} className={cn('flex w-full items-center gap-3 px-4 py-3 text-left', onClick && 'transition-colors hover:bg-surface-2/60 active:bg-surface-2', className)}>
      {left}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium tracking-tight">{title}</div>
        {subtitle && <div className="truncate text-[13px] text-ink-3">{subtitle}</div>}
      </div>
      {right}
      {chevron && <ChevronRight className="size-4 shrink-0 text-ink-3" />}
    </Comp>
  )
}

export function Divider({ inset = 68 }: { inset?: number }) {
  return <div className="h-px bg-line" style={{ marginLeft: inset }} />
}
