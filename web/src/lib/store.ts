import { useSyncExternalStore } from 'react'
import type { Transaction, TxKind } from './api'

/** A minimal global store for UI state shared across screens. */
export function createStore<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }
  return {
    get: () => state,
    set(next: Partial<T> | ((s: T) => T)) {
      state = typeof next === 'function' ? next(state) : { ...state, ...next }
      listeners.forEach((l) => l())
    },
    subscribe,
    use<S>(select: (s: T) => S): S {
      return useSyncExternalStore(subscribe, () => select(state))
    },
  }
}

// ---- Privacy mode: blur every amount on screen ----

function readHidden(): boolean {
  try {
    return localStorage.getItem('kosh:hidden') === '1'
  } catch {
    return false
  }
}

export const privacy = createStore({ hidden: readHidden() })

export function togglePrivacy() {
  const hidden = !privacy.get().hidden
  privacy.set({ hidden })
  try {
    localStorage.setItem('kosh:hidden', hidden ? '1' : '0')
  } catch {}
}

// ---- The add / edit transaction sheet ----

export type ComposerPreset = {
  kind?: TxKind
  accountId?: number
  personId?: number
  categoryId?: number
  amount?: number
}

type ComposerState = { open: boolean; editing: Transaction | null; preset: ComposerPreset; key: number }

export const composer = createStore<ComposerState>({ open: false, editing: null, preset: {}, key: 0 })

export function openComposer(preset: ComposerPreset = {}) {
  composer.set((s) => ({ open: true, editing: null, preset, key: s.key + 1 }))
}

export function editTransaction(tx: Transaction) {
  composer.set((s) => ({ open: true, editing: tx, preset: {}, key: s.key + 1 }))
}

export function closeComposer() {
  composer.set({ open: false })
}
