import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { Sheet } from '../components/Sheet'
import { Avatar, Button, ListRow, ScreenHeader, SectionTitle, Skeleton, cn } from '../components/ui'
import { api, type Member } from '../lib/api'
import { queryClient, useData } from '../lib/queries'

const palette = ['#7C5CFF', '#F97316', '#10B981', '#3B82F6', '#EC4899', '#EAB308', '#06B6D4', '#EF4444']
const colorFor = (id: number) => palette[id % palette.length]

const joined = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** The owner's list of everyone who has signed up, to remove junk accounts. */
export function Members() {
  const d = useData()
  // Keyed under 'auth' so the member list is never saved to the device.
  const list = useQuery({
    queryKey: ['auth', 'members'],
    queryFn: () => api<{ members: Member[] }>('GET', '/api/members'),
    enabled: d.user.isOwner,
  })
  const [removing, setRemoving] = useState<Member | null>(null)

  const remove = useMutation({
    mutationFn: (id: number) => api('DELETE', `/api/members/${id}`),
    onSuccess: () => {
      toast.success(`${removing?.name} was removed`)
      setRemoving(null)
      queryClient.invalidateQueries({ queryKey: ['auth', 'members'] })
    },
  })

  if (!d.user.isOwner) {
    return (
      <div>
        <ScreenHeader title="Members" back="/settings" />
        <p className="text-[15px] text-ink-2">Only the owner of this Kosh can see who has signed up.</p>
      </div>
    )
  }

  const count = list.data?.members.length

  return (
    <div>
      <ScreenHeader title="Members" subtitle="Anyone with the link can sign up. Each person's money is private: you can't see theirs." back="/settings" />

      <SectionTitle title={count ? `${count} ${count === 1 ? 'person' : 'people'}` : 'People'} className="mt-2" />
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
                subtitle={[`@${m.username}`, m.googleEmail, `joined ${joined(m.createdAt)}`].filter(Boolean).join(' · ')}
                right={m.isOwner ? <span className="rounded-full bg-accent/12 px-2.5 py-1 text-[12px] font-semibold text-accent">Owner</span> : undefined}
                chevron={!m.isOwner}
              />
            </div>
          ))
        )}
      </div>

      <Sheet
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="Their accounts, transactions, people and budgets are deleted for good, and they're signed out. They could sign up again."
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
