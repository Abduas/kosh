import { api, type Account, type Bootstrap, type PayeeMemory } from './api'
import { queryClient } from './queries'
import { openComposer, type ComposerPreset } from './store'
import { categoryNameForMcc, nameMatches, type UpiTarget } from './upi'

/**
 * Turns a scanned QR into a filled-in payment sheet. What Kosh did the last
 * time you paid this UPI ID wins; otherwise it guesses from the QR: a known
 * person's name means money to them, a shop's merchant code picks a category.
 */
export async function startPayment(target: UpiTarget) {
  const boot = queryClient.getQueryData<Bootstrap>(['bootstrap'])
  let memory: PayeeMemory = { known: false, count: 0 }
  try {
    memory = await api<PayeeMemory>('GET', `/api/payees?vpa=${encodeURIComponent(target.vpa)}`)
  } catch {
    // Offline or a hiccup: carry on with guesses from the QR alone.
  }

  const preset: ComposerPreset = { upi: target, amount: target.amount ?? undefined, kind: 'expense', note: target.name }
  const activePerson = (id?: number | null) => (id && boot?.people.some((p) => p.id === id && !p.archived) ? id : undefined)

  if (memory.known) {
    const kind = memory.kind === 'lend' || memory.kind === 'repay' ? memory.kind : 'expense'
    const personId = activePerson(memory.personId)
    if (kind === 'expense' || personId) {
      preset.kind = kind
      preset.personId = personId
      preset.categoryId = kind === 'expense' ? (memory.categoryId ?? undefined) : undefined
    }
    if (memory.note) preset.note = memory.note
    if (memory.lastSavedAt && memory.lastAmount) preset.recent = { amount: memory.lastAmount, savedAt: memory.lastSavedAt }
  } else if (boot) {
    const person = target.merchant ? undefined : boot.people.find((p) => !p.archived && nameMatches(p.name, target.name))
    if (person) {
      // You owe them: this is probably paying them back.
      preset.kind = person.balance < 0 ? 'repay' : 'lend'
      preset.personId = person.id
      preset.note = target.note
    } else {
      const name = categoryNameForMcc(target.mcc)
      const category = name ? boot.categories.find((c) => c.kind === 'expense' && !c.archived && c.name.toLowerCase() === name.toLowerCase()) : undefined
      preset.categoryId = category?.id
    }
  }
  preset.accountId = boot ? upiAccount(boot, memory.accountId)?.id : undefined
  openComposer(preset)
}

/** Accounts a UPI payment can come from: anything but cash. */
export function payableAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => !a.archived && a.kind !== 'cash')
}

export function lastUpiAccountId(): number | null {
  try {
    return Number(localStorage.getItem('kosh:lastUpiAccount')) || null
  } catch {
    return null
  }
}

/**
 * The account a scan pays from: your default, else the one used for this
 * payee last time, else the one you paid from last, else your first bank.
 */
export function upiAccount(boot: Bootstrap, rememberedId?: number): Account | undefined {
  const list = payableAccounts(boot.accounts)
  const find = (id?: number | null) => (id ? list.find((a) => a.id === id) : undefined)
  return find(boot.user.prefs.upiAccountId) ?? find(rememberedId) ?? find(lastUpiAccountId()) ?? list.find((a) => a.kind === 'bank') ?? list[0]
}
