// Makes the installed app behave like a native one on phones.
//
// The viewport tag and CSS (touch-action) already turn off zooming, but
// Safari on iPhone ignores "user-scalable=no", so pinch gestures are also
// stopped here. Long-press menus are kept for text fields only.

const editable = (t: EventTarget | null) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable]')

export function nativeFeel() {
  // iOS pinch-to-zoom
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false })
  }
  // Two-finger zoom on browsers without gesture events
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault()
    },
    { passive: false },
  )
  // Long-press menu ("Open link", "Copy") on touch screens, outside text fields
  if (matchMedia('(pointer: coarse)').matches) {
    document.addEventListener('contextmenu', (e) => {
      if (!editable(e.target)) e.preventDefault()
    })
  }
}
