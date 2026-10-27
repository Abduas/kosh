import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { dehydrate } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { App } from './App'
import { nativeFeel } from './lib/native'
import { CACHE_BUSTER, CACHE_KEY, dehydrateOptions, persister, queryClient } from './lib/queries'
import './styles.css'

nativeFeel()

// The persister saves at most once a second. When the app is hidden or closed,
// save right away so the next launch never starts from older data.
function saveNow() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ buster: CACHE_BUSTER, timestamp: Date.now(), clientState: dehydrate(queryClient, dehydrateOptions) }))
  } catch {}
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && saveNow())
window.addEventListener('pagehide', saveNow)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 * 7, buster: CACHE_BUSTER, dehydrateOptions }}
      // Show the saved copy instantly, then refresh everything from the server.
      onSuccess={() => queryClient.invalidateQueries()}
    >
      <App />
    </PersistQueryClientProvider>
  </StrictMode>,
)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
