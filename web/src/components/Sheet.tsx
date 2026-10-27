import { Drawer } from 'vaul'
import type { ReactNode } from 'react'
import { cn } from './ui'

/** A bottom sheet with drag-to-dismiss, used for every form in the app. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  bodyClassName,
  dismissible = true,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  className?: string
  bodyClassName?: string
  dismissible?: boolean
}) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false} dismissible={dismissible}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[3px]" />
        <Drawer.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[94dvh] w-full max-w-[560px] flex-col rounded-t-[30px] bg-surface shadow-float outline-none md:bottom-4 md:rounded-[30px] md:after:hidden!',
            className,
          )}
        >
          <div className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-full bg-ink/15" />
          <Drawer.Title className="px-6 pb-1 pt-4 text-[20px] font-bold tracking-tight">{title}</Drawer.Title>
          <Drawer.Description className={description ? 'px-6 text-[14px] text-ink-2' : 'sr-only'}>{description ?? title}</Drawer.Description>
          <div className={cn('overflow-y-auto overscroll-contain px-6 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4', bodyClassName)}>{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
