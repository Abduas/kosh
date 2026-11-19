// Web Push on this phone: reminders before papers expire and services fall
// due. iPhones need Kosh added to the Home Screen first (iOS 16.4+), and
// permission must be asked from a tap.

import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import { platform } from './device'
import { queryClient } from './queries'

export type PushServer = { available: boolean; devices: number; publicKey?: string }

export function usePushServer() {
  return useQuery({ queryKey: ['push'], queryFn: () => api<PushServer>('GET', '/api/push'), staleTime: 60_000 })
}

export type PushState = 'unsupported' | 'install-first' | 'denied' | 'on' | 'off'

const standalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true

export async function pushState(): Promise<PushState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return platform === 'ios' && !standalone() ? 'install-first' : 'unsupported'
  }
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

export function usePushState() {
  return useQuery({ queryKey: ['push-state'], queryFn: pushState, staleTime: 10_000 })
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** Asks for permission (call it from a tap) and tells the server about this phone. */
export async function enablePush(publicKey: string) {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Notifications are blocked. Allow them for Kosh in Settings.' : 'Notifications were not allowed')
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await api('POST', '/api/push/subscribe', sub.toJSON())
  queryClient.invalidateQueries({ queryKey: ['push'] })
  queryClient.invalidateQueries({ queryKey: ['push-state'] })
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (sub) {
    await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {})
    await sub.unsubscribe()
  }
  queryClient.invalidateQueries({ queryKey: ['push'] })
  queryClient.invalidateQueries({ queryKey: ['push-state'] })
}

/** The phone's calendar app subscribes to this feed. */
export async function calendarUrl(): Promise<string> {
  const { path } = await api<{ path: string }>('POST', '/api/calendar')
  return `webcal://${location.host}${path}`
}
