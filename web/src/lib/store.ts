import { useSyncExternalStore } from 'react'
import type { DocType, LogKind, Transaction, TxKind, Vehicle, VehicleDoc, VehicleLog } from './api'
import type { UpiTarget } from './upi'

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
  note?: string
  /** A scanned UPI QR: the sheet becomes "pay this" instead of "record this". */
  upi?: UpiTarget
  /** The last payment to this UPI ID, to warn before paying twice. */
  recent?: { amount: number; savedAt: string }
  /** Local 'YYYY-MM-DDTHH:MM'; defaults to now. */
  occurredAt?: string
  /** Saving records this captured bank message. */
  captureId?: number
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

// ---- The QR scanner ----

export const scanner = createStore({ open: false })

export function openScanner() {
  composer.set({ open: false })
  scanner.set({ open: true })
}

export function closeScanner() {
  scanner.set({ open: false })
}

// ---- Vehicle sheets: add menu, vehicle, log and document forms ----

export type GarageSheet =
  | { kind: 'menu'; vehicleId?: number }
  | { kind: 'vehicle'; editing?: Vehicle }
  | { kind: 'log'; editing?: VehicleLog; preset?: { vehicleId?: number; kind?: LogKind } }
  | { kind: 'doc'; editing?: VehicleDoc; preset?: { vehicleId?: number | null; type?: DocType; renew?: VehicleDoc; scan?: boolean } }

export const garageSheet = createStore<{ sheet: GarageSheet | null; key: number }>({ sheet: null, key: 0 })

export function openGarageSheet(sheet: GarageSheet) {
  garageSheet.set((s) => ({ sheet, key: s.key + 1 }))
}

export function closeGarageSheet() {
  garageSheet.set((s) => ({ ...s, sheet: null }))
}
