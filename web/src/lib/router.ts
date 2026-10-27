import { useEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react'

// A tiny History API router: the app has a handful of flat routes, so a full
// routing library would be more weight than help.

const listeners = new Set<() => void>()
let depth = (history.state?.depth as number | undefined) ?? 0
let lastDirection: 1 | -1 = 1

function notify() {
  listeners.forEach((l) => l())
}

// Open sheets, the composer and the scanner each add a history entry with the
// same URL. The back button (Android, desktop) then closes the top one
// instead of changing the screen underneath it.
const closers: (() => void)[] = []
let ignorePops = 0

window.addEventListener('popstate', (e) => {
  if (ignorePops > 0) {
    // Our own history.back() after a sheet closed some other way.
    ignorePops--
    return
  }
  const closer = closers.pop()
  if (closer) {
    closer()
    return
  }
  const next = (e.state?.depth as number | undefined) ?? 0
  lastDirection = next < depth ? -1 : 1
  depth = next
  notify()
})

/** Lets the back button close an open sheet or overlay. */
export function useBackToClose(open: boolean, close: () => void) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!open) return
    const id = Math.random().toString(36).slice(2)
    history.pushState({ ...history.state, overlay: id }, '')
    let closedByBack = false
    const closer = () => {
      closedByBack = true
      closeRef.current()
    }
    closers.push(closer)
    return () => {
      const i = closers.indexOf(closer)
      if (i >= 0) closers.splice(i, 1)
      // Closed by a button or a swipe: drop the entry we added, unless the
      // app has already moved on to another screen on top of it.
      if (!closedByBack && history.state?.overlay === id) {
        ignorePops++
        history.back()
      }
    }
  }, [open])
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === location.pathname + location.search) return
  if (opts.replace) {
    history.replaceState({ depth }, '', to)
  } else {
    depth += 1
    lastDirection = 1
    history.pushState({ depth }, '', to)
  }
  window.scrollTo({ top: 0 })
  notify()
}

/** Goes back if there's in-app history, otherwise to the fallback route. */
export function goBack(fallback = '/') {
  if (depth > 0) history.back()
  else navigate(fallback, { replace: true })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useLocation(): { path: string; search: URLSearchParams; direction: 1 | -1 } {
  const href = useSyncExternalStore(subscribe, () => location.pathname + location.search)
  const [path, query = ''] = href.split('?')
  return { path, search: new URLSearchParams(query), direction: lastDirection }
}

/** Matches '/people/:id' against a path. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean)
  const s = path.split('/').filter(Boolean)
  if (p.length !== s.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(s[i])
    else if (p[i] !== s[i]) return null
  }
  return params
}

export function linkHandler(to: string) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(to)
  }
}

/** Removes a query parameter without adding a history entry. */
export function clearParam(name: string) {
  const url = new URL(location.href)
  if (!url.searchParams.has(name)) return
  url.searchParams.delete(name)
  history.replaceState(history.state, '', url.pathname + url.search)
  notify()
}
