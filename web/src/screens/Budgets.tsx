import { addMonths, differenceInCalendarDays } from 'date-fns'
import { ChevronLeft, ChevronRight, Plus, Target, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Donut } from '../components/Charts'
import { MoneyInput } from '../components/Forms'
import { Amount, BigAmount } from '../components/Money'
import { Sheet } from '../components/Sheet'
import { Button, Card, EmptyState, Field, Glyph, IconButton, ProgressBar, ScreenHeader, SectionTitle, cn } from '../components/ui'
import type { Budget } from '../lib/api'
import { money, monthPeriod, percent } from '../lib/format'
import { useBudgets, useData, useDeleteBudget, useSetBudget } from '../lib/queries'

export function Budgets() {
  const d = useData()
  const monthStart = d.user.prefs.monthStart ?? 1
  const [anchor, setAnchor] = useState(new Date())
  const month = monthPeriod(anchor, monthStart)
  const isCurrent = month.from === monthPeriod(new Date(), monthStart).from
  const q = useBudgets(month.from)
  const shift = (n: number) => setAnchor(addMonths(month.start, n))
  const [editing, setEditing] = useState<{ categoryId: number | null; budget?: Budget } | null>(null)
  const [picking, setPicking] = useState(false)

  const budgets = q.data ?? []
  const overall = budgets.find((b) => b.categoryId === null)
  const perCategory = budgets.filter((b) => b.categoryId !== null)
  const daysLeft = isCurrent ? differenceInCalendarDays(month.end, new Date()) + 1 : 0
  const usedIds = new Set(perCategory.map((b) => b.categoryId))
  const available = d.categories.filter((c) => c.kind === 'expense' && !c.archived && !usedIds.has(c.id))

  return (
    <div>
      <ScreenHeader
        title="Budgets"
        back="/insights"
        actions={
          <IconButton label="Add budget" onClick={() => setPicking(true)} className="bg-surface shadow-card">
            <Plus className="size-5" />
          </IconButton>
        }
      />

      <div className="mb-4 flex items-center justify-between">
        <button onClick={() => shift(-1)} aria-label="Previous month" className="press grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface">
          <ChevronLeft className="size-5" />
        </button>
        <p className="text-[15px] font-semibold">{month.label}</p>
        <button onClick={() => shift(1)} disabled={isCurrent} aria-label="Next month" className={cn('press grid size-10 place-items-center rounded-full text-ink-2 hover:bg-surface', isCurrent && 'opacity-30')}>
          <ChevronRight className="size-5" />
        </button>
      </div>

      {overall ? (
        <Card className="p-5" onClick={() => setEditing({ categoryId: null, budget: overall })}>
          <div className="flex items-center gap-5">
            <Donut
              size={128}
              thickness={14}
              slices={[
                { id: 'spent', value: Math.min(overall.spent, overall.amount), color: overall.spent > overall.amount ? 'var(--neg)' : 'var(--accent)' },
                { id: 'left', value: Math.max(0, overall.amount - overall.spent), color: 'transparent' },
              ]}
            >
              <div>
                <p className="text-[22px] font-bold tracking-tight">{percent(overall.spent, overall.amount)}%</p>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">used</p>
              </div>
            </Donut>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{overall.spent > overall.amount ? 'Over budget by' : 'Left to spend'}</p>
              <div className={cn('text-[30px] font-bold leading-tight tracking-[-0.03em]', overall.spent > overall.amount && 'text-neg')}>
                <BigAmount value={Math.abs(overall.amount - overall.spent)} />
              </div>
              <p className="text-[13px] text-ink-2">
                <Amount value={overall.spent} /> of <Amount value={overall.amount} />
              </p>
              {isCurrent && overall.spent < overall.amount && (
                <p className="mt-2 inline-flex rounded-full bg-pos/10 px-2.5 py-1 text-[12px] font-semibold text-pos">
                  {money(Math.floor((overall.amount - overall.spent) / daysLeft / 100) * 100)}/day for {daysLeft} days
                </p>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="p-1">
          <EmptyState
            icon={<Target className="size-7" />}
            title="Set a monthly budget"
            body="One number for the whole month. Kosh tells you how much is safe to spend each day."
            action={<Button onClick={() => setEditing({ categoryId: null })}>Set monthly budget</Button>}
            className="py-8"
          />
        </Card>
      )}

      <SectionTitle title="By category" action={available.length > 0 && <button onClick={() => setPicking(true)} className="press text-[13px] font-semibold text-accent">Add</button>} />
      {perCategory.length === 0 ? (
        <p className="rounded-[22px] bg-surface px-5 py-6 text-center text-[14px] text-ink-3 shadow-card">Add limits for categories you want to watch, like food or shopping.</p>
      ) : (
        <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
          {perCategory.map((b, i) => {
            const c = d.categoriesById.get(b.categoryId!)
            if (!c) return null
            const over = b.spent > b.amount
            return (
              <button key={b.id} onClick={() => setEditing({ categoryId: c.id, budget: b })} className={cn('flex w-full items-center gap-3 px-4 py-3.5 text-left hover:bg-surface-2/60', i > 0 && 'border-t border-line')}>
                <Glyph icon={c.icon} color={c.color} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[15px] font-medium">{c.name}</span>
                    <span className={cn('text-[13px] font-semibold', over ? 'text-neg' : 'text-ink-2')}>
                      {over ? 'Over by ' : ''}
                      <Amount value={over ? b.spent - b.amount : b.amount - b.spent} /> {over ? '' : 'left'}
                    </span>
                  </div>
                  <ProgressBar value={b.spent} max={b.amount} color={c.color} className="mt-2" />
                  <p className="mt-1 text-[11px] font-medium text-ink-3">
                    <Amount value={b.spent} /> of <Amount value={b.amount} />
                  </p>
                </div>
              </button>
            )
          })}
        </div>
      )}

      <Sheet open={picking} onOpenChange={setPicking} title="Budget for…">
        <div className="grid grid-cols-4 gap-2">
          {!overall && (
            <button onClick={() => { setPicking(false); setEditing({ categoryId: null }) }} className="press flex flex-col items-center gap-1.5 rounded-2xl p-2 hover:bg-surface-2">
              <Glyph icon="🎯" color="#7C5CFF" size={46} />
              <span className="text-[11px] font-medium text-ink-2">Whole month</span>
            </button>
          )}
          {available.map((c) => (
            <button key={c.id} onClick={() => { setPicking(false); setEditing({ categoryId: c.id }) }} className="press flex flex-col items-center gap-1.5 rounded-2xl p-2 hover:bg-surface-2">
              <Glyph icon={c.icon} color={c.color} size={46} />
              <span className="line-clamp-1 text-[11px] font-medium text-ink-2">{c.name}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <BudgetSheet target={editing} onClose={() => setEditing(null)} />
    </div>
  )
}

function BudgetSheet({ target, onClose }: { target: { categoryId: number | null; budget?: Budget } | null; onClose: () => void }) {
  const d = useData()
  const c = target?.categoryId ? d.categoriesById.get(target.categoryId) : undefined
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()} title={c ? `${c.icon} ${c.name}` : 'Monthly budget'} description="How much can you spend in a month?">
      {target && <BudgetForm key={target.categoryId ?? 0} target={target} onDone={onClose} />}
    </Sheet>
  )
}

function BudgetForm({ target, onDone }: { target: { categoryId: number | null; budget?: Budget }; onDone: () => void }) {
  const set = useSetBudget()
  const del = useDeleteBudget()
  const [amount, setAmount] = useState(target.budget?.amount ?? 0)
  return (
    <div className="space-y-5">
      <Field label="Monthly limit">
        <MoneyInput value={amount} onChange={setAmount} placeholder="10000" />
      </Field>
      <Button size="lg" className="w-full" loading={set.isPending} disabled={amount <= 0} onClick={() => set.mutate({ categoryId: target.categoryId, amount }, { onSuccess: onDone })}>
        Save budget
      </Button>
      {target.budget && (
        <Button variant="danger" className="w-full" icon={<Trash2 className="size-4" />} onClick={() => del.mutate(target.budget!.id, { onSuccess: onDone })}>
          Remove budget
        </Button>
      )}
    </div>
  )
}
