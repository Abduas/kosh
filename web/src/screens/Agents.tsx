import { useMutation, useQuery } from '@tanstack/react-query'
import { Bot, Check, Copy, MessageCircle, Send, Unplug } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Sheet } from '../components/Sheet'
import { Button, Card, EmptyState, Field, Glyph, ScreenHeader, SectionTitle, Segmented, TextInput, cn } from '../components/ui'
import { api, errorMessage, type AgentConn, type AgentKey } from '../lib/api'
import { platform } from '../lib/device'
import { haptic } from '../lib/look'
import { queryClient } from '../lib/queries'
import { clearParam, useLocation } from '../lib/router'

// Settings → AI agents: talk to Kosh from WhatsApp (Instinct), Grok,
// ChatGPT, Claude or any agent with its own computer.

export type AgentKind = 'instinct' | 'grok' | 'chatgpt' | 'claude' | 'other'

type AgentInfo = {
  id: AgentKind
  name: string
  icon: string
  color: string
  blurb: string
  /** How it connects: a link it reads, or Kosh as a connector with sign-in. */
  via: 'link' | 'connector'
  steps?: string[]
}

export const AGENTS: AgentInfo[] = [
  {
    id: 'instinct',
    name: 'Instinct',
    icon: '✨',
    color: '#F97316',
    blurb: 'Your agent on WhatsApp or iMessage',
    via: 'link',
  },
  {
    id: 'grok',
    name: 'Grok',
    icon: '𝕏',
    color: '#111111',
    blurb: 'Add Kosh as a connector',
    via: 'connector',
    steps: [
      'Open grok.com (or the Grok app) and go to Connectors.',
      'Choose Add custom connector and paste the Kosh link below.',
      'Tap Connect. Kosh opens: sign in and tap Allow.',
    ],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    icon: '◎',
    color: '#10A37F',
    blurb: 'Add Kosh as a connector',
    via: 'connector',
    steps: [
      'In ChatGPT open Settings → Apps & Connectors (turn on Developer mode under Advanced if you don’t see Create).',
      'Create a connector, paste the Kosh link below, and pick OAuth for sign-in.',
      'Kosh opens: sign in and tap Allow. Then switch the connector on in a chat.',
    ],
  },
  {
    id: 'claude',
    name: 'Claude',
    icon: '✳︎',
    color: '#D97757',
    blurb: 'Add Kosh as a connector',
    via: 'connector',
    steps: [
      'In Claude open Settings → Connectors.',
      'Choose Add custom connector and paste the Kosh link below.',
      'Tap Connect. Kosh opens: sign in and tap Allow.',
    ],
  },
  {
    id: 'other',
    name: 'Another agent',
    icon: '🤖',
    color: '#64748B',
    blurb: 'OpenClaw, or any agent with a computer',
    via: 'link',
  },
]

function useAgents() {
  return useQuery({ queryKey: ['agents'], queryFn: () => api<{ connections: AgentConn[]; mcpUrl: string }>('GET', '/api/agents') })
}

function ago(utc: string | null): string {
  if (!utc) return 'Not used yet'
  const min = Math.round((Date.now() - Date.parse(utc)) / 60000)
  if (min < 2) return 'Used just now'
  if (min < 60) return `Used ${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `Used ${h} h ago`
  return `Used ${Math.round(h / 24)} d ago`
}

export function AgentsScreen() {
  const q = useAgents()
  const { search } = useLocation()
  const [open, setOpen] = useState<AgentKind | null>(null)

  // From onboarding: /settings/agents?connect=instinct
  useEffect(() => {
    const c = search.get('connect') as AgentKind | null
    if (c && AGENTS.some((a) => a.id === c)) {
      setOpen(c)
      clearParam('connect')
    }
  }, [search])

  const conns = q.data?.connections ?? []
  return (
    <div>
      <ScreenHeader title="AI agents" subtitle="Tell an agent “spent ₹200 on lunch” and it lands in Kosh" back="/settings" />

      <div className="grid grid-cols-2 gap-2.5">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              haptic(6)
              setOpen(a.id)
            }}
            className={cn('press flex flex-col items-start gap-2 rounded-[22px] bg-surface p-3.5 text-left shadow-card', a.id === 'instinct' && 'col-span-2 flex-row items-center')}
          >
            <Glyph icon={a.icon} color={a.color} size={a.id === 'instinct' ? 48 : 40} />
            <span className="min-w-0">
              <span className="block text-[16px] font-semibold tracking-tight">{a.name}</span>
              <span className="block text-[12px] leading-snug text-ink-3">{a.blurb}</span>
            </span>
          </button>
        ))}
      </div>

      <SectionTitle title="Connected" />
      {q.isLoading ? null : conns.length === 0 ? (
        <Card>
          <EmptyState icon={<Bot className="size-7" />} title="No agents yet" body="Pick one above. It takes a minute, and you can disconnect any time." />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {conns.map((c) => (
            <ConnectionCard key={c.id} c={c} />
          ))}
        </div>
      )}

      <p className="mt-6 px-1 text-[12px] leading-relaxed text-ink-3">
        Agents can read your records and, if you allow it, add entries. They can’t move money, change settings, or delete anything they didn’t add. Every entry an agent adds is marked in Kosh.
      </p>

      <ConnectSheet kind={open} onClose={() => setOpen(null)} mcpUrl={q.data?.mcpUrl ?? `${location.origin}/mcp`} />
    </div>
  )
}

function ConnectionCard({ c }: { c: AgentConn }) {
  const [sure, setSure] = useState(false)
  const setScope = useMutation({
    mutationFn: (scope: 'read' | 'write') => api('PATCH', `/api/agents/${c.id}`, { scope }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['agents'] }),
  })
  const remove = useMutation({
    mutationFn: () => api('DELETE', `/api/agents/${c.id}`),
    onSuccess: () => {
      toast.success(`${c.name} disconnected`)
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })
  const info = AGENTS.find((a) => c.name.toLowerCase().includes(a.id === 'chatgpt' ? 'chatgpt' : a.name.toLowerCase()))
  return (
    <div className="rounded-[22px] bg-surface p-3.5 shadow-card">
      <div className="flex items-center gap-3">
        <Glyph icon={info?.icon ?? '🤖'} color={info?.color ?? '#64748B'} size={40} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-semibold">{c.name}</p>
          <p className="text-[12px] text-ink-3">
            {c.kind === 'oauth' ? 'Connector' : 'Private link'} · {ago(c.lastUsedAt)}
          </p>
        </div>
        <button
          onClick={() => {
            if (!sure) {
              setSure(true)
              haptic(10)
              setTimeout(() => setSure(false), 3000)
              return
            }
            remove.mutate()
          }}
          aria-label={`Disconnect ${c.name}`}
          className={cn('press flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold', sure ? 'bg-neg text-white' : 'bg-neg/10 text-neg')}
        >
          <Unplug className="size-4" /> {sure ? 'Sure?' : 'Disconnect'}
        </button>
      </div>
      <Segmented
        id={`scope-${c.id}`}
        size="sm"
        className="mt-3"
        value={c.scope}
        onChange={(s) => setScope.mutate(s)}
        options={[
          { value: 'write', label: 'See and add' },
          { value: 'read', label: 'See only' },
        ]}
      />
    </div>
  )
}

function ConnectSheet({ kind, onClose, mcpUrl }: { kind: AgentKind | null; onClose: () => void; mcpUrl: string }) {
  const [shown, setShown] = useState<AgentKind | null>(kind)
  if (kind && kind !== shown) setShown(kind)
  const info = AGENTS.find((a) => a.id === (kind ?? shown))
  return (
    <Sheet open={!!kind} onOpenChange={(o) => !o && onClose()} title={info ? `Connect ${info.name}` : ''}>
      {info && (info.via === 'link' ? <LinkFlow key={info.id} info={info} onDone={onClose} /> : <ConnectorFlow info={info} mcpUrl={mcpUrl} />)}
    </Sheet>
  )
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/12 text-[13px] font-bold text-accent">{n}</span>
      <span className="text-[14px] leading-relaxed text-ink-2">{children}</span>
    </li>
  )
}

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    haptic(8)
    toast.success(`${what} copied`)
  } catch {
    toast.error("Couldn't copy. Select it and copy by hand.")
  }
}

/** Grok, ChatGPT, Claude: paste Kosh's link into their connectors, sign in, Allow. */
function ConnectorFlow({ info, mcpUrl }: { info: AgentInfo; mcpUrl: string }) {
  return (
    <div className="space-y-5">
      <ol className="space-y-3">
        {info.steps!.map((s, i) => (
          <Step key={i} n={i + 1}>
            {s}
          </Step>
        ))}
      </ol>
      <Field label="Kosh link for connectors">
        <div className="flex gap-2">
          <TextInput readOnly value={mcpUrl} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[13px]" />
          <Button variant="secondary" onClick={() => copy(mcpUrl, 'Link')} aria-label="Copy link" icon={<Copy className="size-4" />} />
        </div>
      </Field>
      <p className="rounded-2xl bg-surface-2 px-3.5 py-3 text-[13px] leading-relaxed text-ink-2">
        When Kosh asks, choose <b>See and add</b> so you can say “add ₹500 petrol for the Activa”, or <b>See only</b> for questions like “what did I spend on food this month?”.
        Menus in these apps change now and then; look for <b>Connectors</b> if a step has moved.
      </p>
      <p className="px-1 text-[12px] text-ink-3">Once connected, it appears under Connected here.</p>
    </div>
  )
}

/** Instinct and other agents with a computer: a private link sent in their chat. */
function LinkFlow({ info, onDone }: { info: AgentInfo; onDone: () => void }) {
  const [name, setName] = useState(info.id === 'instinct' ? 'Instinct' : '')
  const [scope, setScope] = useState<'write' | 'read'>('write')
  const create = useMutation({
    mutationFn: () => api<AgentKey>('POST', '/api/agents', { name: name.trim() || info.name, scope }),
    onSuccess: () => {
      haptic(15)
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (e) => toast.error(errorMessage(e)),
  })
  const made = create.data

  if (!made) {
    return (
      <div className="space-y-5">
        <ol className="space-y-3">
          <Step n={1}>Kosh makes a private link just for {info.id === 'instinct' ? 'Instinct' : 'your agent'}.</Step>
          <Step n={2}>{info.id === 'instinct' ? 'You send it to Instinct on WhatsApp or iMessage, with one tap.' : 'You give it to your agent.'}</Step>
          <Step n={3}>It reads the instructions and connects. Then just tell it what you spent.</Step>
        </ol>
        {info.id !== 'instinct' && (
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenClaw" maxLength={40} />
          </Field>
        )}
        <div>
          <p className="mb-2 px-1 text-[13px] font-medium text-ink-2">It may</p>
          <div className="space-y-2">
            {(
              [
                ['write', 'See and add', 'Record what you tell it: expenses, income, loans, fuel, renewed papers'],
                ['read', 'See only', 'Answer questions about your money and vehicles, add nothing'],
              ] as const
            ).map(([v, t, d]) => (
              <button key={v} onClick={() => setScope(v)} className={cn('press flex w-full items-start gap-3 rounded-2xl p-3 text-left', scope === v ? 'bg-ink text-bg' : 'bg-surface-2')}>
                <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full', scope === v ? 'bg-accent text-white' : 'bg-surface')}>{scope === v && <Check className="size-3.5" strokeWidth={3} />}</span>
                <span>
                  <span className="block text-[15px] font-semibold">{t}</span>
                  <span className={cn('block text-[12px]', scope === v ? 'opacity-70' : 'text-ink-3')}>{d}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
        <Button size="lg" className="w-full" loading={create.isPending} onClick={() => create.mutate()}>
          Make the link
        </Button>
      </div>
    )
  }

  const wa = `https://wa.me/?text=${encodeURIComponent(made.message)}`
  const imsg = `sms:&body=${encodeURIComponent(made.message)}`
  return (
    <div className="space-y-4">
      <p className="text-[14px] text-ink-2">
        {info.id === 'instinct'
          ? 'Send this to your Instinct chat. It opens the link, reads how Kosh works, and replies when it’s connected.'
          : 'Send or paste this to your agent. It opens the link and reads how to use Kosh.'}
      </p>
      <div className="whitespace-pre-wrap rounded-[20px] bg-surface-2 p-3.5 text-[13px] leading-relaxed [overflow-wrap:anywhere]">{made.message}</div>
      <div className="grid grid-cols-2 gap-2">
        <a href={wa} target="_blank" rel="noopener" className="press flex h-12 items-center justify-center gap-2 rounded-2xl bg-[#25D366] text-[15px] font-semibold text-white">
          <MessageCircle className="size-5" /> WhatsApp
        </a>
        {platform === 'ios' ? (
          <a href={imsg} className="press flex h-12 items-center justify-center gap-2 rounded-2xl bg-[#0A84FF] text-[15px] font-semibold text-white">
            <Send className="size-5" /> iMessage
          </a>
        ) : (
          <button onClick={() => copy(made.link, 'Link')} className="press flex h-12 items-center justify-center gap-2 rounded-2xl bg-surface-2 text-[15px] font-semibold">
            <Copy className="size-4" /> Copy link
          </button>
        )}
      </div>
      <Button size="lg" variant="secondary" className="w-full" icon={<Copy className="size-4" />} onClick={() => copy(made.message, 'Message')}>
        Copy message
      </Button>
      <p className="px-1 text-[12px] leading-relaxed text-ink-3">
        Keep this link private: it’s the key to your records. If it ever leaks, disconnect the agent here and make a new link. Try it: tell {made.connection.name} “I spent ₹120 on tea today”.
      </p>
      <Button size="lg" variant="ghost" className="w-full" onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
