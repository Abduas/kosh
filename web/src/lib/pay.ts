import { api, type Bootstrap, type PayeeMemory } from './api'
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
  const activeAccount = (id?: number) => (id && boot?.accounts.some((a) => a.id === id && !a.archived) ? id : undefined)
  const activePerson = (id?: number | null) => (id && boot?.people.some((p) => p.id === id && !p.archived) ? id : undefined)

  if (memory.known) {
    const kind = memory.kind === 'lend' || memory.kind === 'repay' ? memory.kind : 'expense'
    const personId = activePerson(memory.personId)
    if (kind === 'expense' || personId) {
      preset.kind = kind
      preset.personId = personId
      preset.categoryId = kind === 'expense' ? (memory.categoryId ?? undefined) : undefined
    }
    preset.accountId = activeAccount(memory.accountId)
    if (memory.note) preset.note = memory.note
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
  openComposer(preset)
}
