import { Plus } from 'lucide-react'
import { useState } from 'react'
import { CategorySheet } from '../components/Forms'
import { Glyph, IconButton, ListRow, ScreenHeader, SectionTitle, Segmented, cn } from '../components/ui'
import type { Category } from '../lib/api'
import { useData } from '../lib/queries'

export function Categories() {
  const d = useData()
  const [kind, setKind] = useState<'expense' | 'income'>('expense')
  const [editing, setEditing] = useState<Category | undefined>()
  const [open, setOpen] = useState(false)
  const list = d.categories.filter((c) => c.kind === kind)
  const active = list.filter((c) => !c.archived)
  const archived = list.filter((c) => c.archived)

  const edit = (c?: Category) => {
    setEditing(c)
    setOpen(true)
  }

  const rows = (items: Category[]) => (
    <div className="overflow-hidden rounded-[22px] bg-surface shadow-card">
      {items.map((c, i) => (
        <div key={c.id} className={cn(i > 0 && 'border-t border-line')}>
          <ListRow
            onClick={() => edit(c)}
            left={<Glyph icon={c.icon} color={c.color} size={40} />}
            title={c.name}
            subtitle={c.useCount > 0 ? `${c.useCount} in the last 90 days` : 'Not used recently'}
            chevron
          />
        </div>
      ))}
    </div>
  )

  return (
    <div>
      <ScreenHeader
        title="Categories"
        back="/settings"
        actions={
          <IconButton label="Add category" onClick={() => edit()} className="bg-surface shadow-card">
            <Plus className="size-5" />
          </IconButton>
        }
      />
      <Segmented id="cat-tab" value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Expenses' }, { value: 'income', label: 'Income' }]} />
      <div className="mt-4">{rows(active)}</div>
      {archived.length > 0 && (
        <>
          <SectionTitle title="Archived" />
          <div className="opacity-70">{rows(archived)}</div>
        </>
      )}
      <CategorySheet open={open} onOpenChange={setOpen} category={editing} kind={kind} />
    </div>
  )
}
