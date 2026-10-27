import { useEffect } from 'react'
import type { Prefs } from './api'

export const accents: Record<string, string> = {
  violet: '#7C5CFF',
  blue: '#3B82F6',
  emerald: '#10B981',
  teal: '#14B8A6',
  orange: '#F97316',
  rose: '#F43F5E',
  pink: '#EC4899',
  amber: '#F59E0B',
  graphite: '#52525B',
}

export const palette = [
  '#7C5CFF', '#6366F1', '#3B82F6', '#0EA5E9', '#06B6D4', '#14B8A6', '#10B981', '#22C55E',
  '#84CC16', '#EAB308', '#F59E0B', '#F97316', '#EF4444', '#F43F5E', '#EC4899', '#D946EF',
  '#A855F7', '#64748B',
]

/** Applies theme and accent, and remembers them so the next launch paints correctly. */
export function useLook(prefs: Prefs | undefined) {
  const theme = prefs?.theme ?? 'system'
  const accentHex = accents[prefs?.accent ?? 'violet'] ?? accents.violet
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#09090B' : '#F2F2F5'))
    }
    apply()
    document.documentElement.style.setProperty('--accent', accentHex)
    try {
      localStorage.setItem('kosh:look', JSON.stringify({ theme, accentHex }))
    } catch {}
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme, accentHex])
}

/** A short vibration on Android for key presses and confirmations. iOS ignores it. */
export function haptic(ms = 8) {
  try {
    navigator.vibrate?.(ms)
  } catch {}
}
