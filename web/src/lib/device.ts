// What kind of device Kosh is running on.

export type Platform = 'ios' | 'android' | 'other'

export const platform: Platform = (() => {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'other'
})()

/** Phones and tablets. Fields there shouldn't focus by themselves: on iPhone a
 *  field focused while its sheet slides up shows the cursor in the wrong place
 *  and makes Safari scroll the page. */
export const isTouch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches

type Contact = { name?: string[]; tel?: string[] }
type ContactsManager = { select(props: string[], opts: { multiple: boolean }): Promise<Contact[]> }

/** The phone's contact picker: Chrome on Android, and Safari once its
 *  "Contact Picker API" feature flag is on. */
export const contactsApi: ContactsManager | null =
  typeof navigator !== 'undefined' && 'contacts' in navigator ? ((navigator as unknown as { contacts: ContactsManager }).contacts ?? null) : null

export type PickedContact = { name: string; phone: string }

export async function pickContacts(multiple: boolean): Promise<PickedContact[]> {
  if (!contactsApi) return []
  const list = await contactsApi.select(['name', 'tel'], { multiple })
  return list
    .map((c) => ({
      name: (c.name?.find((n) => n.trim()) ?? '').trim().slice(0, 50),
      // "+91 98765-43210" -> "+91 98765 43210"
      phone: (c.tel?.[0] ?? '').replace(/[-().]/g, ' ').replace(/[^\d+ ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20),
    }))
    .filter((c) => c.name || c.phone)
}
