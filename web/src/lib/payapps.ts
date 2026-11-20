// Payment apps people in India use. Onboarding asks which; the first one
// becomes Scan & pay's default where Kosh can open it (upiApps in upi.ts),
// and AI agents are told about them.

import type { Prefs } from './api'
import { rememberApp, upiApps } from './upi'

export type PayApp = { id: string; name: string; color: string; letter: string }

export const PAY_APPS: PayApp[] = [
  { id: 'gpay', name: 'Google Pay', color: '#4285F4', letter: 'G' },
  { id: 'phonepe', name: 'PhonePe', color: '#5F259F', letter: 'पे' },
  { id: 'paytm', name: 'Paytm', color: '#00BAF2', letter: 'P' },
  { id: 'cred', name: 'CRED', color: '#111111', letter: 'C' },
  { id: 'amazonpay', name: 'Amazon Pay', color: '#FF9900', letter: 'a' },
  { id: 'bhim', name: 'BHIM', color: '#F47920', letter: 'B' },
  { id: 'whatsapp', name: 'WhatsApp Pay', color: '#25D366', letter: 'W' },
  { id: 'super', name: 'super.money', color: '#4F2CF5', letter: 's' },
  { id: 'navi', name: 'Navi', color: '#16A34A', letter: 'N' },
  { id: 'mobikwik', name: 'MobiKwik', color: '#1E3A8A', letter: 'M' },
  { id: 'bank', name: "My bank's app", color: '#64748B', letter: '🏦' },
  { id: 'card', name: 'Cards', color: '#F97316', letter: '💳' },
]

export function payAppsOf(prefs: Prefs | undefined): string[] {
  return prefs?.payApps ?? []
}

/** Makes their favourite the app Scan & pay opens, when Kosh can open it. */
export function adoptFavourite(ids: string[]) {
  const first = ids.map((id) => upiApps.find((a) => a.id === id)).find(Boolean)
  if (first) rememberApp(first)
}
