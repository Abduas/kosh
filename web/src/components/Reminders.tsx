import { BellRing, CalendarPlus, ChevronRight, Copy } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { api, errorMessage } from '../lib/api'
import { calendarUrl, disablePush, enablePush, usePushServer, usePushState } from '../lib/push'
import { navigate } from '../lib/router'
import { Button, Toggle } from './ui'

function rememberCalendar() {
  try {
    localStorage.setItem('kosh:calendar', '1')
  } catch {}
}

function hasCalendar(): boolean {
  try {
    return localStorage.getItem('kosh:calendar') === '1'
  } catch {
    return false
  }
}

/** Settings → Reminders: notifications on this phone, and the calendar feed. */
export function RemindersSettings() {
  const server = usePushServer().data
  const state = usePushState().data
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)

  const toggle = async (on: boolean) => {
    setBusy(true)
    try {
      if (on) {
        await enablePush(server!.publicKey!)
        toast.success("Notifications are on. You'll hear from Kosh at 9 am when something's due.")
      } else {
        await disablePush()
        toast('Notifications are off on this phone')
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    setTesting(true)
    try {
      await api('POST', '/api/push/test')
      toast.success('Sent. It should show up in a few seconds.')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setTesting(false)
    }
  }

  const subscribe = async () => {
    try {
      const url = await calendarUrl()
      rememberCalendar()
      window.location.href = url
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const copy = async () => {
    try {
      const url = (await calendarUrl()).replace(/^webcal:/, 'https:')
      await navigator.clipboard.writeText(url)
      rememberCalendar()
      toast.success('Calendar link copied. Keep it private: anyone with it sees your due dates.')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  let pushHint: ReactNode = 'A notification at 9 am, a month, a week and a day before.'
  if (server && !server.available) pushHint = "Notifications aren't set up on this Kosh yet."
  else if (state === 'install-first') pushHint = 'Add Kosh to your Home Screen first (Share → Add to Home Screen), then turn this on there.'
  else if (state === 'unsupported') pushHint = "This browser can't show notifications. Use the calendar instead."
  else if (state === 'denied') pushHint = 'Blocked. Allow notifications for Kosh in your phone’s Settings.'

  const canToggle = !!server?.available && (state === 'on' || state === 'off')

  return (
    <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="text-[15px] font-medium">Notifications on this phone</p>
          <p className="text-[12px] text-ink-3">{pushHint}</p>
        </div>
        <Toggle checked={state === 'on'} onChange={(v) => canToggle && !busy && toggle(v)} label="Notifications on this phone" />
      </div>
      {state === 'on' && (
        <div className="border-t border-line px-4 py-2.5">
          <Button size="sm" variant="secondary" loading={testing} onClick={test}>
            Send a test
          </Button>
        </div>
      )}
      <div className="flex items-center gap-3 border-t border-line px-4 py-3">
        <button onClick={subscribe} className="flex min-w-0 flex-1 items-center gap-3 text-left">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
            <CalendarPlus className="size-[18px]" />
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-medium">Add to Calendar</span>
            <span className="block text-[12px] text-ink-3">Expiry and service dates in your phone's calendar, with alerts. Updates by itself.</span>
          </span>
        </button>
        <button onClick={copy} aria-label="Copy calendar link" className="press grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
          <Copy className="size-4" />
        </button>
      </div>
    </div>
  )
}

/** On Due: one row nudging towards reminders until they're set up. */
export function RemindersPrompt() {
  const state = usePushState().data
  if (!state || state === 'on' || hasCalendar()) return null
  return (
    <button onClick={() => navigate('/settings?reminders=1')} className="press mb-4 flex w-full items-center gap-3 rounded-2xl bg-surface px-4 py-3 text-left">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent/12 text-accent">
        <BellRing className="size-[18px]" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold tracking-tight">Get reminded</span>
        <span className="block text-[12px] text-ink-3">A notification or calendar alert before anything's due</span>
      </span>
      <ChevronRight className="size-4 text-ink-3" />
    </button>
  )
}
