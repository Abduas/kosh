import { useMutation, useQuery } from '@tanstack/react-query'
import { Copy, Link2, Share, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Sheet } from '../components/Sheet'
import { Avatar, Button, ListRow, ScreenHeader, SectionTitle, Skeleton, cn } from '../components/ui'
import { api, type Invite, type Member } from '../lib/api'
import { queryClient, useData } from '../lib/queries'

const palette = ['#7C5CFF', '#F97316', '#10B981', '#3B82F6', '#EC4899', '#EAB308', '#06B6D4', '#EF4444']
const colorFor = (id: number) => palette[id % palette.length]

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

/** The owner's list of who can use this Kosh, and the invite links. */
export function Members() {
  const d = useData()
  // Keyed under 'auth' so the member list is never saved to the device.
  const list = useQuery({
    queryKey: ['auth', 'members'],
    queryFn: () => api<{ members: Member[]; invites: Invite[] }>('GET', '/api/members'),
    enabled: d.user.isOwner,
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['auth', 'members'] })

  const [link, setLink] = useState('')
  const [removing, setRemoving] = useState<Member | null>(null)

  const create = useMutation({
    mutationFn: () => api<{ token: string }>('POST', '/api/invites'),
    onSuccess: ({ token }) => {
      setLink(`${location.origin}/join/${token}`)
      refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/invites/${id}`),
    onSuccess: () => {
      toast.success('Invite cancelled')
      refresh()
    },
  })
  const remove = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/members/${id}`),
    onSuccess: () => {
      toast.success(`${removing?.name} was removed`)
      setRemoving(null)
      refresh()
    },
  })

  if (!d.user.isOwner) {
    return (
      <div>
        <ScreenHeader title="Members" back="/settings" />
        <p className="text-[15px] text-ink-2">Only the owner of this Kosh can invite people.</p>
      </div>
    )
  }

  return (
    <div>
      <ScreenHeader title="Members" subtitle="Each person has their own private money. You can't see theirs." back="/settings" />

      <Button size="lg" className="w-full" loading={create.isPending} icon={<UserPlus className="size-5" />} onClick={() => create.mutate()}>
        Invite someone
      </Button>

      <SectionTitle title="People" />
      <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
        {list.isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : (
          list.data?.members.map((m, i) => (
            <div key={m.id} className={cn(i > 0 && 'border-t border-line')}>
              <ListRow
                onClick={m.isOwner ? undefined : () => setRemoving(m)}
                left={<Avatar name={m.name} color={colorFor(m.id)} />}
                title={m.id === d.user.id ? `${m.name} (you)` : m.name}
                subtitle={[`@${m.username}`, m.googleEmail].filter(Boolean).join(' · ')}
                right={m.isOwner ? <span className="rounded-full bg-accent/12 px-2.5 py-1 text-[12px] font-semibold text-accent">Owner</span> : undefined}
                chevron={!m.isOwner}
              />
            </div>
          ))
        )}
      </div>

      {!!list.data?.invites.length && (
        <>
          <SectionTitle title="Open invites" />
          <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
            {list.data.invites.map((inv, i) => (
              <div key={inv.id} className={cn(i > 0 && 'border-t border-line')}>
                <ListRow
                  left={
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
                      <Link2 className="size-[18px]" />
                    </span>
                  }
                  title="Invite link"
                  subtitle={`Made ${day(inv.createdAt)} · works until ${day(inv.expiresAt)}`}
                  right={
                    <Button size="sm" variant="secondary" loading={cancel.isPending && cancel.variables === inv.id} onClick={() => cancel.mutate(inv.id)}>
                      Cancel
                    </Button>
                  }
                />
              </div>
            ))}
          </div>
        </>
      )}

      <Sheet open={!!link} onOpenChange={(o) => !o && setLink('')} title="Invite link" description="Send it to one person. It works once, for 7 days. They sign up with Google or a username.">
        <InviteLink link={link} />
      </Sheet>

      <Sheet
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="Their accounts, transactions, people and budgets are deleted for good, and they're signed out. This can't be undone."
      >
        <div className="space-y-2.5">
          <Button size="lg" variant="danger" className="w-full" loading={remove.isPending} onClick={() => removing && remove.mutate(removing.id)}>
            Remove {removing?.name} and their data
          </Button>
          <Button size="lg" variant="secondary" className="w-full" onClick={() => setRemoving(null)}>
            Keep
          </Button>
        </div>
      </Sheet>
    </div>
  )
}

function InviteLink({ link }: { link: string }) {
  const canShare = typeof navigator.share === 'function'
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      toast.success('Link copied')
    } catch {
      toast.error("Couldn't copy. Select the link and copy it.")
    }
  }
  return (
    <div className="space-y-3">
      <p className="select-all break-all rounded-2xl bg-surface-2 px-4 py-3 font-mono text-[13px] text-ink-2">{link}</p>
      {canShare && (
        <Button size="lg" className="w-full" icon={<Share className="size-5" />} onClick={() => navigator.share({ title: 'Join me on Kosh', text: 'Here is your invite to Kosh:', url: link }).catch(() => {})}>
          Share
        </Button>
      )}
      <Button size="lg" variant={canShare ? 'secondary' : 'primary'} className="w-full" icon={<Copy className="size-5" />} onClick={copy}>
        Copy link
      </Button>
    </div>
  )
}
