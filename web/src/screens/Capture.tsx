import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Copy, MessageSquareText, Sparkles, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Button, ScreenHeader, SectionTitle, Segmented, Skeleton, Toggle, cn } from '../components/ui'
import { api, type CaptureSetup, type CaptureTest } from '../lib/api'
import { money } from '../lib/format'
import { haptic } from '../lib/look'
import { queryClient, useData, useUpdateMe } from '../lib/queries'
import { platform } from '../lib/upi'
import { captureSource } from './Review'

// Keyed under 'auth' so the link is never saved in the app's offline cache.
const SETUP_KEY = ['auth', 'capture']

export function useCaptureSetup(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: SETUP_KEY,
    queryFn: () => api<CaptureSetup>('GET', '/api/captures/setup'),
    // While waiting for the first message, check often so the status turns
    // green the moment the phone is connected.
    refetchInterval: (q) => (opts.poll && q.state.data?.enabled && !q.state.data.lastUsedAt ? 4000 : false),
  })
}

const timezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata'
  } catch {
    return 'Asia/Kolkata'
  }
}

/** "5 min ago", for when the last message arrived. */
export function ago(utc: string): string {
  const mins = Math.round((Date.now() - new Date(utc).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

const daysSince = (utc: string) => (Date.now() - new Date(utc).getTime()) / 86_400_000

// ---- Trigger words ----
//
// An iPhone automation listens for one word. The best word is one your bank
// puts in every transaction message: a currency word covers money in and out
// with a single automation ("INR" for Canara, Axis), a direction word needs
// its opposite too ("debited" and "credited" for SBI).

type Trigger = { word: string; why: string; both?: boolean; pair?: string }

const triggerWords: Trigger[] = [
  { word: 'INR', why: 'Money in and out', both: true },
  { word: 'Rs.', why: 'Money in and out', both: true },
  { word: 'debited', why: 'Money out', pair: 'credited' },
  { word: 'Dr.', why: 'Money out', pair: 'Cr.' },
  { word: 'Sent Rs', why: 'UPI money out', pair: 'credited' },
  { word: 'spent', why: 'Card payments' },
  { word: 'credited', why: 'Money in', pair: 'debited' },
  { word: 'Cr.', why: 'Money in', pair: 'Dr.' },
  { word: 'received', why: 'Money in', pair: 'debited' },
]

/** The words to set up for a bank, judged from one of its messages. */
export function triggersFor(text: string): Trigger[] {
  const lower = text.toLowerCase()
  const best = triggerWords.find((t) => lower.includes(t.word.toLowerCase()))
  if (!best) return []
  if (best.both || !best.pair) return [best]
  return [best, triggerWords.find((t) => t.word === best.pair)!]
}

// With no message checked yet: what most banks use.
const defaultTriggers = [triggerWords[0], triggerWords[2], triggerWords[6], triggerWords[5]]

const WORDS_KEY = 'kosh:captureWords'

function readWords(): Trigger[] {
  try {
    const saved = JSON.parse(localStorage.getItem(WORDS_KEY) ?? 'null') as string[] | null
    const list = saved?.map((w) => triggerWords.find((t) => t.word === w)).filter((t): t is Trigger => !!t)
    if (list?.length) return list
  } catch {}
  return []
}

function saveWords(list: Trigger[]) {
  try {
    localStorage.setItem(WORDS_KEY, JSON.stringify(list.map((t) => t.word)))
  } catch {}
}

/**
 * Auto-capture setup. A web app on iPhone can't read SMS, so the Shortcuts app
 * forwards bank messages to a private link, and Kosh does the rest.
 */
export function CaptureSettings() {
  const d = useData()
  const setup = useCaptureSetup({ poll: true })
  const updateMe = useUpdateMe()
  const [copied, setCopied] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [phone, setPhone] = useState<'ios' | 'android'>(platform === 'android' ? 'android' : 'ios')
  const [words, setWords] = useState<Trigger[]>(readWords)

  const save = useMutation({
    mutationFn: (body: { rotate?: boolean }) => api<CaptureSetup>('PUT', '/api/captures/setup', { timezone: timezone(), ...body }),
    onSuccess: (s, body) => {
      queryClient.setQueryData(SETUP_KEY, s)
      if (body.rotate) toast.success(s.shortcutUrl ? 'New link made. Tap Connect again.' : 'New link made. Paste it into your automations.')
    },
  })
  const turnOff = useMutation({
    mutationFn: () => api('DELETE', '/api/captures/setup'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SETUP_KEY })
      toast('Auto-capture is off. Your automations will stop working.')
    },
  })

  const s = setup.data
  const link = s?.token ? `${location.origin}/api/capture/${s.token}` : ''

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      haptic(10)
      setCopied(what)
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000)
    } catch {
      toast.error("Couldn't copy. Press and hold the text to copy it.")
    }
  }

  const onWords = (list: Trigger[]) => {
    if (!list.length) return
    setWords(list)
    saveWords(list)
  }

  return (
    <div>
      <ScreenHeader title="Auto-capture" subtitle="Kosh records UPI and card payments from your bank's SMS, so you don't type them." back="/settings" />

      {setup.isPending ? (
        <Skeleton className="h-24" />
      ) : !s?.enabled ? (
        <div className="rounded-[22px] bg-surface p-5 text-center shadow-card">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-accent/12 text-accent">
            <MessageSquareText className="size-7" />
          </span>
          <p className="mx-auto mt-3 max-w-[300px] text-[14px] text-ink-2">
            Your phone sends each bank message to Kosh. Payees Kosh knows are saved on their own; the rest wait in a short review list.
          </p>
          <Button className="mt-4 w-full" size="lg" loading={save.isPending} onClick={() => save.mutate({})}>
            Set up auto-capture
          </Button>
          <p className="mt-3 text-[12px] text-ink-3">Takes about 2 minutes, once.</p>
        </div>
      ) : (
        <>
          <Status s={s} />

          <SectionTitle title="1 · Your bank's word" />
          <TestMessage words={words} onWords={onWords} copied={copied} onCopy={copy} />

          <SectionTitle title={phone === 'ios' ? '2 · Connect your iPhone' : '2 · Forward bank SMS'} />
          <div className="rounded-[22px] bg-surface p-4 shadow-card">
            <Segmented
              id="capture-phone"
              size="sm"
              className="mb-4"
              value={phone}
              onChange={setPhone}
              options={[
                { value: 'ios', label: 'iPhone' },
                { value: 'android', label: 'Android' },
              ]}
            />
            {phone === 'android' ? (
              <AndroidSteps link={link} copied={copied} onCopy={copy} />
            ) : s.shortcutUrl ? (
              <ShortcutSteps s={s} link={link} words={words.length ? words : defaultTriggers.slice(0, 1)} copied={copied} onCopy={copy} />
            ) : (
              <ManualSteps link={link} words={words.length ? words : defaultTriggers} copied={copied} onCopy={copy} />
            )}
          </div>

          <SectionTitle title="Options" />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-[15px] font-medium">Save known payees automatically</p>
                <p className="text-[12px] text-ink-3">Paid the same shop or UPI ID before? Kosh files it the same way. Otherwise it waits for you.</p>
              </div>
              <Toggle checked={d.user.prefs.captureAuto ?? true} onChange={(v) => updateMe.mutate({ prefs: { captureAuto: v } })} label="Save known payees automatically" />
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
              <div>
                <p className="text-[15px] font-medium">New link</p>
                <p className="text-[12px] text-ink-3">If someone else got your link. The old one stops working.</p>
              </div>
              <Button
                size="sm"
                variant={confirmReset ? 'danger' : 'secondary'}
                loading={save.isPending}
                onClick={() => {
                  if (!confirmReset) {
                    setConfirmReset(true)
                    setTimeout(() => setConfirmReset(false), 3000)
                    return
                  }
                  setConfirmReset(false)
                  save.mutate({ rotate: true })
                }}
              >
                {confirmReset ? 'Sure?' : 'Reset'}
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
              <p className="text-[15px] font-medium">Turn off</p>
              <Button size="sm" variant="danger" loading={turnOff.isPending} onClick={() => turnOff.mutate()}>
                Turn off
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Status({ s }: { s: CaptureSetup }) {
  const last = s.lastUsedAt
  // iOS updates sometimes switch automations back to "Ask Before Running",
  // and then nothing arrives. A few quiet days after it worked is the sign.
  const quiet = !!last && daysSince(last) >= 3
  const tone = !last ? 'wait' : quiet ? 'quiet' : 'ok'
  return (
    <div className={cn('flex items-center gap-3 rounded-[22px] p-4', tone === 'ok' ? 'bg-pos/10' : tone === 'quiet' ? 'bg-warn/12' : 'bg-surface shadow-card')}>
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', tone === 'ok' ? 'bg-pos text-white' : 'bg-warn/15 text-warn')}>
        {tone === 'ok' ? <Check className="size-5" strokeWidth={3} /> : tone === 'quiet' ? <TriangleAlert className="size-5" /> : <Sparkles className="size-5" />}
      </span>
      <div className="min-w-0">
        <p className="text-[15px] font-semibold">{tone === 'ok' ? 'Working' : tone === 'quiet' ? `Quiet for ${ago(last!).replace(' ago', '')}` : 'Waiting for your phone'}</p>
        <p className="text-[12px] text-ink-2">
          {tone === 'ok' && `Last message ${ago(last!)}${s.saved ? ` · ${s.saved} payment${s.saved === 1 ? '' : 's'} recorded` : ''}`}
          {tone === 'quiet' && 'If you have paid since, open Shortcuts → Automation and check each one still says Run Immediately. Low Power Mode can also pause them.'}
          {tone === 'wait' && 'Finish the steps below. This turns green as soon as your phone sends something.'}
        </p>
      </div>
    </div>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3 text-[14px] leading-snug text-ink-2">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/12 text-[12px] font-bold text-accent">{n}</span>
      <span className="min-w-0 flex-1 [&_b]:font-semibold [&_b]:text-ink">{children}</span>
    </li>
  )
}

type CopyProps = { copied: string | null; onCopy: (text: string, what: string) => void }

/** A word to type, copied on tap. */
function Word({ w, copied, onCopy }: { w: string } & CopyProps) {
  return (
    <button onClick={() => onCopy(w, w)} className="press inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 align-baseline font-mono text-[13px] font-semibold text-ink">
      {w}
      {copied === w ? <Check className="size-3 text-pos" /> : <Copy className="size-3 text-ink-3" />}
    </button>
  )
}

function LinkBox({ link, copied, onCopy }: { link: string } & CopyProps) {
  return (
    <button onClick={() => onCopy(link, 'link')} className="press flex w-full items-center gap-3 rounded-2xl bg-surface-2 px-3.5 py-3 text-left">
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink-2">{link}</span>
      <span className="flex shrink-0 items-center gap-1 text-[14px] font-semibold text-accent">
        {copied === 'link' ? <Check className="size-4" /> : <Copy className="size-4" />}
        {copied === 'link' ? 'Copied' : 'Copy'}
      </span>
    </button>
  )
}

/** The words, as tappable chips, when there's more than the one in the steps. */
function MoreWords({ words, copied, onCopy }: { words: Trigger[] } & CopyProps) {
  if (words.length < 2) return null
  return (
    <div className="mt-4 rounded-2xl bg-surface-2 p-3.5">
      <p className="text-[13px] font-semibold">Then repeat for {words.length === 2 ? 'this word' : 'these words'}</p>
      <p className="mt-0.5 text-[12px] text-ink-3">Each automation listens for one word.</p>
      <div className="mt-2.5 grid grid-cols-2 gap-2">
        {words.slice(1).map((t) => (
          <button key={t.word} onClick={() => onCopy(t.word, t.word)} className="press rounded-xl bg-surface px-3 py-2 text-left">
            <span className="flex items-center gap-1.5 text-[14px] font-semibold">
              {t.word}
              {copied === t.word ? <Check className="size-3.5 text-pos" /> : <Copy className="size-3.5 text-ink-3" />}
            </span>
            <span className="text-[11px] text-ink-3">{t.why}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * With the shared Kosh shortcut: add it, connect it (Kosh hands it your link
 * through the shortcuts:// URL, no pasting), then point automations at it.
 */
function ShortcutSteps({ s, link, words, copied, onCopy }: { s: CaptureSetup; link: string; words: Trigger[] } & CopyProps) {
  const connected = !!s.lastUsedAt
  const connectUrl = `shortcuts://run-shortcut?name=Kosh&input=text&text=${encodeURIComponent(link)}`
  return (
    <>
      <ol className="space-y-4">
        <Step n={1}>
          <span className="block">
            Add the <b>Kosh</b> shortcut, then come back here.
          </span>
          <a href={s.shortcutUrl} className="press mt-2 flex h-10 items-center justify-center rounded-xl bg-accent text-[14px] font-semibold text-white">
            Add shortcut
          </a>
        </Step>
        <Step n={2}>
          <span className="block">Connect it to your Kosh. If Shortcuts asks, allow it to save a file and reach Kosh.</span>
          <a
            href={connectUrl}
            className={cn('press mt-2 flex h-10 items-center justify-center gap-1.5 rounded-xl text-[14px] font-semibold', connected ? 'bg-pos/12 text-pos' : 'bg-accent text-white')}
          >
            {connected && <Check className="size-4" strokeWidth={3} />}
            {connected ? 'Connected' : 'Connect'}
          </a>
        </Step>
        <Step n={3}>
          In Shortcuts tap <b>Automation</b> → <b>New Automation</b> → <b>Message</b>. Tap <b>Message Contains</b>, type <Word w={words[0].word} copied={copied} onCopy={onCopy} />, choose{' '}
          <b>Run Immediately</b>, tap <b>Next</b> and pick <b>Kosh</b>.
        </Step>
      </ol>
      <MoreWords words={words} copied={copied} onCopy={onCopy} />
      <details className="mt-4 text-[12px] text-ink-3">
        <summary className="cursor-pointer font-medium text-ink-2">Connect didn't work?</summary>
        <p className="mt-2">Run the Kosh shortcut once by hand and paste this link when it asks.</p>
        <div className="mt-2">
          <LinkBox link={link} copied={copied} onCopy={onCopy} />
        </div>
      </details>
    </>
  )
}

/** Without the shared shortcut: each automation sends the message itself. */
function ManualSteps({ link, words, copied, onCopy }: { link: string; words: Trigger[] } & CopyProps) {
  return (
    <>
      <LinkBox link={link} copied={copied} onCopy={onCopy} />
      <p className="mb-4 mt-2 text-[12px] text-ink-3">Your private link. It can only send messages in, never read your money.</p>
      {platform === 'ios' && (
        <a href="shortcuts://" className="press mb-4 flex h-11 items-center justify-center gap-2 rounded-2xl bg-accent text-[15px] font-semibold text-white">
          Open Shortcuts
        </a>
      )}
      <ol className="space-y-3.5">
        <Step n={1}>
          Tap <b>Automation</b>, then <b>New Automation</b> (or <b>+</b>), and choose <b>Message</b>.
        </Step>
        <Step n={2}>
          Tap <b>Message Contains</b> and type <Word w={words[0].word} copied={copied} onCopy={onCopy} />. Choose <b>Run Immediately</b>, then <b>Next</b>.
        </Step>
        <Step n={3}>
          Tap <b>New Blank Automation</b> → <b>Add Action</b>, search <b>Get Contents of URL</b> and add it.
        </Step>
        <Step n={4}>
          Tap <b>URL</b> and paste your link. Tap the <b>›</b> arrow to show more.
        </Step>
        <Step n={5}>
          Set <b>Method</b> to <b>POST</b> and <b>Request Body</b> to <b>JSON</b>. Tap <b>Add new field</b> → <b>Text</b>. Key: <Word w="text" copied={copied} onCopy={onCopy} />, value: tap
          it and pick <b>Shortcut Input</b>. Tap <b>Done</b>.
        </Step>
      </ol>
      <MoreWords words={words} copied={copied} onCopy={onCopy} />
    </>
  )
}

// The body SMS to URL Forwarder sends: the message text in the "text" field.
const FORWARDER_TEMPLATE = '{"text":"%text%"}'
const FORWARDER_URL = 'https://github.com/bogkonstantin/android_income_sms_gateway_webhook'

/**
 * Android can read SMS, so a free forwarding app sends bank messages straight
 * to the link. Filtering by sender means personal messages never leave the phone.
 */
function AndroidSteps({ link, copied, onCopy }: { link: string } & CopyProps) {
  return (
    <>
      <a href={FORWARDER_URL} target="_blank" rel="noreferrer" className="press mb-4 flex h-11 items-center justify-center gap-2 rounded-2xl bg-accent text-[15px] font-semibold text-white">
        Get SMS to URL Forwarder
      </a>
      <ol className="space-y-3.5">
        <Step n={1}>
          Install <b>SMS to URL Forwarder</b>. It's free and open source, on F-Droid or from its GitHub page.
        </Step>
        <Step n={2}>
          Open it, allow it to read SMS, and tap <b>+</b> to add a rule.
        </Step>
        <Step n={3}>
          <b>Sender</b>: the name your bank's messages come from, like <Word w="CANBNK" copied={copied} onCopy={onCopy} />. Add one rule per bank. Or use <Word w="*" copied={copied} onCopy={onCopy} />{' '}
          for every sender; Kosh ignores what isn't a payment.
        </Step>
        <Step n={4}>
          <span className="block">
            <b>URL</b>: paste your link.
          </span>
          <span className="mt-2 block">
            <LinkBox link={link} copied={copied} onCopy={onCopy} />
          </span>
        </Step>
        <Step n={5}>
          <b>Message template</b>: replace it with <Word w={FORWARDER_TEMPLATE} copied={copied} onCopy={onCopy} />, then save.
        </Step>
        <Step n={6}>
          In Android settings, turn off <b>battery optimisation</b> for the app, so it keeps forwarding in the background.
        </Step>
      </ol>
      <p className="mt-4 rounded-2xl bg-surface-2 p-3.5 text-[12px] text-ink-3">
        Prefer Tasker, MacroDroid or Automate? Trigger on <b className="text-ink-2">SMS received</b> and add an <b className="text-ink-2">HTTP request</b>: POST to your link with the body{' '}
        <span className="font-mono">{'{"text":"<message>"}'}</span>.
      </p>
    </>
  )
}

/**
 * Paste one bank SMS: Kosh shows what it reads (nothing is saved) and which
 * word the automation should listen for.
 */
function TestMessage({ words, onWords, copied, onCopy }: { words: Trigger[]; onWords: (list: Trigger[]) => void } & CopyProps) {
  const d = useData()
  const [text, setText] = useState('')
  const test = useMutation({
    mutationFn: (t: string) => api<CaptureTest>('POST', '/api/captures/test', { text: t }),
    onSuccess: (r, t) => r.recognised && onWords(triggersFor(t)),
  })
  const r = test.data
  const found = r?.recognised ? triggersFor(text) : []

  return (
    <div className="rounded-[22px] bg-surface p-4 shadow-card">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          test.reset()
        }}
        rows={3}
        placeholder="Paste one of your bank's payment messages"
        className="w-full resize-none rounded-2xl bg-surface-2 px-3.5 py-3 text-[14px] outline-none placeholder:text-ink-3"
      />
      <Button size="sm" variant="secondary" className="mt-2" disabled={!text.trim()} loading={test.isPending} onClick={() => test.mutate(text)}>
        Check
      </Button>
      {!r && (
        <p className="mt-2 text-[12px] text-ink-3">
          {words.length
            ? `Your word: ${words.map((w) => w.word).join(' and ')}. Check another bank's message to add its word.`
            : 'Kosh shows what it reads, and the word your automation should listen for. Nothing is saved.'}
        </p>
      )}
      {r &&
        (r.recognised ? (
          <div className="mt-3 rounded-2xl bg-pos/10 p-3 text-[14px]">
            <p className="font-semibold">
              {r.sms.direction === 'debit' ? 'Paid' : 'Received'} {money(r.sms.amount)}
              {r.sms.merchant && ` ${r.sms.direction === 'debit' ? 'to' : 'from'} ${r.sms.merchant}`}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-2">
              {r.accountId ? `Account: ${d.accountsById.get(r.accountId)?.name}` : `${captureSource(r.sms)} · no matching account, you'll pick one`}
              {r.sms.ref && ` · Ref ${r.sms.ref}`}
            </p>
            <p className="mt-0.5 text-[12px] text-ink-2">{r.suggestion.known && r.accountId ? 'Known payee: it would be saved automatically.' : 'It would wait in your review list.'}</p>
            {r.sms.last4 && !r.accountId && <p className="mt-1 text-[12px] text-ink-3">Tip: add the last digits ({r.sms.last4}) to that account in Accounts so Kosh picks it.</p>}
            {found.length > 0 && (
              <div className="mt-2.5 border-t border-pos/15 pt-2.5 text-[13px]">
                Listen for <Word w={found[0].word} copied={copied} onCopy={onCopy} />
                {found[0].both ? ': it covers money in and out, so one automation is enough.' : found[1] ? <> and <Word w={found[1].word} copied={copied} onCopy={onCopy} />, one automation each.</> : '.'}
              </div>
            )}
          </div>
        ) : (
          <p className="mt-3 rounded-2xl bg-surface-2 p-3 text-[13px] text-ink-2">
            Kosh doesn't see a payment in this message, so it would be ignored. OTPs, reminders and requests are skipped on purpose.
          </p>
        ))}
    </div>
  )
}
