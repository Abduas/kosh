import { motion } from 'motion/react'
import { ArrowRight, Lock, ShieldCheck, Sparkles, Users } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { api, errorMessage } from '../lib/api'
import { Button, Field, TextInput } from '../components/ui'

export function AuthScreen({ mode, onDone }: { mode: 'setup' | 'login'; onDone: () => void }) {
  const [name, setName] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (mode === 'setup') await api('POST', '/api/auth/setup', { name, username, password })
      else await api('POST', '/api/auth/login', { username, password })
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

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
        <motion.form
          onSubmit={submit}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto w-full max-w-[380px]"
        >
          <img src="/icon.svg" alt="" className="mb-6 size-14 md:hidden" />
          <h2 className="text-[30px] font-bold tracking-[-0.03em]">{mode === 'setup' ? 'Welcome to Kosh' : 'Welcome back'}</h2>
          <p className="mt-1.5 text-[15px] text-ink-2">
            {mode === 'setup' ? 'Create your account. You are the owner of this Kosh.' : 'Sign in to see your money.'}
          </p>

          <div className="mt-8 space-y-4">
            {mode === 'setup' && (
              <Field label="Your name">
                <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Abdullah" autoComplete="name" />
              </Field>
            )}
            <Field label="Username">
              <TextInput
                autoFocus={mode === 'login'}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="abdullah"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </Field>
            <Field label="Password" hint={mode === 'setup' ? 'At least 8 characters' : undefined}>
              <TextInput
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
              />
            </Field>
          </div>

          {error && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-2xl bg-neg/10 px-4 py-3 text-[14px] font-medium text-neg">
              {error}
            </motion.p>
          )}

          <Button type="submit" size="lg" loading={busy} className="mt-6 w-full">
            {mode === 'setup' ? 'Create account' : 'Sign in'}
            {!busy && <ArrowRight className="size-5" />}
          </Button>
          <p className="mt-6 flex items-center justify-center gap-1.5 text-[12px] text-ink-3">
            <Lock className="size-3.5" /> Stored on your own server, never shared
          </p>
        </motion.form>
      </div>
    </div>
  )
}
