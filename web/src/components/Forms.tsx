import { Archive, ArchiveRestore, BookUser, Check, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { Account, AccountKind, Category, Person } from '../lib/api'
import { currencySymbol, parseMoney } from '../lib/format'
import { contactsApi, isTouch, pickContacts, platform } from '../lib/device'
import { palette } from '../lib/look'
import { useDeleteEntity, useSaveEntity } from '../lib/queries'
import { Sheet } from './Sheet'
import { Avatar, Button, Field, Glyph, Segmented, TextInput, Toggle, cn } from './ui'

// ---- Small inputs ----

const EMOJIS = [
  '🍜', '🍔', '🍕', '☕', '🍺', '🛒', '🥦', '🍎', '🚕', '🚌', '🚇', '⛽', '🚗', '🏍️', '✈️', '🏨',
  '🛍️', '👕', '👟', '💄', '💇', '💊', '🏥', '🦷', '🏋️', '🎬', '🎮', '🎵', '📺', '📚', '🎓', '✏️',
  '💡', '🔌', '💧', '🔥', '📱', '💻', '🌐', '🏠', '🛠️', '🧹', '🐶', '👶', '👨‍👩‍👧', '🎁', '💝', '🙏',
  '🏦', '💳', '💵', '💰', '🪙', '📈', '💼', '🏪', '🧾', '↩️', '🎉', '⚽', '🏏', '🎯', '🧳', '🚲',
  '🍿', '🥤', '🍰', '🥘', '🍱', '🧃', '🚬', '🎨', '📦', '🏛️', '🕌', '🛕', '⛪', '🌱', '✨', '❓',
]

export function EmojiPicker({ value, onChange, color }: { value: string; onChange: (v: string) => void; color: string }) {
  return (
    <div>
      <div className="grid grid-cols-8 gap-1.5">
        {EMOJIS.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => onChange(e)}
            className={cn('press grid aspect-square place-items-center rounded-xl text-[20px] transition', value === e ? '' : 'hover:bg-surface-2')}
            style={value === e ? { background: color + '26', boxShadow: `inset 0 0 0 2px ${color}` } : undefined}
          >
            {e}
          </button>
        ))}
      </div>
      <TextInput
        className="mt-2"
        placeholder="Or type any emoji"
        maxLength={8}
        onChange={(e) => {
          const v = e.target.value.trim()
          if (v) onChange(v)
        }}
      />
    </div>
  )
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="grid grid-cols-9 gap-2">
      {palette.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={c}
          onClick={() => onChange(c)}
          className="press grid aspect-square place-items-center rounded-full"
          style={{ background: c, boxShadow: value.toLowerCase() === c.toLowerCase() ? `0 0 0 3px var(--surface), 0 0 0 5px ${c}` : undefined }}
        >
          {value.toLowerCase() === c.toLowerCase() && <Check className="size-4 text-white" strokeWidth={3} />}
        </button>
      ))}
    </div>
  )
}

/** A money field in rupees that reports minor units (paise). */
export function MoneyInput({ value, onChange, placeholder, allowNegative }: { value: number; onChange: (minor: number) => void; placeholder?: string; allowNegative?: boolean }) {
  const [text, setText] = useState(value ? String(value / 100) : '')
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[15px] font-semibold text-ink-3">{currencySymbol()}</span>
      <TextInput
        inputMode="decimal"
        value={text}
        placeholder={placeholder ?? '0'}
        className="pl-9 font-semibold tnum"
        onChange={(e) => {
          const raw = e.target.value.replace(allowNegative ? /[^0-9.,-]/g : /[^0-9.,]/g, '')
          setText(raw)
          onChange(parseMoney(raw) ?? 0)
        }}
      />
    </div>
  )
}

// ---- Accounts ----

const kindDefaults: Record<AccountKind, { label: string; icon: string; color: string }> = {
  bank: { label: 'Bank', icon: '🏦', color: '#3B82F6' },
  cash: { label: 'Cash', icon: '💵', color: '#22C55E' },
  wallet: { label: 'Wallet', icon: '👛', color: '#A855F7' },
  card: { label: 'Credit card', icon: '💳', color: '#F97316' },
  savings: { label: 'Savings', icon: '🐷', color: '#EC4899' },
  investment: { label: 'Invest', icon: '📈', color: '#14B8A6' },
}

export const INDIAN_BANKS: { name: string; color: string }[] = [
  { name: 'SBI', color: '#1E63D6' },
  { name: 'HDFC Bank', color: '#1D4E9E' },
  { name: 'ICICI Bank', color: '#B02A30' },
  { name: 'Axis Bank', color: '#97144D' },
  { name: 'Kotak', color: '#ED1C24' },
  { name: 'PNB', color: '#A6192E' },
  { name: 'Bank of Baroda', color: '#F26522' },
  { name: 'Canara Bank', color: '#0072BC' },
  { name: 'Union Bank', color: '#E31E24' },
  { name: 'IDFC First', color: '#9C1D26' },
  { name: 'Yes Bank', color: '#0060AA' },
  { name: 'IndusInd', color: '#8B1A1A' },
  { name: 'Federal Bank', color: '#F7A600' },
  { name: 'AU Bank', color: '#6D2077' },
]

export const WALLETS: { name: string; color: string }[] = [
  { name: 'Paytm', color: '#00BAF2' },
  { name: 'PhonePe', color: '#5F259F' },
  { name: 'Amazon Pay', color: '#FF9900' },
  { name: 'UPI Lite', color: '#097939' },
]

export function AccountSheet({ open, onOpenChange, account }: { open: boolean; onOpenChange: (o: boolean) => void; account?: Account }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={account ? 'Edit account' : 'New account'}>
      {open && <AccountForm account={account} onDone={() => onOpenChange(false)} />}
    </Sheet>
  )
}

function AccountForm({ account, onDone }: { account?: Account; onDone: () => void }) {
  const save = useSaveEntity<Account>('accounts')
  const del = useDeleteEntity('accounts')
  const [kind, setKind] = useState<AccountKind>(account?.kind ?? 'bank')
  const [name, setName] = useState(account?.name ?? '')
  const [institution, setInstitution] = useState(account?.institution ?? '')
  const [last4, setLast4] = useState(account?.last4 ?? '')
  const [icon, setIcon] = useState(account?.icon ?? kindDefaults.bank.icon)
  const [color, setColor] = useState(account?.color ?? kindDefaults.bank.color)
  const isCard = kind === 'card'
  const [opening, setOpening] = useState(account ? (isCard ? -account.openingBalance : account.openingBalance) : 0)
  const [include, setInclude] = useState(account?.includeInTotal ?? true)

  const quick = kind === 'wallet' ? WALLETS : kind === 'bank' || kind === 'savings' || kind === 'card' ? INDIAN_BANKS : []

  const submit = () => {
    const body = { name, kind, institution, last4, icon, color, openingBalance: isCard ? -opening : opening, includeInTotal: include }
    save.mutate(
      { id: account?.id, body },
      {
        onSuccess: () => {
          toast.success(account ? 'Account updated' : `${name} added`)
          onDone()
        },
      },
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-[22px] bg-surface-2 p-3">
        <Glyph icon={icon} color={color} size={52} />
        <div className="min-w-0">
          <p className="truncate text-[17px] font-semibold">{name || 'Account name'}</p>
          <p className="text-[13px] text-ink-3">
            {kindDefaults[kind].label}
            {last4 && ` ·••• ${last4}`}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(Object.keys(kindDefaults) as AccountKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              setKind(k)
              if (!account) {
                setIcon(kindDefaults[k].icon)
                setColor(kindDefaults[k].color)
                if (k === 'cash' && !name) setName('Cash')
              }
            }}
            className={cn('press flex flex-col items-center gap-1 rounded-2xl py-3 text-[13px] font-semibold', kind === k ? 'bg-ink text-bg' : 'bg-surface-2 text-ink-2')}
          >
            <span className="text-[22px]">{kindDefaults[k].icon}</span>
            {kindDefaults[k].label}
          </button>
        ))}
      </div>

      {quick.length > 0 && (
        <div>
          <p className="mb-2 px-1 text-[13px] font-medium text-ink-2">Quick pick</p>
          <div className="no-scrollbar -mx-6 flex gap-2 overflow-x-auto px-6">
            {quick.map((b) => (
              <button
                key={b.name}
                type="button"
                onClick={() => {
                  setInstitution(b.name)
                  setColor(b.color)
                  if (!name || name === institution || quick.some((q) => q.name === name)) setName(kind === 'card' ? `${b.name} Card` : b.name)
                }}
                className={cn('press flex h-9 shrink-0 items-center gap-2 rounded-full pl-1.5 pr-3.5 text-[13px] font-semibold', institution === b.name ? 'bg-ink text-bg' : 'bg-surface-2 text-ink-2')}
              >
                <span className="size-6 rounded-full" style={{ background: `linear-gradient(145deg, ${b.color}, color-mix(in oklab, ${b.color} 65%, black))` }} />
                {b.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'cash' ? 'Cash' : 'e.g. HDFC Salary'} maxLength={40} />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={isCard ? 'Amount owed now' : account ? 'Opening balance' : 'Current balance'}>
          <MoneyInput value={opening} onChange={setOpening} allowNegative={!isCard} />
        </Field>
        {(kind === 'bank' || kind === 'card' || kind === 'savings') && (
          <Field label="Last 4 digits">
            <TextInput value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="1234" />
          </Field>
        )}
      </div>

      <div className="flex items-center justify-between rounded-2xl bg-surface-2 px-4 py-3">
        <div>
          <p className="text-[15px] font-medium">Count in total balance</p>
          <p className="text-[12px] text-ink-3">Turn off for money you don't think of as yours to spend</p>
        </div>
        <Toggle checked={include} onChange={setInclude} label="Count in total balance" />
      </div>

      <Field label="Icon">
        <EmojiPicker value={icon} onChange={setIcon} color={color} />
      </Field>
      <Field label="Color">
        <ColorPicker value={color} onChange={setColor} />
      </Field>

      <Button size="lg" className="w-full" loading={save.isPending} onClick={submit}>
        {account ? 'Save changes' : 'Add account'}
      </Button>

      {account && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            icon={account.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            onClick={() => save.mutate({ id: account.id, body: { archived: !account.archived } }, { onSuccess: onDone })}
          >
            {account.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button
            variant="danger"
            icon={<Trash2 className="size-4" />}
            disabled={account.txCount > 0}
            title={account.txCount > 0 ? 'Accounts with transactions can only be archived' : undefined}
            onClick={() => del.mutate(account.id, { onSuccess: onDone })}
          >
            Delete
          </Button>
        </div>
      )}
    </div>
  )
}

// ---- Categories ----

export function CategorySheet({ open, onOpenChange, category, kind }: { open: boolean; onOpenChange: (o: boolean) => void; category?: Category; kind?: 'expense' | 'income' }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={category ? 'Edit category' : 'New category'}>
      {open && <CategoryForm category={category} initialKind={kind} onDone={() => onOpenChange(false)} />}
    </Sheet>
  )
}

function CategoryForm({ category, initialKind, onDone }: { category?: Category; initialKind?: 'expense' | 'income'; onDone: () => void }) {
  const save = useSaveEntity<Category>('categories')
  const del = useDeleteEntity('categories')
  const [kind, setKind] = useState<'expense' | 'income'>(category?.kind ?? initialKind ?? 'expense')
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState(category?.icon ?? '✨')
  const [color, setColor] = useState(category?.color ?? palette[0])
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-[22px] bg-surface-2 p-3">
        <Glyph icon={icon} color={color} size={52} />
        <p className="truncate text-[17px] font-semibold">{name || 'Category name'}</p>
      </div>
      {!category && (
        <Segmented id="cat-kind" value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Expense' }, { value: 'income', label: 'Income' }]} />
      )}
      <Field label="Name">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chai & snacks" maxLength={32} />
      </Field>
      <Field label="Icon">
        <EmojiPicker value={icon} onChange={setIcon} color={color} />
      </Field>
      <Field label="Color">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <Button
        size="lg"
        className="w-full"
        loading={save.isPending}
        onClick={() => save.mutate({ id: category?.id, body: { kind, name, icon, color } }, { onSuccess: onDone })}
      >
        {category ? 'Save changes' : 'Add category'}
      </Button>
      {category && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            variant="secondary"
            icon={category.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            onClick={() => save.mutate({ id: category.id, body: { archived: !category.archived } }, { onSuccess: onDone })}
          >
            {category.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button variant="danger" icon={<Trash2 className="size-4" />} onClick={() => del.mutate(category.id, { onSuccess: onDone })}>
            Delete
          </Button>
        </div>
      )}
    </div>
  )
}

// ---- People ----

export function PersonSheet({ open, onOpenChange, person, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; person?: Person; onSaved?: (p: Person) => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={person ? 'Edit person' : 'Add a person'}>
      {open && (
        <PersonForm
          person={person}
          onDone={(p) => {
            onOpenChange(false)
            if (p) onSaved?.(p)
          }}
        />
      )}
    </Sheet>
  )
}

function PersonForm({ person, onDone }: { person?: Person; onDone: (p?: Person) => void }) {
  const save = useSaveEntity<Person>('people')
  const del = useDeleteEntity('people')
  const [name, setName] = useState(person?.name ?? '')
  const [phone, setPhone] = useState(person?.phone ?? '')
  const [note, setNote] = useState(person?.note ?? '')
  const [color, setColor] = useState(person?.color ?? palette[Math.floor(Math.random() * palette.length)])
  const [importing, setImporting] = useState(false)

  const submit = () => save.mutate({ id: person?.id, body: { name, phone, note, color } }, { onSuccess: (p) => onDone(p) })

  // One contact fills the form; several are added straight away.
  const fromContacts = async () => {
    let picked
    try {
      picked = await pickContacts(!person)
    } catch {
      return toast.error("Couldn't open your contacts")
    }
    if (picked.length === 0) return
    if (picked.length === 1 || person) {
      if (picked[0].name) setName(picked[0].name)
      if (picked[0].phone) setPhone(picked[0].phone)
      return
    }
    setImporting(true)
    let added = 0
    let last: Person | undefined
    for (const c of picked) {
      try {
        last = await save.mutateAsync({ body: { name: c.name || c.phone, phone: c.phone, color: palette[(added + 3) % palette.length] } })
        added++
      } catch {
        // The error toast comes from the mutation; carry on with the rest.
      }
    }
    setImporting(false)
    if (added > 0) {
      toast.success(`Added ${added} ${added === 1 ? 'person' : 'people'}`)
      onDone(added === 1 ? last : undefined)
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="flex flex-col items-center gap-2 py-2">
        <Avatar name={name || '?'} color={color} size={72} />
      </div>
      {contactsApi && (
        <Button type="button" variant="secondary" className="w-full" loading={importing} icon={<BookUser className="size-[18px]" />} onClick={fromContacts}>
          {person ? 'Fill from contacts' : platform === 'ios' ? 'Browse contacts' : 'Choose from contacts'}
        </Button>
      )}
      {platform === 'ios' && !person && (
        // Safari's contact list for web apps has no search; iPhone's own
        // AutoFill Contact does, and fills name and phone together.
        <p className="rounded-2xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
          <BookUser className="mr-1.5 inline size-4 align-[-3px] text-accent" />
          <span className="font-semibold text-ink">Search your contacts:</span> tap Name, then <span className="font-semibold text-ink">AutoFill Contact</span> above the keyboard. Or tap Name again and choose <span className="font-semibold text-ink">AutoFill → Contact</span>.
        </p>
      )}
      <Field label="Name">
        <TextInput autoFocus={!person && !isTouch} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rahul" maxLength={50} name="name" autoComplete="name" enterKeyHint="next" />
      </Field>
      <Field label="Phone" hint="Used to send payment reminders on WhatsApp">
        <TextInput type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="+91 98765 43210" maxLength={20} name="tel" autoComplete="tel" />
      </Field>
      <Field label="Note">
        <TextInput value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. College friend" maxLength={200} autoComplete="off" enterKeyHint="done" />
      </Field>
      <Field label="Color">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <Button type="submit" size="lg" className="w-full" loading={save.isPending && !importing}>
        {person ? 'Save changes' : 'Add person'}
      </Button>
      {person && (
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant="secondary"
            icon={person.archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            onClick={() => save.mutate({ id: person.id, body: { archived: !person.archived } }, { onSuccess: () => onDone() })}
          >
            {person.archived ? 'Unarchive' : 'Archive'}
          </Button>
          <Button type="button" variant="danger" icon={<Trash2 className="size-4" />} disabled={person.txCount > 0} onClick={() => del.mutate(person.id, { onSuccess: () => onDone() })}>
            Delete
          </Button>
        </div>
      )}
    </form>
  )
}
