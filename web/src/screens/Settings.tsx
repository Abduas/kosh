import { useMutation } from '@tanstack/react-query'
import { Check, Download, KeyRound, LogOut, Monitor, Moon, Smartphone, Sun, Tag, Target, UserPlus, Wallet } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Sheet } from '../components/Sheet'
import { Avatar, Button, Field, ListRow, ScreenHeader, SectionTitle, Segmented, TextInput, Toggle, cn } from '../components/ui'
import { api, type AuthStatus, type Bootstrap, type Prefs, type User } from '../lib/api'
import { accents } from '../lib/look'
import { clearLocalData, queryClient, useData, useUpdateMe } from '../lib/queries'
import { clearParam, navigate } from '../lib/router'
import { privacy, togglePrivacy } from '../lib/store'
import { payableAccounts } from '../lib/pay'
import { launchScanEnabled, platform, preferredApp, rememberApp, setLaunchScan, upiApps } from '../lib/upi'
import { GoogleMark } from './Auth'

const currencies = [
  { code: 'INR', label: '₹ Indian Rupee' },
  { code: 'USD', label: '$ US Dollar' },
  { code: 'EUR', label: '€ Euro' },
  { code: 'GBP', label: '£ British Pound' },
  { code: 'AED', label: 'د.إ UAE Dirham' },
  { code: 'SAR', label: '﷼ Saudi Riyal' },
  { code: 'SGD', label: 'S$ Singapore Dollar' },
  { code: 'CAD', label: 'C$ Canadian Dollar' },
  { code: 'AUD', label: 'A$ Australian Dollar' },
]

type InstallEvent = Event & { prompt: () => Promise<void> }

export function Settings() {
  const d = useData()
  const update = useUpdateMe()
  const prefs = d.user.prefs
  const hidden = privacy.use((s) => s.hidden)
  const [name, setName] = useState(d.user.name)
  const [upi, setUpi] = useState(prefs.upiId ?? '')
  const [launchScan, setLaunchScanState] = useState(launchScanEnabled)
  const [upiApp, setUpiApp] = useState(preferredApp)
  const payFrom = payableAccounts(d.accounts)
  const [pwOpen, setPwOpen] = useState(false)
  const [install, setInstall] = useState<InstallEvent | null>(null)
  const standalone = matchMedia('(display-mode: standalone)').matches
  const googleAvailable = queryClient.getQueryData<AuthStatus>(['auth'])?.google ?? false

  // Back from connecting Google.
  useEffect(() => {
    const q = new URLSearchParams(location.search)
    if (q.get('google') === 'linked') toast.success('Google connected. You can sign in with it now.')
    const err = q.get('authError')
    if (err) toast.error(err)
    clearParam('google')
    clearParam('authError')
  }, [])

  const unlinkGoogle = useMutation({
    mutationFn: () => api<User>('DELETE', '/api/me/google'),
    onSuccess: (user) => {
      queryClient.setQueryData<Bootstrap>(['bootstrap'], (b) => (b ? { ...b, user } : b))
      toast.success('Google disconnected')
    },
  })

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setInstall(e as InstallEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  const setPref = (p: Prefs) => update.mutate({ prefs: p })

  // Opening the CSV URL directly would replace the installed app with the file
  // and no way back. Fetch it instead, then share it (phones) or download it.
  const exportCsv = async () => {
    try {
      const res = await fetch('/api/export.csv', { credentials: 'same-origin' })
      if (!res.ok) throw new Error()
      const name = `kosh-${new Date().toISOString().slice(0, 10)}.csv`
      const file = new File([await res.blob()], name, { type: 'text/csv' })
      if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: name }).catch(() => {})
        return
      }
      const url = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } catch {
      toast.error("Couldn't export. Check your connection and try again.")
    }
  }

  const signOut = async () => {
    await api('POST', '/api/auth/logout').catch(() => {})
    clearLocalData()
    queryClient.setQueryData<AuthStatus>(['auth'], { needsSetup: false, signedIn: false, google: googleAvailable })
    navigate('/', { replace: true })
  }

  return (
    <div>
      <ScreenHeader title="Settings" back="/" />

      <div className="flex items-center gap-4 rounded-[24px] bg-surface p-4 shadow-card">
        <Avatar name={d.user.name} color={accents[prefs.accent ?? 'violet'] ?? '#7C5CFF'} size={56} />
        <div className="min-w-0 flex-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== d.user.name && update.mutate({ name })}
            className="w-full rounded-lg bg-transparent text-[19px] font-bold tracking-tight outline-none focus:bg-surface-2"
            aria-label="Your name"
          />
          <p className="text-[13px] text-ink-3">@{d.user.username}</p>
        </div>
      </div>

      <SectionTitle title="Appearance" />
      <div className="space-y-4 rounded-[22px] bg-surface p-4 shadow-card">
        <Segmented
          id="theme"
          value={prefs.theme ?? 'system'}
          onChange={(theme) => setPref({ theme })}
          options={[
            { value: 'system', label: <><Monitor className="size-4" /> Auto</> },
            { value: 'light', label: <><Sun className="size-4" /> Light</> },
            { value: 'dark', label: <><Moon className="size-4" /> Dark</> },
          ]}
        />
        <div>
          <p className="mb-2.5 text-[13px] font-medium text-ink-2">Accent</p>
          <div className="flex flex-wrap gap-2.5">
            {Object.entries(accents).map(([key, hex]) => {
              const on = (prefs.accent ?? 'violet') === key
              return (
                <button
                  key={key}
                  aria-label={key}
                  onClick={() => setPref({ accent: key })}
                  className="press grid size-9 place-items-center rounded-full"
                  style={{ background: hex, boxShadow: on ? `0 0 0 3px var(--surface), 0 0 0 5px ${hex}` : undefined }}
                >
                  {on && <Check className="size-4 text-white" strokeWidth={3} />}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <SectionTitle title="Money" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="text-[15px] font-medium">Currency</span>
          <select
            value={prefs.currency ?? 'INR'}
            onChange={(e) => setPref({ currency: e.target.value })}
            className="h-9 rounded-xl bg-surface-2 px-3 text-[14px] font-semibold outline-none"
          >
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="border-t border-line px-4 py-3">
          <Field label="Your UPI ID" hint="Added to payment reminders so people can pay you back quickly.">
            <TextInput
              value={upi}
              onChange={(e) => setUpi(e.target.value.trim())}
              onBlur={() => upi !== (prefs.upiId ?? '') && setPref({ upiId: upi })}
              placeholder="yourname@okaxis"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <div>
            <p className="text-[15px] font-medium">Hide amounts</p>
            <p className="text-[12px] text-ink-3">Blur balances on this device. Tap the eye on Home to toggle.</p>
          </div>
          <Toggle checked={hidden} onChange={togglePrivacy} label="Hide amounts" />
        </div>
      </div>

      <SectionTitle title="Scan & pay" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[15px] font-medium">Pay from</p>
            <p className="text-[12px] text-ink-3">The bank account scans use. Never cash.</p>
          </div>
          <select
            value={payFrom.some((a) => a.id === prefs.upiAccountId) ? prefs.upiAccountId : 0}
            onChange={(e) => setPref({ upiAccountId: Number(e.target.value) })}
            className="h-9 max-w-[180px] rounded-xl bg-surface-2 px-3 text-[14px] font-semibold outline-none"
            aria-label="Pay from"
          >
            <option value={0}>Automatic</option>
            {payFrom.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        {platform === 'ios' && (
          <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
            <div className="min-w-0">
              <p className="text-[15px] font-medium">Payment app</p>
              <p className="text-[12px] text-ink-3">Opened when you tap Pay. You can switch per payment.</p>
            </div>
            <select
              value={upiApp.id}
              onChange={(e) => {
                const a = upiApps.find((x) => x.id === e.target.value)!
                rememberApp(a)
                setUpiApp(a)
              }}
              className="h-9 rounded-xl bg-surface-2 px-3 text-[14px] font-semibold outline-none"
              aria-label="Payment app"
            >
              {upiApps.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
          <div>
            <p className="text-[15px] font-medium">Open straight to the scanner</p>
            <p className="text-[12px] text-ink-3">When you open Kosh on this phone, it's ready to scan a UPI QR.</p>
          </div>
          <Toggle checked={launchScan} onChange={(v) => { setLaunchScan(v); setLaunchScanState(v) }} label="Open straight to the scanner" />
        </div>
      </div>

      <SectionTitle title="Manage" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        <ListRow onClick={() => navigate('/accounts')} left={<RowIcon className="bg-accent/12 text-accent"><Wallet className="size-[18px]" /></RowIcon>} title="Accounts" chevron />
        <div className="border-t border-line" />
        <ListRow onClick={() => navigate('/categories')} left={<RowIcon className="bg-warn/12 text-warn"><Tag className="size-[18px]" /></RowIcon>} title="Categories" chevron />
        <div className="border-t border-line" />
        <ListRow onClick={() => navigate('/budgets')} left={<RowIcon className="bg-pos/12 text-pos"><Target className="size-[18px]" /></RowIcon>} title="Budgets" chevron />
        {d.user.isOwner && (
          <>
            <div className="border-t border-line" />
            <ListRow onClick={() => navigate('/members')} left={<RowIcon className="bg-accent/12 text-accent"><UserPlus className="size-[18px]" /></RowIcon>} title="Members" subtitle="Everyone who has signed up" chevron />
          </>
        )}
        <div className="border-t border-line" />
        <ListRow onClick={exportCsv} left={<RowIcon className="bg-lend/12 text-lend"><Download className="size-[18px]" /></RowIcon>} title="Export to CSV" subtitle="Every transaction, for Excel or Sheets" />
      </div>

      {!standalone && (
        <>
          <SectionTitle title="App" />
          <div className="flex items-center gap-3 rounded-[22px] bg-surface p-4 shadow-card">
            <RowIcon className="bg-accent/12 text-accent">
              <Smartphone className="size-[18px]" />
            </RowIcon>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-medium">Install Kosh</p>
              <p className="text-[12px] text-ink-3">{install ? 'Add it to your home screen. Opens full screen, works offline.' : 'In your browser menu, choose "Add to Home Screen".'}</p>
            </div>
            {install && (
              <Button size="sm" onClick={() => install.prompt().then(() => setInstall(null))}>
                Install
              </Button>
            )}
          </div>
        </>
      )}

      <SectionTitle title="Security" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        <ListRow onClick={() => setPwOpen(true)} left={<RowIcon className="bg-surface-3 text-ink-2"><KeyRound className="size-[18px]" /></RowIcon>} title={d.user.hasPassword ? 'Change password' : 'Set a password'} chevron />
        {d.user.googleEmail ? (
          <>
            <div className="border-t border-line" />
            <ListRow
              left={<RowIcon className="bg-surface-2"><GoogleMark className="size-[18px]" /></RowIcon>}
              title="Google"
              subtitle={d.user.googleEmail || 'Connected'}
              right={
                d.user.hasPassword ? (
                  <Button size="sm" variant="secondary" loading={unlinkGoogle.isPending} onClick={() => unlinkGoogle.mutate()}>
                    Disconnect
                  </Button>
                ) : undefined
              }
            />
          </>
        ) : (
          googleAvailable && (
            <>
              <div className="border-t border-line" />
              <a href="/auth/google?intent=link" className="block">
                <ListRow left={<RowIcon className="bg-surface-2"><GoogleMark className="size-[18px]" /></RowIcon>} title="Connect Google" subtitle="Sign in with your Google account" className="hover:bg-surface-2/60 active:bg-surface-2" chevron />
              </a>
            </>
          )
        )}
        <div className="border-t border-line" />
        <ListRow onClick={signOut} left={<RowIcon className="bg-neg/10 text-neg"><LogOut className="size-[18px]" /></RowIcon>} title={<span className="text-neg">Sign out</span>} />
      </div>

      <p className="mt-8 text-center text-[12px] text-ink-3">Kosh 0.1 · Open source · Your data lives on your server</p>

      <Sheet
        open={pwOpen}
        onOpenChange={setPwOpen}
        title={d.user.hasPassword ? 'Change password' : 'Set a password'}
        description={d.user.hasPassword ? 'Other devices will be signed out.' : `Sign in with @${d.user.username} and this password, as well as with Google.`}
      >
        {pwOpen && <PasswordForm hasPassword={d.user.hasPassword} onDone={() => setPwOpen(false)} />}
      </Sheet>
    </div>
  )
}

function RowIcon({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', className)}>{children}</span>
}

function PasswordForm({ hasPassword, onDone }: { hasPassword: boolean; onDone: () => void }) {
  const update = useUpdateMe()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  return (
    <div className="space-y-4">
      {hasPassword && (
        <Field label="Current password">
          <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
        </Field>
      )}
      <Field label="New password" hint="At least 8 characters">
        <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Field>
      <Button
        size="lg"
        className="w-full"
        loading={update.isPending}
        onClick={() =>
          update.mutate(
            { currentPassword: current, newPassword: next },
            {
              onSuccess: () => {
                toast.success(hasPassword ? 'Password changed' : 'Password set')
                onDone()
              },
            },
          )
        }
      >
        {hasPassword ? 'Change password' : 'Set password'}
      </Button>
    </div>
  )
}
