import { useQuery } from '@tanstack/react-query'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { CalendarClock, Car, ChartPie, FileText, History, House, Plus, Users, Wallet, Target, Tag, Settings as SettingsIcon } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react'
import { Toaster } from 'sonner'
import { Composer } from './components/Composer'
import { GarageSheets } from './components/VehicleForms'
import { PaperViewerHost } from './components/PaperViewer'
import { syncPapers } from './lib/offline'
import { PaymentCheck } from './components/PaymentCheck'
import { cn } from './components/ui'
import { api, type AuthStatus } from './lib/api'
import { setCurrency } from './lib/format'
import { haptic, useLook } from './lib/look'
import { clearLocalData, clearSignedInData, useBootstrap, useData, useGarage } from './lib/queries'
import { linkHandler, match, navigate, useBackToClose, useLocation } from './lib/router'
import { closeScanner, composer, openComposer, openGarageSheet, openScanner, scanner } from './lib/store'
import { currentDocs, hasFinance, hasVehicles, lastSpace, rememberSpace, spaceOfPath, type Space } from './lib/vehicles'
import { launchScanEnabled, readPending } from './lib/upi'
import { AccountDetail, Accounts } from './screens/Accounts'
import { AuthScreen } from './screens/Auth'
import { Budgets } from './screens/Budgets'
import { Categories } from './screens/Categories'
import { Home } from './screens/Home'
import { Insights } from './screens/Insights'
import { Members } from './screens/Members'
import { Onboarding } from './screens/Onboarding'
import { People, PersonDetail } from './screens/People'
import { Settings } from './screens/Settings'
import { CaptureSettings } from './screens/Capture'
import { Review } from './screens/Review'
import { ImportScreen } from './screens/Import'
import { Due, Garage, Logs, Papers, VehicleDetail } from './screens/Garage'

export function App() {
  const status = useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthStatus>('GET', '/api/auth/status'),
    staleTime: Infinity,
    retry: 1,
  })
  // Wait until we know there's a session; offline, fall back to the cached copy.
  const boot = useBootstrap(status.data?.signedIn === true || status.isError)

  useEffect(() => {
    const onSignedOut = () => status.refetch()
    window.addEventListener('kosh:signed-out', onSignedOut)
    return () => window.removeEventListener('kosh:signed-out', onSignedOut)
  }, [status])

  // Signed out (from Settings, or a session that expired): forget the
  // previous person's data. This runs after the sign-in screen has replaced
  // the app, so no screen is left reading data that's gone.
  const signedOut = status.data?.signedIn === false
  useEffect(() => {
    if (signedOut) clearSignedInData()
  }, [signedOut])

  const prefs = boot.data?.user.prefs
  useLook(prefs)
  setCurrency(prefs?.currency)

  // Someone new is signed in: never show the previous person's saved data.
  const signedIn = () => {
    clearLocalData()
    navigate('/', { replace: true })
    status.refetch().then(() => boot.refetch())
  }

  let content: ReactNode
  if (status.data && !status.data.signedIn) {
    content = <AuthScreen needsSetup={status.data.needsSetup} google={status.data.google} onDone={signedIn} />
  } else if (boot.data) {
    content = prefs?.onboarded ? <Shell /> : <Onboarding />
  } else if (status.isError || boot.isError) {
    content = (
      <div className="grid min-h-dvh place-items-center p-8 text-center">
        <div>
          <p className="text-[17px] font-semibold">Can't reach Kosh</p>
          <p className="mt-1 text-[14px] text-ink-2">Check your connection, then try again.</p>
          <button onClick={() => { status.refetch(); boot.refetch() }} className="press mt-5 h-11 rounded-2xl bg-accent px-5 font-semibold text-white">
            Retry
          </button>
        </div>
      </div>
    )
  } else {
    content = <Splash />
  }

  return (
    <MotionConfig reducedMotion="user">
      {content}
      <Toaster
        position="top-center"
        // Below the notch and status bar: the installed app draws under them.
        offset={{ top: 'calc(env(safe-area-inset-top) + 10px)' }}
        mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 8px)', left: 12, right: 12 }}
        toastOptions={{
          classNames: {
            toast: '!rounded-2xl !border-0 !bg-ink !text-bg !shadow-float !font-sans !text-[14px] !font-medium',
            actionButton: '!rounded-full !bg-accent !text-white !font-semibold !px-3',
          },
        }}
      />
    </MotionConfig>
  )
}

// The scanner and its QR decoder load only when needed.
const loadScanner = () => import('./components/Scanner')
const Scanner = lazy(loadScanner)

function ScannerHost() {
  const open = scanner.use((s) => s.open)
  useBackToClose(open, closeScanner)
  return (
    <AnimatePresence>
      {open && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] bg-black" />}>
          <Scanner />
        </Suspense>
      )}
    </AnimatePresence>
  )
}

function Splash() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <motion.img src="/icon.svg" alt="" className="size-16" animate={{ scale: [1, 1.06, 1] }} transition={{ repeat: Infinity, duration: 1.4 }} />
    </div>
  )
}

type Tab = { to: string; label: string; icon: typeof House }

const financeTabs: Tab[] = [
  { to: '/', label: 'Home', icon: House },
  { to: '/accounts', label: 'Accounts', icon: Wallet },
  { to: '/people', label: 'People', icon: Users },
  { to: '/insights', label: 'Insights', icon: ChartPie },
]

const vehicleTabs: Tab[] = [
  { to: '/garage', label: 'Garage', icon: Car },
  { to: '/due', label: 'Due', icon: CalendarClock },
  { to: '/logs', label: 'Logs', icon: History },
  { to: '/papers', label: 'Papers', icon: FileText },
]

const financeMore: Tab[] = [
  { to: '/budgets', label: 'Budgets', icon: Target },
  { to: '/categories', label: 'Categories', icon: Tag },
]

function isActive(to: string, path: string) {
  return to === '/' ? path === '/' || path === '/activity' : path === to || path.startsWith(to + '/')
}

function Shell() {
  const { path, search } = useLocation()
  const prefs = useData().user.prefs
  const finance = hasFinance(prefs)
  const vehicles = hasVehicles(prefs)
  // Money and Vehicles each have their own tabs; Settings keeps the last one's.
  const pathSpace = spaceOfPath(path)
  const preferred: Space = pathSpace ?? lastSpace()
  const space: Space = preferred === 'vehicles' ? (vehicles ? 'vehicles' : 'finance') : finance ? 'finance' : 'vehicles'
  useEffect(() => {
    if (pathSpace) rememberSpace(pathSpace)
  }, [pathSpace])

  // Open where you were last, and keep away from a part that's turned off.
  const launched = useRef(false)
  useEffect(() => {
    const first = !launched.current
    launched.current = true
    if (pathSpace === 'vehicles' && !vehicles) navigate('/', { replace: true })
    else if (pathSpace === 'finance' && !finance) navigate('/garage', { replace: true })
    else if (first && path === '/' && vehicles && lastSpace() === 'vehicles' && !search.toString()) navigate('/garage', { replace: true })
  }, [path, pathSpace, finance, vehicles]) // eslint-disable-line react-hooks/exhaustive-deps

  // Keep a copy of each current paper on the phone, for showing offline.
  const garage = useGarage(vehicles).data
  useEffect(() => {
    if (garage && navigator.onLine) syncPapers(currentDocs(garage.documents)).catch(() => {})
  }, [garage])

  const add = () => (space === 'vehicles' ? openGarageSheet({ kind: 'menu' }) : openComposer())
  const tabs = space === 'vehicles' ? vehicleTabs : financeTabs

  // Home-screen shortcuts: /?add=expense, /people?add=lend, /?scan=1
  useEffect(() => {
    const add = search.get('add')
    if (add === 'expense' || add === 'income' || add === 'lend' || add === 'transfer') {
      openComposer({ kind: add })
      navigate(path, { replace: true })
    } else if (search.get('scan') === '1') {
      openScanner()
      navigate(path, { replace: true })
    }
  }, [search, path])

  // Optionally open straight into the scanner: at launch, and when coming back
  // after a minute away (iPhone home-screen apps resume rather than restart).
  useEffect(() => {
    const canAutoOpen = () => launchScanEnabled() && !readPending() && !composer.get().open
    if (canAutoOpen()) openScanner()
    let hiddenAt = 0
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt = Date.now()
      else if (hiddenAt && Date.now() - hiddenAt > 60_000 && canAutoOpen()) openScanner()
    }
    document.addEventListener('visibilitychange', onVisibility)
    // Fetch the scanner in the background so the first scan opens instantly.
    const warm = window.setTimeout(() => loadScanner().then((m) => m.warmUp()).catch(() => {}), 3000)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      clearTimeout(warm)
    }
  }, [])

  // Desktop shortcuts: N for new, / for search
  const addRef = useRef(add)
  addRef.current = add
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [contenteditable], [role="dialog"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'n') {
        e.preventDefault()
        addRef.current()
      } else if (e.key === '/') {
        e.preventDefault()
        navigate('/activity?focus=1')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  let screen: ReactNode
  let params: Record<string, string> | null
  if (path === '/') screen = <Home />
  else if (path === '/activity') screen = <Home />
  else if (path === '/insights') screen = <Insights />
  else if (path === '/people') screen = <People />
  else if ((params = match('/people/:id', path))) screen = <PersonDetail id={Number(params.id)} />
  else if (path === '/accounts') screen = <Accounts />
  else if ((params = match('/accounts/:id', path))) screen = <AccountDetail id={Number(params.id)} />
  else if (path === '/budgets') screen = <Budgets />
  else if (path === '/categories') screen = <Categories />
  else if (path === '/settings') screen = <Settings />
  else if (path === '/members') screen = <Members />
  else if (path === '/settings/capture') screen = <CaptureSettings />
  else if (path === '/settings/import') screen = <ImportScreen />
  else if (path === '/review') screen = <Review />
  else if (path === '/garage') screen = <Garage />
  else if ((params = match('/garage/:id', path))) screen = <VehicleDetail id={Number(params.id)} />
  else if (path === '/due') screen = <Due />
  else if (path === '/logs') screen = <Logs />
  else if (path === '/papers') screen = <Papers />
  else screen = finance ? <Home /> : <Garage />

  const sideGroups: { title?: string; links: Tab[] }[] = [
    ...(finance ? [{ title: vehicles ? 'Money' : undefined, links: [...financeTabs, ...financeMore] }] : []),
    ...(vehicles ? [{ title: finance ? 'Vehicles' : undefined, links: vehicleTabs }] : []),
    { links: [{ to: '/settings', label: 'Settings', icon: SettingsIcon }] },
  ]

  return (
    <div className="min-h-dvh md:flex">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-line px-4 py-6 md:flex">
        <a href="/" onClick={linkHandler('/')} className="mb-8 flex items-center gap-2.5 px-2">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-[19px] font-bold tracking-tight">Kosh</span>
        </a>
        <button
          onClick={add}
          className="press mb-6 flex h-11 items-center justify-center gap-2 rounded-2xl bg-accent font-semibold text-white shadow-[0_10px_30px_-12px_var(--accent)]"
        >
          <Plus className="size-5" strokeWidth={2.5} /> {space === 'vehicles' ? 'Add to garage' : 'New transaction'}
          <kbd className="ml-1 rounded-md bg-white/20 px-1.5 text-[11px] font-semibold">N</kbd>
        </button>
        <nav className="space-y-4">
          {sideGroups.map((grp, gi) => (
          <div key={gi} className="space-y-0.5">
          {grp.title && <p className="px-3 pb-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">{grp.title}</p>}
          {grp.links.map((l) => {
            const active = isActive(l.to, path)
            return (
              <a
                key={l.to}
                href={l.to}
                onClick={linkHandler(l.to)}
                className={cn('relative flex h-10 items-center gap-3 rounded-xl px-3 text-[14px] font-medium transition-colors', active ? 'text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
              >
                {active && <motion.span layoutId="side-active" className="absolute inset-0 rounded-xl bg-surface shadow-card" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <l.icon className="relative size-[18px]" strokeWidth={active ? 2.3 : 2} />
                <span className="relative">{l.label}</span>
              </a>
            )
          })}
          </div>
          ))}
        </nav>
      </aside>

      <main className="mx-auto w-full max-w-[720px] px-4 pb-36 pt-[max(env(safe-area-inset-top),12px)] md:px-8 md:pb-16 md:pt-8">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={path}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {screen}
          </motion.div>
        </AnimatePresence>
      </main>

      <TabBar path={path} tabs={tabs} onAdd={add} addLabel={space === 'vehicles' ? 'Add to garage' : 'Add transaction'} />
      <Composer />
      <GarageSheets />
      <PaperViewerHost />
      <ScannerHost />
      <PaymentCheck />
    </div>
  )
}

function TabBar({ path, tabs, onAdd, addLabel }: { path: string; tabs: Tab[]; onAdd: () => void; addLabel: string }) {
  const left = tabs.slice(0, 2)
  const right = tabs.slice(2)
  const item = (t: Tab) => {
    const active = isActive(t.to, path)
    return (
      <a
        key={t.to}
        href={t.to}
        aria-label={t.label}
        aria-current={active ? 'page' : undefined}
        onClick={(e) => {
          haptic(5)
          linkHandler(t.to)(e)
        }}
        className={cn('press grid h-12 flex-1 place-items-center transition-colors', active ? 'text-ink' : 'text-ink-3/70')}
      >
        <t.icon className="size-[24px]" strokeWidth={active ? 2.4 : 2} />
      </a>
    )
  }
  // Icons only, with the add button in the middle, like iOS finance apps.
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/90 pb-[max(env(safe-area-inset-bottom),8px)] pt-1.5 backdrop-blur-2xl backdrop-saturate-150 md:hidden">
      <div className="mx-auto flex max-w-[480px] items-center px-3">
        {left.map(item)}
        <div className="flex flex-1 justify-center">
          <motion.button
            whileTap={{ scale: 0.92 }}
            onClick={() => {
              haptic(10)
              onAdd()
            }}
            aria-label={addLabel}
            className="grid h-[42px] w-[64px] place-items-center rounded-[14px] bg-accent text-white"
          >
            <Plus className="size-6" strokeWidth={2.6} />
          </motion.button>
        </div>
        {right.map(item)}
      </div>
    </nav>
  )
}
