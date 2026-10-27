import { motion } from 'motion/react'
import { ArrowDownLeft, ArrowUpRight, Eye, EyeOff, HandCoins, Plus, ScanLine, Settings as SettingsIcon, Sparkles, Target } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AreaLine } from '../components/Charts'
import { AccountSheet } from '../components/Forms'
import { PendingPayments } from '../components/PendingPayments'
import { Amount, BigAmount } from '../components/Money'
import { TxList } from '../components/TxList'
import { Avatar, Card, EmptyState, Glyph, IconButton, ProgressBar, SectionTitle, Skeleton, TextLink, cn } from '../components/ui'
import { greeting, money, shortDate, ymd } from '../lib/format'
import { haptic } from '../lib/look'
import { useBalanceHistory, useBudgets, useData, useInsights, useTransactions } from '../lib/queries'
import { navigate } from '../lib/router'
import { openComposer, openScanner, privacy, togglePrivacy } from '../lib/store'

function monthRange(d = new Date()) {
  return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)), month: ymd(d).slice(0, 7) }
}

export function Home() {
  const d = useData()
  const hidden = privacy.use((s) => s.hidden)
  const [addAccount, setAddAccount] = useState(false)
  const m = monthRange()
  const history = useBalanceHistory(30)
  const month = useInsights(m.from, m.to)
  const recent = useTransactions({}, 8)
  const budgets = useBudgets(m.month)
  const [scrub, setScrub] = useState<number | null>(null)

  const points = history.data ?? []
  const shown = scrub != null && points[scrub] ? points[scrub] : null
  const change = points.length > 1 ? points[points.length - 1].balance - points[0].balance : 0
  const recentItems = recent.data?.pages[0]?.items ?? []
  const overall = budgets.data?.find((b) => b.categoryId === null)

  const topPeople = useMemo(() => d.people.filter((p) => p.balance !== 0 && !p.archived).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)), [d.people])

  return (
    <div>
      {/* Greeting */}
      <header className="flex items-center justify-between pb-4 pt-2">
        <div>
          <p className="text-[14px] font-medium text-ink-3">{greeting()}</p>
          <h1 className="text-[26px] font-bold tracking-[-0.03em]">{d.user.name.split(' ')[0]}</h1>
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={hidden ? 'Show amounts' : 'Hide amounts'} onClick={() => { haptic(); togglePrivacy() }} className="bg-surface shadow-card">
            {hidden ? <EyeOff className="size-[19px]" /> : <Eye className="size-[19px]" />}
          </IconButton>
          <IconButton label="Settings" onClick={() => navigate('/settings')} className="bg-surface shadow-card md:hidden">
            <SettingsIcon className="size-[19px]" />
          </IconButton>
        </div>
      </header>

      {/* Balance hero */}
      <motion.div initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} className="hero-surface rounded-[30px] p-5 pb-4 shadow-[0_24px_50px_-24px_var(--accent)]">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-semibold text-white/75">{shown ? shortDate(shown.date) : 'Total balance'}</p>
          {!shown && change !== 0 && points.length > 1 && (
            <span className="flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[12px] font-semibold backdrop-blur">
              {change > 0 ? <ArrowUpRight className="size-3.5" /> : <ArrowDownLeft className="size-3.5" />}
              <span className={cn('tnum', hidden && 'privacy-blur')}>{money(Math.abs(change), { compact: true })}</span>
              <span className="text-white/60">30d</span>
            </span>
          )}
        </div>
        <div className="mt-1 text-[44px] font-bold leading-none tracking-[-0.04em]">
          <BigAmount value={shown ? shown.balance : d.totalBalance} />
        </div>
        <div className="-mx-1 mt-4 text-white">
          {points.length > 1 ? <AreaLine values={points.map((p) => p.balance)} height={56} stroke="#ffffff" onScrub={setScrub} /> : <div className="h-14" />}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-white/12 px-3 py-2.5 backdrop-blur-sm">
            <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-white/65">
              <ArrowDownLeft className="size-3.5" /> In · {new Date().toLocaleString('en', { month: 'short' })}
            </p>
            <Amount value={month.data?.totals.income ?? 0} className="text-[17px] font-bold text-white" />
          </div>
          <div className="rounded-2xl bg-white/12 px-3 py-2.5 backdrop-blur-sm">
            <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-white/65">
              <ArrowUpRight className="size-3.5" /> Out · {new Date().toLocaleString('en', { month: 'short' })}
            </p>
            <Amount value={month.data?.totals.expense ?? 0} className="text-[17px] font-bold text-white" />
          </div>
        </div>
      </motion.div>

      {/* Quick actions */}
      <div className="mt-5 grid grid-cols-4 gap-2">
        {[
          { label: 'Scan & pay', icon: ScanLine, kind: 'scan' as const, color: 'var(--accent)' },
          { label: 'Expense', icon: ArrowUpRight, kind: 'expense' as const, color: 'var(--neg)' },
          { label: 'Income', icon: ArrowDownLeft, kind: 'income' as const, color: 'var(--pos)' },
          { label: 'Lend', icon: HandCoins, kind: 'lend' as const, color: 'var(--lend)' },
        ].map((a, i) => (
          <motion.button
            key={a.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.08 + i * 0.04, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            whileTap={{ scale: 0.94 }}
            onClick={() => { haptic(); if (a.kind === 'scan') openScanner(); else openComposer({ kind: a.kind }) }}
            className="flex flex-col items-center gap-1.5 rounded-[20px] bg-surface py-3 shadow-card"
          >
            <span className="grid size-10 place-items-center rounded-[14px]" style={{ background: `color-mix(in oklab, ${a.color} 14%, transparent)`, color: a.color }}>
              <a.icon className="size-5" strokeWidth={2.3} />
            </span>
            <span className="text-[12px] font-semibold text-ink-2">{a.label}</span>
          </motion.button>
        ))}
      </div>

      <PendingPayments />

      {/* Accounts */}
      <SectionTitle title="Accounts" action={<TextLink onClick={() => navigate('/accounts')}>See all</TextLink>} />
      <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 md:-mx-8 md:px-8">
        {d.activeAccounts.map((a, i) => (
          <motion.button
            key={a.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.04, duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            whileTap={{ scale: 0.97 }}
            onClick={() => navigate(`/accounts/${a.id}`)}
            className="relative w-[168px] shrink-0 snap-start overflow-hidden rounded-[24px] bg-surface p-4 text-left shadow-card"
          >
            <div className="pointer-events-none absolute -right-8 -top-10 size-28 rounded-full opacity-25 blur-2xl" style={{ background: a.color }} />
            <div className="flex items-center justify-between">
              <Glyph icon={a.icon} color={a.color} size={36} />
              {a.last4 && <span className="text-[11px] font-semibold tracking-wider text-ink-3">•• {a.last4}</span>}
            </div>
            <p className="mt-4 truncate text-[13px] font-medium text-ink-2">{a.name}</p>
            <Amount value={a.balance} className={cn('block text-[19px] font-bold tracking-tight', a.balance < 0 && 'text-neg')} />
          </motion.button>
        ))}
        <button onClick={() => setAddAccount(true)} className="press grid w-[120px] shrink-0 snap-start place-items-center rounded-[24px] border-2 border-dashed border-ink-3/25 text-ink-3">
          <span className="flex flex-col items-center gap-1 text-[13px] font-semibold">
            <Plus className="size-6" /> Add
          </span>
        </button>
      </div>

      {/* People */}
      <SectionTitle title="People" action={<TextLink onClick={() => navigate('/people')}>Open</TextLink>} />
      {topPeople.length > 0 ? (
        <Card onClick={() => navigate('/people')} className="p-4">
          <div className="grid grid-cols-2 divide-x divide-line">
            <div className="pr-4">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">You'll get</p>
              <Amount value={d.owedToMe} className="text-[22px] font-bold tracking-tight text-pos" />
            </div>
            <div className="pl-4">
              <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">You owe</p>
              <Amount value={d.iOwe} className={cn('text-[22px] font-bold tracking-tight', d.iOwe > 0 ? 'text-neg' : 'text-ink-3')} />
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3 border-t border-line pt-3">
            <div className="flex -space-x-2.5">
              {topPeople.slice(0, 5).map((p) => (
                <Avatar key={p.id} name={p.name} color={p.color} size={30} className="ring-[2.5px] ring-surface" />
              ))}
            </div>
            <p className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
              {topPeople[0].balance > 0 ? `${topPeople[0].name} owes you ` : `You owe ${topPeople[0].name} `}
              <Amount value={Math.abs(topPeople[0].balance)} className="font-semibold text-ink" />
              {topPeople.length > 1 && ` · +${topPeople.length - 1} more`}
            </p>
          </div>
        </Card>
      ) : (
        <Card onClick={() => openComposer({ kind: 'lend' })} className="flex items-center gap-4 p-4">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-lend/12 text-lend">
            <HandCoins className="size-6" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] font-semibold">Lent someone money?</p>
            <p className="text-[13px] text-ink-2">Track who owes you and settle up in a tap.</p>
          </div>
          <Plus className="size-5 text-ink-3" />
        </Card>
      )}

      {/* Budget */}
      {overall ? (
        <>
          <SectionTitle title="Budget" action={<TextLink onClick={() => navigate('/budgets')}>Details</TextLink>} />
          <Card onClick={() => navigate('/budgets')} className="p-4">
            <div className="flex items-baseline justify-between">
              <p className="text-[15px] font-semibold">
                <Amount value={Math.max(0, overall.amount - overall.spent)} /> <span className="font-medium text-ink-2">left this month</span>
              </p>
              <span className="text-[13px] font-medium text-ink-3">
                of <Amount value={overall.amount} />
              </span>
            </div>
            <ProgressBar value={overall.spent} max={overall.amount} className="mt-3" />
          </Card>
        </>
      ) : (
        d.activeAccounts.length > 0 &&
        recentItems.length > 3 && (
          <Card onClick={() => navigate('/budgets')} className="mt-4 flex items-center gap-4 p-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent/12 text-accent">
              <Target className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">Set a monthly budget</p>
              <p className="text-[13px] text-ink-2">See how much is safe to spend each day.</p>
            </div>
          </Card>
        )
      )}

      {/* Recent */}
      <SectionTitle title="Recent" action={recentItems.length > 0 && <TextLink onClick={() => navigate('/activity')}>See all</TextLink>} />
      {recent.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 rounded-[22px]" />
          ))}
        </div>
      ) : (
        <TxList
          items={recentItems}
          empty={
            <Card>
              <EmptyState
                icon={<Sparkles className="size-7" />}
                title="Your first entry"
                body="Tap + to add an expense. It takes two taps: amount, category, done."
                action={
                  <button onClick={() => openComposer()} className="press h-11 rounded-2xl bg-accent px-5 text-[15px] font-semibold text-white">
                    Add expense
                  </button>
                }
              />
            </Card>
          }
        />
      )}

      <AccountSheet open={addAccount} onOpenChange={setAddAccount} />
    </div>
  )
}
