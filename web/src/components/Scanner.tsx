import { AnimatePresence, motion } from 'motion/react'
import { AtSign, Camera, Flashlight, FlashlightOff, ImageUp, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BarcodeDetector as ZXingDetector, prepareZXingModule } from 'barcode-detector/ponyfill'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { haptic } from '../lib/look'
import { startPayment } from '../lib/pay'
import { closeScanner } from '../lib/store'
import { parseUpi, platform, type UpiTarget } from '../lib/upi'

type Detector = { detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]> }

let zxingReady = false
function prepareZXing() {
  if (zxingReady) return
  zxingReady = true
  // Serve the decoder from Kosh itself, so scanning works offline.
  prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
    fireImmediately: true,
  }).catch(() => {
    zxingReady = false
  })
}

/** Android Chrome has a built-in QR reader; iPhones use the bundled one. */
async function makeDetector(): Promise<Detector> {
  const Native = (window as unknown as { BarcodeDetector?: { new (o: object): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector
  if (Native) {
    try {
      if ((await Native.getSupportedFormats()).includes('qr_code')) return new Native({ formats: ['qr_code'] })
    } catch {}
  }
  prepareZXing()
  return new ZXingDetector({ formats: ['qr_code'] })
}

/** Loads the decoder ahead of time so the first scan is instant. */
export function warmUp() {
  if (!('BarcodeDetector' in window)) prepareZXing()
}

type State = 'starting' | 'scanning' | 'denied' | 'unavailable'

export default function Scanner() {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const detector = useRef<Promise<Detector> | null>(null)
  const done = useRef(false)
  const [state, setState] = useState<State>('starting')
  const [torch, setTorch] = useState<boolean | null>(null) // null: this camera has no torch
  const [notUpi, setNotUpi] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [vpa, setVpa] = useState('')

  if (!detector.current) detector.current = makeDetector()

  const stopCamera = () => {
    stream.current?.getTracks().forEach((t) => t.stop())
    stream.current = null
  }

  const finish = (target: UpiTarget) => {
    if (done.current) return
    done.current = true
    haptic(25)
    stopCamera()
    closeScanner()
    void startPayment(target)
  }

  const handle = (codes: { rawValue: string }[]) => {
    for (const c of codes) {
      const target = parseUpi(c.rawValue)
      if (target) return finish(target)
    }
    if (codes.length) setNotUpi(codes[0].rawValue)
  }

  // Camera and the scan loop
  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setState('unavailable')
        return
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        })
        if (stopped) {
          s.getTracks().forEach((t) => t.stop())
          return
        }
        stream.current = s
        const track = s.getVideoTracks()[0]
        const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean; focusMode?: string[] }
        if (caps.torch) setTorch(false)
        if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => {})
        const v = video.current!
        v.srcObject = s
        await v.play().catch(() => {})
        setState('scanning')
        const d = await detector.current!
        const tick = async () => {
          if (stopped || done.current) return
          if (v.readyState >= 2 && v.videoWidth > 0) {
            try {
              handle(await d.detect(v))
            } catch {}
          }
          timer = window.setTimeout(tick, 120)
        }
        tick()
      } catch (e) {
        const name = (e as DOMException)?.name
        setState(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable')
      }
    }
    start()
    // Don't keep the camera on in the background.
    const onHide = () => document.visibilityState === 'hidden' && closeScanner()
    document.addEventListener('visibilitychange', onHide)
    return () => {
      stopped = true
      clearTimeout(timer)
      stopCamera()
      document.removeEventListener('visibilitychange', onHide)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notUpi) return
    const t = setTimeout(() => setNotUpi(null), 2500)
    return () => clearTimeout(t)
  }, [notUpi])

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0]
    if (!track || torch === null) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] })
      setTorch(!torch)
      haptic(8)
    } catch {}
  }

  const fromPhoto = async (file: File | undefined) => {
    if (!file) return
    try {
      const bitmap = await createImageBitmap(file)
      const codes = await (await detector.current!).detect(bitmap)
      bitmap.close?.()
      if (!codes.length) return toast.error('No QR code found in that photo')
      handle(codes)
      if (!done.current) toast.error("That QR isn't a UPI payment")
    } catch {
      toast.error("Couldn't read that photo")
    }
  }

  const fromVpa = () => {
    const id = vpa.trim()
    const target = parseUpi(`upi://pay?pa=${encodeURIComponent(id).replace(/%40/g, '@')}&cu=INR`)
    if (!target) return toast.error('Enter a UPI ID like name@okaxis')
    finish(target)
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] overflow-hidden bg-black text-white"
      role="dialog"
      aria-label="Scan a UPI QR code"
    >
      <video ref={video} playsInline muted autoPlay className="absolute inset-0 size-full object-cover" />

      {/* Viewfinder: everything outside the square is dimmed */}
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        <motion.div
          initial={{ scale: 1.08, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="relative aspect-square w-[min(72vw,300px)] rounded-[32px] shadow-[0_0_0_200vmax_rgb(0_0_0/0.55)]"
        >
          {['left-0 top-0 border-l-4 border-t-4 rounded-tl-[32px]', 'right-0 top-0 border-r-4 border-t-4 rounded-tr-[32px]', 'left-0 bottom-0 border-l-4 border-b-4 rounded-bl-[32px]', 'right-0 bottom-0 border-r-4 border-b-4 rounded-br-[32px]'].map((c) => (
            <span key={c} className={`absolute size-12 border-white ${c}`} />
          ))}
          {state === 'scanning' && (
            <motion.span
              className="absolute inset-x-6 h-0.5 rounded-full bg-white/80 shadow-[0_0_16px_4px_rgb(255_255_255/0.45)]"
              animate={{ top: ['12%', '88%', '12%'] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
            />
          )}
        </motion.div>
      </div>

      {/* Top bar */}
      <div className="absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),16px)]">
        <button onClick={closeScanner} aria-label="Close scanner" className="press grid size-11 place-items-center rounded-full bg-black/40 backdrop-blur-md">
          <X className="size-5" />
        </button>
        <p className="text-[15px] font-semibold drop-shadow">Scan any UPI QR</p>
        {torch !== null ? (
          <button onClick={toggleTorch} aria-label={torch ? 'Turn off torch' : 'Turn on torch'} className={`press grid size-11 place-items-center rounded-full backdrop-blur-md ${torch ? 'bg-white text-black' : 'bg-black/40'}`}>
            {torch ? <FlashlightOff className="size-5" /> : <Flashlight className="size-5" />}
          </button>
        ) : (
          <span className="size-11" />
        )}
      </div>

      {/* Messages over the viewfinder */}
      <div className="absolute inset-x-0 top-[calc(50%+min(36vw,150px)+20px)] px-8 text-center">
        <AnimatePresence mode="wait">
          {notUpi ? (
            <motion.p key="not" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mx-auto max-w-[320px] rounded-2xl bg-black/60 px-4 py-2.5 text-[14px] backdrop-blur">
              That QR isn't a UPI payment
              <span className="mt-0.5 block truncate text-[12px] text-white/60">{notUpi}</span>
            </motion.p>
          ) : state === 'scanning' ? (
            <motion.p key="hint" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-[14px] text-white/80 drop-shadow">
              Point at a shop's or a friend's QR
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>

      {(state === 'denied' || state === 'unavailable') && (
        <div className="absolute inset-0 grid place-items-center bg-black/85 px-8 text-center">
          <div>
            <Camera className="mx-auto size-10 text-white/70" />
            <p className="mt-3 text-[17px] font-semibold">{state === 'denied' ? 'Kosh needs your camera' : "Can't open the camera"}</p>
            <p className="mt-1 text-[14px] text-white/70">
              {state === 'denied'
                ? platform === 'ios'
                  ? 'Allow camera access for this site in Settings → Apps → Safari → Camera, then try again. You can also pick a photo of the QR.'
                  : 'Allow camera access in your browser’s site settings, then try again. You can also pick a photo of the QR.'
                : 'Pick a photo of the QR instead, or type the UPI ID.'}
            </p>
          </div>
        </div>
      )}

      {/* Bottom actions */}
      <div className="absolute inset-x-0 bottom-0 px-4 pb-[max(env(safe-area-inset-bottom),20px)]">
        <AnimatePresence initial={false}>
          {typing && (
            <motion.form
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              onSubmit={(e) => {
                e.preventDefault()
                fromVpa()
              }}
              className="mx-auto mb-3 flex max-w-[420px] gap-2"
            >
              <input
                autoFocus
                value={vpa}
                onChange={(e) => setVpa(e.target.value)}
                placeholder="name@okaxis"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                inputMode="email"
                className="h-12 min-w-0 flex-1 rounded-2xl bg-white/15 px-4 text-[16px] outline-none backdrop-blur-md placeholder:text-white/50"
              />
              <button className="press h-12 rounded-2xl bg-white px-5 text-[15px] font-semibold text-black">Next</button>
            </motion.form>
          )}
        </AnimatePresence>
        <div className="mx-auto grid max-w-[420px] grid-cols-2 gap-2">
          <label className="press flex h-12 cursor-pointer items-center justify-center gap-2 rounded-2xl bg-white/15 text-[14px] font-semibold backdrop-blur-md">
            <ImageUp className="size-[18px]" /> Pick a photo
            <input type="file" accept="image/*" className="hidden" onChange={(e) => fromPhoto(e.target.files?.[0])} />
          </label>
          <button onClick={() => setTyping((t) => !t)} className="press flex h-12 items-center justify-center gap-2 rounded-2xl bg-white/15 text-[14px] font-semibold backdrop-blur-md">
            <AtSign className="size-[18px]" /> Type UPI ID
          </button>
        </div>
      </div>
    </motion.div>
  )
}
