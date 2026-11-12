import { useQuery } from '@tanstack/react-query'
import { motion } from 'motion/react'
import { ArrowRight, Lock, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { api, errorMessage } from '../lib/api'
import { clearParam, navigate } from '../lib/router'
import { Button, Field, TextInput } from '../components/ui'

type Mode = 'setup' | 'login' | 'join'

export function AuthScreen({ mode, invite, google, onDone }: { mode: Mode; invite?: string; google: boolean; onDone: () => void }) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Google sign-in comes back here with a message when it didn't work.
  useEffect(() => {
    const msg = new URLSearchParams(location.search).get('authError')
    if (msg) {
      setError(msg)
      clearParam('authError')
    }
  }, [])

  // Keyed under 'auth' so it's never saved to the device.
  const inviteInfo = useQuery({
    queryKey: ['auth', 'invite', invite],
    queryFn: () => api<{ invitedBy: string }>('GET', `/api/auth/invite/${encodeURIComponent(invite!)}`),
    enabled: mode === 'join' && !!invite,
    retry: false,
    staleTime: Infinity,
  })

  const creating = mode !== 'login'

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'setup') await api('POST', '/api/auth/setup', { name, username, password })
      else if (mode === 'join') await api('POST', '/api/auth/join', { token: invite, name, username, password })
      else await api('POST', '/api/auth/login', { username, password })
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const googleHref = `/auth/google?intent=${mode}` + (mode === 'join' ? `&invite=${encodeURIComponent(invite ?? '')}` : '')

  const title = mode === 'setup' ? 'Welcome to Kosh' : mode === 'join' ? 'Join Kosh' : 'Welcome back'
  const subtitle =
    mode === 'setup'
      ? 'Create your account. You are the owner of this Kosh.'
      : mode === 'join'
        ? `${inviteInfo.data?.invitedBy ?? 'Someone'} invited you. Your money stays private to you.`
        : 'Sign in to see your money.'

  const inviteGone = mode === 'join' && inviteInfo.isError

  return (
    <div className="relative grid min-h-dvh overflow-hidden md:grid-cols-[1.1fr_1fr]">
      {/* Brand panel */}
      <div className="hero-surface relative hidden flex-col justify-between p-12 md:flex">
        <div className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="size-10 rounded-[12px] ring-1 ring-white/30" />
          <span className="text-[22px] font-bold tracking-tight">Kosh</span>
        </div>
        <div>
          <h1 className="max-w-[460px] text-[44px] font-bold leading-[1.05] tracking-[-0.035em]">Every rupee, every account, everyone who owes you.</h1>
          <div className="mt-10 space-y-4 text-[15px] text-white/85">
            <p className="flex items-center gap-3"><Sparkles className="size-5" /> Add an expense in two taps</p>
            <p className="flex items-center gap-3"><Users className="size-5" /> Track money you lend and borrow</p>
            <p className="flex items-center gap-3"><ShieldCheck className="size-5" /> Self-hosted. Your data stays yours.</p>
          </div>
        </div>
        <p className="text-[13px] text-white/60">Open source · Go + React + SQLite</p>
      </div>

      <div className="flex flex-col justify-center px-6 py-12 sm:px-12">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto w-full max-w-[380px]"
        >
          <img src="/icon.svg" alt="" className="mb-6 size-14 md:hidden" />
          <h2 className="text-[30px] font-bold tracking-[-0.03em]">{inviteGone ? 'Invite expired' : title}</h2>
          <p className="mt-1.5 text-[15px] text-ink-2">{inviteGone ? errorMessage(inviteInfo.error) : subtitle}</p>

          {inviteGone ? (
            <Button size="lg" className="mt-8 w-full" onClick={() => navigate('/', { replace: true })}>
              Go to sign in
            </Button>
          ) : (
            <>
              {google && (
                <>
                  <a
                    href={googleHref}
                    className="press mt-8 flex h-[52px] w-full items-center justify-center gap-3 rounded-2xl bg-surface text-[16px] font-semibold shadow-card ring-1 ring-line"
                  >
                    <GoogleMark /> Continue with Google
                  </a>
                  <div className="my-6 flex items-center gap-3 text-[12px] font-medium text-ink-3">
                    <span className="h-px flex-1 bg-line" /> or with a username <span className="h-px flex-1 bg-line" />
                  </div>
                </>
              )}

              <form onSubmit={submit} className={google ? '' : 'mt-8'}>
                <div className="space-y-4">
                  {creating && (
                    <Field label="Your name">
                      <TextInput autoFocus={!google} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" />
                    </Field>
                  )}
                  <Field label="Username">
                    <TextInput
                      autoFocus={mode === 'login' && !google}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="username"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  </Field>
                  <Field label="Password" hint={creating ? 'At least 8 characters' : undefined}>
                    <TextInput
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      autoComplete={creating ? 'new-password' : 'current-password'}
                    />
                  </Field>
                </div>

                {error && (
                  <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-2xl bg-neg/10 px-4 py-3 text-[14px] font-medium text-neg">
                    {error}
                  </motion.p>
                )}

                <Button type="submit" size="lg" loading={busy} className="mt-6 w-full">
                  {mode === 'login' ? 'Sign in' : 'Create account'}
                  {!busy && <ArrowRight className="size-5" />}
                </Button>
              </form>

              {mode === 'join' && (
                <button onClick={() => navigate('/', { replace: true })} className="press mx-auto mt-5 block text-[14px] font-semibold text-accent">
                  I already have an account
                </button>
              )}
            </>
          )}

          <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-ink-3">
            <Lock className="size-3.5" /> Stored on your own server, never shared
          </p>
        </motion.div>
      </div>
    </div>
  )
}

/** Google's "G", as its sign-in button guidelines ask for. */
export function GoogleMark({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}
