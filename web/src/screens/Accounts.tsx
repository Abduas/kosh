import { motion } from 'motion/react'
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, ChevronRight, FileSearch, Pencil, Plus, Wallet } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AccountSheet } from '../components/Forms'
import { Amount, BigAmount } from '../components/Money'
import { TxList } from '../components/TxList'
import { Button, Card, EmptyState, Glyph, IconButton, ListRow, ScreenHeader, SectionTitle, Skeleton, cn } from '../components/ui'
import type { Account, AccountKind } from '../lib/api'
import { money } from '../lib/format'
import { useData, useTransactions } from '../lib/queries'
import { navigate } from '../lib/router'
import { openComposer } from '../lib/store'

const groups: { kind: AccountKind; title: string }[] = [
  { kind: 'bank', title: 'Bank accounts' },
  { kind: 'cash', title: 'Cash' },
  { kind: 'wallet', title: 'Wallets' },
  { kind: 'card', title: 'Credit cards' },
  { kind: 'savings', title: 'Savings' },
  { kind: 'investment', title: 'Investments' },
]

export function Accounts() {
  const d = useData()
  const [adding, setAdding] = useState(false)
  const active = d.activeAccounts
  const archived = d.accounts.filter((a) => a.archived)
  // Credit card balances go negative as you spend; everything else is money you have.
  const counted = active.filter((a) => a.includeInTotal)
  const cardsOwe = counted.filter((a) => a.kind === 'card').reduce((s, a) => s + Math.min(0, a.balance), 0)
  const assets = d.totalBalance - cardsOwe

  return (
    <div>
      <ScreenHeader
        title="Accounts"
        actions={
          <IconButton label="Add account" onClick={() => setAdding(true)} className="bg-surface">
            <Plus className="size-5" />
          </IconButton>
        }
      />

      <motion.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center pb-4 pt-1 text-center">
        <p className="rounded-full bg-surface px-3 py-1 text-[13px] font-medium text-ink-2">Total balance</p>
        <div className="mt-3 font-rounded text-[48px] font-medium leading-none tracking-[-0.02em]">
          <BigAmount value={d.totalBalance} />
        </div>
        {cardsOwe < 0 && (
          <p className="mt-3 text-[14px] font-medium text-ink-3">
            <Amount value={assets} /> in accounts <span className="mx-1 opacity-50">|</span> <Amount value={Math.abs(cardsOwe)} className="text-neg" /> on cards
          </p>
        )}
      </motion.section>

      {active.length === 0 && (
        <Card className="mt-6">
          <EmptyState icon={<Wallet className="size-7" />} title="No accounts" body="Add your bank accounts, cash and wallets." action={<Button onClick={() => setAdding(true)}>Add account</Button>} />
        </Card>
      )}

      {groups.map((g) => {
        const list = active.filter((a) => a.kind === g.kind)
        if (list.length === 0) return null
        const sum = list.reduce((s, a) => s + a.balance, 0)
        return (
          <section key={g.kind}>
            <SectionTitle title={g.title} action={<Amount value={sum} className="text-[13px] font-semibold text-ink-3" />} />
            <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
              {list.map((a, i) => (
                <AccountRow key={a.id} a={a} first={i === 0} />
              ))}
            </div>
          </section>
        )
      })}

      {archived.length > 0 && (
        <section>
          <SectionTitle title="Archived" />
          <div className="overflow-hidden rounded-[22px] bg-surface opacity-70 shadow-card">
            {archived.map((a, i) => (
              <AccountRow key={a.id} a={a} first={i === 0} />
            ))}
          </div>
        </section>
      )}

      <AccountSheet open={adding} onOpenChange={setAdding} />
    </div>
  )
}

function AccountRow({ a, first }: { a: Account; first: boolean }) {
  return (
    <div className={cn(!first && 'border-t border-line')}>
      <ListRow
        onClick={() => navigate(`/accounts/${a.id}`)}
        left={<Glyph icon={a.icon} color={a.color} size={42} />}
        title={a.name}
        subtitle={[a.institution !== a.name && a.institution, a.last4 && `•• ${a.last4}`, !a.includeInTotal && 'not in total'].filter(Boolean).join(' · ') || `${a.txCount} transactions`}
        right={<Amount value={a.balance} className={cn('text-[15px] font-bold', a.balance < 0 && 'text-neg')} />}
        chevron
      />
    </div>
  )
}

export function AccountDetail({ id }: { id: number }) {
  const d = useData()
  const a = d.accountsById.get(id)
  const [editing, setEditing] = useState(false)
  const tx = useTransactions({ account: id })
  const items = useMemo(() => tx.data?.pages.flatMap((p) => p.items) ?? [], [tx.data])

  if (!a) {
    return (
      <div>
        <ScreenHeader title="Not found" back="/accounts" />
        <EmptyState icon={<Wallet className="size-7" />} title="This account doesn't exist" />
      </div>
    )
  }

  return (
    <div>
      <ScreenHeader
        title=""
        back="/accounts"
        actions={
          <IconButton label="Edit account" onClick={() => setEditing(true)} className="bg-surface shadow-card">
            <Pencil className="size-[18px]" />
          </IconButton>
        }
      />

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className="relative -mt-4 overflow-hidden rounded-[28px] p-5 text-white shadow-[0_24px_50px_-24px_var(--c)]"
        style={{
          ['--c' as string]: a.color,
          background: `radial-gradient(120% 90% at 100% 0%, color-mix(in oklab, ${a.color} 55%, white) 0%, transparent 55%), linear-gradient(135deg, ${a.color}, color-mix(in oklab, ${a.color} 60%, black))`,
        }}
      >
        <div className="flex items-center justify-between">
          <span className="grid size-11 place-items-center rounded-2xl bg-white/20 text-[22px] backdrop-blur">{a.icon}</span>
          {a.last4 && <span className="text-[14px] font-semibold tracking-[0.2em] text-white/80">•••• {a.last4}</span>}
        </div>
        <p className="mt-6 text-[15px] font-semibold text-white/85">{a.name}</p>
        <div className="text-[40px] font-bold leading-tight tracking-[-0.04em]">
          <BigAmount value={a.balance} />
        </div>
        <p className="mt-1 text-[12px] font-medium text-white/65">
          {a.kind === 'card' ? (a.balance < 0 ? 'Outstanding on this card' : 'No dues') : `Started at ${money(a.openingBalance)}`} · {a.txCount} transactions
        </p>
      </motion.div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Button variant="secondary" size="sm" className="h-11" icon={<ArrowUpRight className="size-4 text-neg" />} onClick={() => openComposer({ kind: 'expense', accountId: id })}>
          Spend
        </Button>
        <Button variant="secondary" size="sm" className="h-11" icon={<ArrowDownLeft className="size-4 text-pos" />} onClick={() => openComposer({ kind: 'income', accountId: id })}>
          Receive
        </Button>
        <Button variant="secondary" size="sm" className="h-11" icon={<ArrowLeftRight className="size-4 text-accent" />} onClick={() => openComposer({ kind: 'transfer', accountId: id })}>
          Move
        </Button>
      </div>

      {a.kind !== 'cash' && (
        <button onClick={() => navigate(`/statement?account=${id}`)} className="press mt-2 flex w-full items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
            <FileSearch className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold tracking-tight">Check a statement</span>
            <span className="block text-[12px] text-ink-3">Interest, bank charges, missing entries</span>
          </span>
          <ChevronRight className="size-4 text-ink-3" />
        </button>
      )}

      <h2 className="mb-2.5 mt-8 px-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">History</h2>
      {tx.isLoading ? (
        <Skeleton className="h-32 rounded-[22px]" />
      ) : (
        <TxList
          items={items}
          accountId={id}
          hasMore={tx.hasNextPage}
          loadingMore={tx.isFetchingNextPage}
          onLoadMore={() => tx.fetchNextPage()}
          empty={<p className="py-8 text-center text-[14px] text-ink-3">No transactions in this account yet.</p>}
        />
      )}

      <AccountSheet open={editing} onOpenChange={setEditing} account={a} />
    </div>
  )
}
