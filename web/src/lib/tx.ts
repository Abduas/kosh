import type { Transaction, TxKind } from './api'
import type { Data } from './queries'

export const kindMeta: Record<TxKind, { label: string; verb: string; sign: 1 | -1 | 0 }> = {
  expense: { label: 'Expense', verb: 'Spent', sign: -1 },
  income: { label: 'Income', verb: 'Received', sign: 1 },
  transfer: { label: 'Transfer', verb: 'Moved', sign: 0 },
  lend: { label: 'Lent', verb: 'Lent', sign: -1 },
  borrow: { label: 'Borrowed', verb: 'Borrowed', sign: 1 },
  collect: { label: 'Got back', verb: 'Got back', sign: 1 },
  repay: { label: 'Paid back', verb: 'Paid back', sign: -1 },
}

export const personKinds: TxKind[] = ['lend', 'borrow', 'collect', 'repay']
export const isPersonKind = (k: TxKind) => personKinds.includes(k)

/** How a transaction moves money for the person: +1 in, -1 out, 0 neutral. */
export function txSign(t: Transaction, accountId?: number): 1 | -1 | 0 {
  if (t.kind === 'transfer') {
    if (accountId === t.accountId) return -1
    if (accountId === t.toAccountId) return 1
    return 0
  }
  return kindMeta[t.kind].sign
}

/** Signed effect on how much a person owes you (positive: they owe more). */
export function personEffect(t: Transaction): number {
  return t.kind === 'lend' || t.kind === 'repay' ? t.amount : -t.amount
}

export function describeTx(t: Transaction, d: Data): { title: string; subtitle: string } {
  const account = d.accountsById.get(t.accountId)?.name ?? 'Account'
  const person = t.personId ? (d.peopleById.get(t.personId)?.name ?? 'Someone') : ''
  const category = t.categoryId ? d.categoriesById.get(t.categoryId) : undefined
  switch (t.kind) {
    case 'expense':
    case 'income':
      return { title: t.note || category?.name || (t.kind === 'expense' ? 'Expense' : 'Income'), subtitle: t.note && category ? `${category.name} · ${account}` : account }
    case 'transfer': {
      const to = d.accountsById.get(t.toAccountId ?? 0)?.name ?? 'Account'
      return { title: t.note || 'Transfer', subtitle: `${account} → ${to}` }
    }
    case 'lend':
      return { title: `Lent to ${person}`, subtitle: t.note ? `${t.note} · ${account}` : account }
    case 'borrow':
      return { title: `Borrowed from ${person}`, subtitle: t.note ? `${t.note} · ${account}` : account }
    case 'collect':
      return { title: `${person} paid you back`, subtitle: t.note ? `${t.note} · ${account}` : account }
    case 'repay':
      return { title: `Paid back ${person}`, subtitle: t.note ? `${t.note} · ${account}` : account }
  }
}

/** Builds a UPI payment link for a reminder, so the other person can pay in one tap. */
export function upiLink(upiId: string, name: string, amountMinor: number, note: string): string {
  const p = new URLSearchParams({ pa: upiId, pn: name, am: (amountMinor / 100).toFixed(2), cu: 'INR', tn: note })
  return `upi://pay?${p.toString()}`
}
