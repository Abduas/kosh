import { Drawer } from 'vaul'
import { X } from 'lucide-react'
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { platform } from '../lib/device'
import { useBackToClose } from '../lib/router'
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
  useBackToClose(open && dismissible, () => onOpenChange(false))
  const keyboardFit = useKeyboardFit(open && platform === 'ios')
  return (
    // On iPhone the keyboard covers the page instead of resizing it, so
    // useKeyboardFit keeps the sheet inside what's still visible; Android
    // resizes the page by itself. vaul's own repositionInputs isn't used: it
    // ignores the page scroll iOS adds on focus and pushes the sheet under the
    // status bar.
    <Drawer.Root open={open} onOpenChange={onOpenChange} repositionInputs={false} dismissible={dismissible}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/45 backdrop-blur-[3px]" />
        <Drawer.Content
          style={keyboardFit}
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[94dvh] w-full max-w-[560px] flex-col rounded-t-[30px] bg-bg shadow-float dark:border-t dark:border-white/10 outline-none md:bottom-4 md:rounded-[30px] md:after:hidden!',
            className,
          )}
        >
          <div className="mx-auto mt-2.5 h-[5px] w-10 shrink-0 rounded-full bg-ink/15" />
          <div className="flex items-start gap-3 px-6 pb-1 pt-4">
            <Drawer.Title className="min-w-0 flex-1 text-[20px] font-bold tracking-tight">{title}</Drawer.Title>
            {dismissible && (
              <button onClick={() => onOpenChange(false)} aria-label="Close" className="press -mr-2 -mt-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-ink-2">
                <X className="size-[18px]" />
              </button>
            )}
          </div>
          <Drawer.Description className={description ? 'px-6 text-[14px] text-ink-2' : 'sr-only'}>{description ?? title}</Drawer.Description>
          <div data-sheet-body className={cn('min-h-0 overflow-y-auto overscroll-contain px-6 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4', bodyClassName)}>{children}</div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

/**
 * While the iPhone keyboard is up, keeps the sheet inside the part of the
 * screen that's still visible: its bottom sits on the keyboard, it's never
 * taller than the space above it (its body scrolls instead), and the focused
 * field is scrolled into view within the sheet.
 */
function useKeyboardFit(active: boolean): CSSProperties | undefined {
  const [fit, setFit] = useState<CSSProperties>()
  useEffect(() => {
    const vv = window.visualViewport
    if (!active || !vv) return
    let frame = 0
    const update = () => {
      const layoutHeight = document.documentElement.clientHeight
      // Smaller differences are the toolbar resizing, not a keyboard.
      if (layoutHeight - vv.height < 120) {
        setFit(undefined)
        return
      }
      // iOS also scrolls the page on focus, so the visible band runs from
      // offsetTop to offsetTop + height in the page's fixed coordinates.
      setFit({
        bottom: Math.max(layoutHeight - (vv.offsetTop + vv.height), 0),
        maxHeight: `calc(${vv.height}px - env(safe-area-inset-top) - 8px)`,
      })
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(revealFocused)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      cancelAnimationFrame(frame)
      setFit(undefined)
    }
  }, [active])
  return fit
}

function revealFocused() {
  const field = document.activeElement
  if (!(field instanceof HTMLElement)) return
  const body = field.closest<HTMLElement>('[data-sheet-body]')
  if (!body) return
  const f = field.getBoundingClientRect()
  const b = body.getBoundingClientRect()
  const margin = 20
  if (f.bottom > b.bottom - margin) body.scrollTop += f.bottom - b.bottom + margin
  else if (f.top < b.top + margin) body.scrollTop -= b.top + margin - f.top
}
