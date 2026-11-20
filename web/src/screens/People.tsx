import { motion } from 'motion/react'
import { useMutation } from '@tanstack/react-query'
import { BellRing, Check, HandCoins, Pencil, Phone, Plus, UserPlus, UserX, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { MoneyInput, PersonSheet } from '../components/Forms'
import { Amount, BigAmount } from '../components/Money'
import { TxList } from '../components/TxList'
import { Sheet } from '../components/Sheet'
import { Avatar, Button, Card, Chip, EmptyState, Field, IconButton, ScreenHeader, Segmented, Skeleton, TextInput, cn } from '../components/ui'
import { api, errorMessage, type Person } from '../lib/api'
import { money, relativeDays } from '../lib/format'
import { haptic } from '../lib/look'
import { invalidateMoney, useData, useTransactions } from '../lib/queries'
import { navigate } from '../lib/router'
import { openComposer } from '../lib/store'


type Filter = 'all' | 'owe-you' | 'you-owe' | 'settled'

function balanceText(p: Person) {
  if (p.balance > 0) return { label: 'owes you', className: 'text-pos' }
  if (p.balance < 0) return { label: 'you owe', className: 'text-neg' }
  return { label: 'settled', className: 'text-ink-3' }
}

export function People() {
  const d = useData()
  const [filter, setFilter] = useState<Filter>('all')
  const [adding, setAdding] = useState(false)

  const list = useMemo(() => {
    const active = d.people.filter((p) => !p.archived)
    const filtered = active.filter((p) =>
      filter === 'owe-you' ? p.balance > 0 : filter === 'you-owe' ? p.balance < 0 : filter === 'settled' ? p.balance === 0 : true,
    )
    return filtered.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance) || (b.lastActivity || '').localeCompare(a.lastActivity || ''))
  }, [d.people, filter])
  const archived = d.people.filter((p) => p.archived)

  return (
    <div>
      <ScreenHeader
        title="People"
        actions={
          <IconButton label="Add person" onClick={() => setAdding(true)} className="bg-surface">
            <UserPlus className="size-[19px]" />
          </IconButton>
        }
      />

      <div className="grid grid-cols-2 gap-3 pb-1 pt-1 text-center">
        <div>
          <p className="text-[13px] font-medium text-ink-3">You'll get</p>
          <div className="mt-1 font-rounded text-[32px] font-medium leading-tight tracking-[-0.02em] text-pos">
            <BigAmount value={d.owedToMe} />
          </div>
        </div>
        <div className="border-l border-line">
          <p className="text-[13px] font-medium text-ink-3">You owe</p>
          <div className={cn('mt-1 font-rounded text-[32px] font-medium leading-tight tracking-[-0.02em]', d.iOwe > 0 ? 'text-neg' : 'text-ink-3')}>
            <BigAmount value={d.iOwe} />
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-center gap-2">
        <button onClick={() => openComposer({ kind: 'lend' })} className="press flex h-10 items-center gap-1.5 rounded-full bg-surface px-4 text-[14px] font-semibold">
          <HandCoins className="size-4 text-lend" /> Lend
        </button>
        <button onClick={() => openComposer({ kind: 'borrow' })} className="press flex h-10 items-center gap-1.5 rounded-full bg-surface px-4 text-[14px] font-semibold">
          <Plus className="size-4 text-pos" /> Borrow
        </button>
      </div>

      {d.people.filter((p) => !p.archived).length > 5 && (
        <Segmented
          id="people-filter"
          size="sm"
          className="mt-5"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'owe-you', label: 'Owe you' },
            { value: 'you-owe', label: 'You owe' },
            { value: 'settled', label: 'Settled' },
          ]}
        />
      )}

      <div className="mt-5">
        {d.people.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Users className="size-7" />}
              title="Nobody here yet"
              body="When you lend or borrow, add it here. Kosh keeps a running balance with each person, including partial repayments."
              action={<Button onClick={() => setAdding(true)} icon={<UserPlus className="size-[18px]" />}>Add a person</Button>}
            />
          </Card>
        ) : list.length === 0 ? (
          <p className="py-10 text-center text-[14px] text-ink-3">No one in this list.</p>
        ) : (
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {list.map((p, i) => {
              const b = balanceText(p)
              return (
                <motion.button
                  key={p.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.02 }}
                  onClick={() => navigate(`/people/${p.id}`)}
                  className={cn('flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 active:bg-surface-2', i > 0 && 'border-t border-line')}
                >
                  <Avatar name={p.name} color={p.color} size={44} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold tracking-tight">{p.name}</p>
                    <p className="truncate text-[13px] text-ink-3">{p.lastActivity ? `Last activity ${relativeDays(p.lastActivity.slice(0, 10))}` : 'No transactions yet'}</p>
                  </div>
                  <div className="text-right">
                    {p.balance !== 0 ? <Amount value={Math.abs(p.balance)} className={cn('text-[15px] font-bold', b.className)} /> : <Check className="ml-auto size-5 text-ink-3" />}
                    <p className={cn('text-[11px] font-semibold uppercase tracking-wide', p.balance === 0 ? 'text-ink-3' : 'text-ink-3')}>{b.label}</p>
                  </div>
                </motion.button>
              )
            })}
          </div>
        )}
        {archived.length > 0 && filter === 'all' && (
          <p className="mt-4 px-1 text-[13px] text-ink-3">
            {archived.length} archived · {archived.map((p) => (
              <button key={p.id} onClick={() => navigate(`/people/${p.id}`)} className="mr-2 font-medium underline-offset-2 hover:underline">
                {p.name}
              </button>
            ))}
          </p>
        )}
      </div>

      <PersonSheet open={adding} onOpenChange={setAdding} onSaved={(p) => navigate(`/people/${p.id}`)} />
    </div>
  )
}

export function PersonDetail({ id }: { id: number }) {
  const d = useData()
  const p = d.peopleById.get(id)
  const [editing, setEditing] = useState(false)
  const [writingOff, setWritingOff] = useState(false)
  const tx = useTransactions({ person: id })
  const items = useMemo(() => tx.data?.pages.flatMap((pg) => pg.items) ?? [], [tx.data])

  if (!p) {
    return (
      <div>
        <ScreenHeader title="Not found" back="/people" />
        <EmptyState icon={<Users className="size-7" />} title="This person doesn't exist" />
      </div>
    )
  }

  const owesYou = p.balance > 0
  const settled = p.balance === 0

  const remind = async () => {
    haptic()
    const upi = d.user.prefs.upiId
    const amount = money(p.balance)
    const lines = [`Hi ${p.name.split(' ')[0]}, a gentle reminder about the ${amount} from earlier 🙂`]
    if (upi) lines.push(`You can pay me on UPI: ${upi}`)
    const text = lines.join('\n')
    const phone = p.phone.replace(/\D/g, '')
    if (phone.length >= 10) {
      const intl = phone.length === 10 ? '91' + phone : phone
      window.open(`https://wa.me/${intl}?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
    } else if (navigator.share) {
      navigator.share({ text }).catch(() => {})
    } else {
      await navigator.clipboard.writeText(text)
      toast.success('Reminder copied. Paste it in any chat.')
    }
  }

  return (
    <div>
      <ScreenHeader
        title=""
        back="/people"
        actions={
          <IconButton label="Edit person" onClick={() => setEditing(true)} className="bg-surface shadow-card">
            <Pencil className="size-[18px]" />
          </IconButton>
        }
      />

      <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} className="-mt-6 flex flex-col items-center text-center">
        <Avatar name={p.name} color={p.color} size={84} className="shadow-[0_16px_40px_-14px_rgb(0_0_0/0.5)]" />
        <h1 className="mt-3 text-[26px] font-bold tracking-[-0.03em]">{p.name}</h1>
        {(p.phone || p.note) && (
          <p className="mt-0.5 flex items-center gap-1.5 text-[14px] text-ink-3">
            {p.phone && (
              <a href={`tel:${p.phone}`} className="flex items-center gap-1 hover:text-ink">
                <Phone className="size-3.5" /> {p.phone}
              </a>
            )}
            {p.phone && p.note && '·'}
            {p.note}
          </p>
        )}

        <div className="mt-6">
          <p className={cn('text-[14px] font-semibold', settled ? 'text-ink-3' : owesYou ? 'text-pos' : 'text-neg')}>
            {settled ? 'All settled' : owesYou ? `${p.name.split(' ')[0]} owes you` : `You owe ${p.name.split(' ')[0]}`}
          </p>
          <div className={cn('text-[46px] font-bold leading-tight tracking-[-0.04em]', settled ? 'text-ink-3' : owesYou ? 'text-pos' : 'text-neg')}>
            {settled ? <Check className="mx-auto my-2 size-12" strokeWidth={2.5} /> : <BigAmount value={Math.abs(p.balance)} />}
          </div>
        </div>
      </motion.div>

      <div className="mt-6 grid grid-cols-2 gap-2">
        {!settled && (
          <Button
            className="col-span-2"
            size="lg"
            icon={<Check className="size-5" strokeWidth={2.6} />}
            onClick={() => openComposer({ kind: owesYou ? 'collect' : 'repay', personId: p.id, amount: Math.abs(p.balance) })}
          >
            {owesYou ? 'Mark as paid back' : 'Pay back'}
          </Button>
        )}
        <Button variant="secondary" onClick={() => openComposer({ kind: 'lend', personId: p.id })}>
          Lend more
        </Button>
        <Button variant="secondary" onClick={() => openComposer({ kind: owesYou ? 'collect' : 'borrow', personId: p.id })}>
          {owesYou ? 'Got some back' : 'Borrow'}
        </Button>
        {owesYou && (
          <Button variant="secondary" className="col-span-2" icon={<BellRing className="size-[18px] text-warn" />} onClick={remind}>
            Send a reminder{d.user.prefs.upiId ? ' with your UPI ID' : ''}
          </Button>
        )}
        {owesYou && (
          <Button variant="ghost" className="col-span-2 text-ink-3" icon={<UserX className="size-[18px]" />} onClick={() => setWritingOff(true)}>
            {p.name.split(' ')[0]} won't pay it back
          </Button>
        )}
      </div>

      <h2 className="mb-2.5 mt-8 px-1 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">History</h2>
      {tx.isLoading ? (
        <Skeleton className="h-32 rounded-[22px]" />
      ) : (
        <TxList
          items={items}
          hasMore={tx.hasNextPage}
          loadingMore={tx.isFetchingNextPage}
          onLoadMore={() => tx.fetchNextPage()}
          empty={<p className="py-8 text-center text-[14px] text-ink-3">No transactions with {p.name} yet.</p>}
        />
      )}

      <PersonSheet open={editing} onOpenChange={setEditing} person={p} />
      <Sheet
        open={writingOff}
        onOpenChange={setWritingOff}
        title="Count it as spent"
        description={`What ${p.name.split(' ')[0]} won't pay back becomes an expense. Your account balances stay the same.`}
      >
        {writingOff && <WriteOffForm person={p} onDone={() => setWritingOff(false)} />}
      </Sheet>
    </div>
  )
}

/**
 * Writing off a loan: the lent money that won't come back turns into an
 * expense on the day it was lent, from the account it left.
 */
function WriteOffForm({ person, onDone }: { person: Person; onDone: () => void }) {
  const d = useData()
  const [amount, setAmount] = useState(person.balance)
  // null: the "Money not returned" category, made when first needed.
  const [categoryId, setCategoryId] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const categories = d.categories.filter((c) => c.kind === 'expense' && !c.archived)
  const notReturned = categories.find((c) => c.name.toLowerCase() === 'money not returned')
  const others = categories.filter((c) => c !== notReturned)
  const first = person.name.split(' ')[0]
  const save = useMutation({
    mutationFn: () => api<{ person: Person }>('POST', `/api/people/${person.id}/write-off`, { amount, categoryId: categoryId ?? notReturned?.id ?? null, note }),
    onSuccess: (r) => {
      invalidateMoney()
      haptic()
      toast.success(r.person.balance === 0 ? `${money(amount)} counted as spent. All settled with ${first}.` : `${money(amount)} counted as spent. ${first} still owes ${money(r.person.balance)}.`)
      onDone()
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const picked = categoryId ?? notReturned?.id ?? null
  return (
    <div className="space-y-5">
      <Field label="How much won't come back">
        <MoneyInput value={amount} onChange={setAmount} />
      </Field>
      <div className="-mt-3 flex gap-2 px-1">
        <button className="text-[13px] font-medium text-accent" onClick={() => setAmount(person.balance)}>
          All of it ({money(person.balance)})
        </button>
      </div>
      <div>
        <p className="mb-1.5 px-1 text-[13px] font-medium text-ink-2">Category</p>
        <div className="no-scrollbar -mx-6 flex gap-2 overflow-x-auto px-6">
          <Chip active={picked === null || picked === notReturned?.id} onClick={() => setCategoryId(null)}>
            <span>💸</span> Money not returned
          </Chip>
          {others.map((c) => (
            <Chip key={c.id} active={picked === c.id} color={c.color} onClick={() => setCategoryId(c.id)}>
              <span>{c.icon}</span> {c.name}
            </Chip>
          ))}
        </div>
      </div>
      <Field label="Note">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Forgave it" maxLength={120} />
      </Field>
      <p className="px-1 text-[13px] text-ink-3">
        The most recent loans to {first} become expenses on the days you lent them, so those months' spending goes up. Anything not counted stays as what {first} owes you.
      </p>
      <Button size="lg" className="w-full" loading={save.isPending} disabled={amount <= 0 || amount > person.balance} onClick={() => save.mutate()}>
        Count {money(amount)} as spent
      </Button>
    </div>
  )
}
