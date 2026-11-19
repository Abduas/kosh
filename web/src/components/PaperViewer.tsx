import { AnimatePresence, motion } from 'motion/react'
import { KeyRound, LoaderCircle, Share, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { VehicleDoc } from '../lib/api'
import { paperFile } from '../lib/offline'
import { useGarage } from '../lib/queries'
import { useBackToClose } from '../lib/router'
import { closePaper, paperViewer } from '../lib/store'
import { docLabel, docStatus, dueText, formatReg, stateTone } from '../lib/vehicles'
import { cn } from './ui'

/** A paper full screen, from the copy on the phone: show it at a checkpoint. */
export function PaperViewerHost() {
  const doc = paperViewer.use((s) => s.doc)
  useBackToClose(!!doc, closePaper)
  return <AnimatePresence>{doc && <PaperViewer key={doc.id} doc={doc} />}</AnimatePresence>
}

function PaperViewer({ doc }: { doc: VehicleDoc }) {
  const vehicle = useGarage().data?.vehicles.find((v) => v.id === doc.vehicleId)
  const [blob, setBlob] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const s = docStatus(doc)

  useEffect(() => {
    let live = true
    paperFile(doc).then(
      (b) => live && setBlob(b),
      (e) => live && setError(e instanceof Error ? e.message : "Couldn't open the file"),
    )
    return () => {
      live = false
    }
  }, [doc])

  const isPdf = doc.fileType === 'application/pdf'

  const share = async () => {
    if (!blob) return
    const file = new File([blob], doc.fileName || 'paper', { type: doc.fileType })
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: docLabel(doc) }).catch(() => {})
    else toast("This browser can't share files")
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
    >
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-[max(env(safe-area-inset-top),12px)]">
        <button onClick={closePaper} aria-label="Close" className="press grid size-10 place-items-center rounded-full bg-white/12">
          <X className="size-5" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate text-[16px] font-semibold">
            {docLabel(doc)}
            {vehicle && ` · ${vehicle.regNumber ? formatReg(vehicle.regNumber) : vehicle.name}`}
          </p>
          <p className={cn('text-[12px] font-medium', s.state === 'ok' || s.state === 'lifetime' ? 'text-white/60' : stateTone[s.state])}>
            {doc.number ? `${doc.number} · ` : ''}
            {dueText(doc)}
          </p>
        </div>
        <button onClick={share} disabled={!blob} aria-label="Share" className="press grid size-10 place-items-center rounded-full bg-white/12 disabled:opacity-40">
          <Share className="size-[18px]" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-[env(safe-area-inset-bottom)]" style={{ touchAction: 'pan-x pan-y pinch-zoom' }}>
        {error ? (
          <p className="px-8 pt-24 text-center text-[15px] text-white/70">{error}</p>
        ) : !blob ? (
          <div className="grid h-full place-items-center">
            <LoaderCircle className="size-7 animate-spin text-white/60" />
          </div>
        ) : isPdf ? (
          <PdfPages blob={blob} />
        ) : (
          <ImageView blob={blob} />
        )}
      </div>
    </motion.div>
  )
}

function ImageView({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState('')
  useEffect(() => {
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url ? <img src={url} alt="" className="mx-auto max-h-full w-full object-contain" /> : null
}

function PdfPages({ blob }: { blob: Blob }) {
  const box = useRef<HTMLDivElement>(null)
  const [password, setPassword] = useState('')
  const [tryPassword, setTryPassword] = useState<string | undefined>()
  const [locked, setLocked] = useState<'no' | 'yes' | 'wrong'>('no')

  useEffect(() => {
    let live = true
    ;(async () => {
      const pdfjs = await import('pdfjs-dist')
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default
      let pdf
      try {
        pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), password: tryPassword }).promise
      } catch (e) {
        if (e && typeof e === 'object' && 'name' in e && e.name === 'PasswordException') setLocked(tryPassword ? 'wrong' : 'yes')
        else toast.error("Couldn't show this PDF")
        return
      }
      setLocked('no')
      const el = box.current
      if (!el || !live) return
      el.replaceChildren()
      const width = Math.min(el.clientWidth || window.innerWidth, 900)
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      for (let n = 1; n <= pdf.numPages && live; n++) {
        const page = await pdf.getPage(n)
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: (width / base.width) * dpr })
        const canvas = document.createElement('canvas')
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.style.width = `${width}px`
        canvas.className = 'mx-auto mb-2 block bg-white'
        el.appendChild(canvas)
        await page.render({ canvas, viewport }).promise
      }
    })()
    return () => {
      live = false
    }
  }, [blob, tryPassword])

  if (locked !== 'no') {
    return (
      <div className="mx-auto max-w-[360px] space-y-3 px-6 pt-20 text-center">
        <KeyRound className="mx-auto size-8 text-white/70" />
        <p className="text-[16px] font-semibold">{locked === 'wrong' ? 'That password is wrong' : 'This PDF has a password'}</p>
        <p className="text-[13px] text-white/60">Often your date of birth (DDMMYYYY) or phone number.</p>
        <div className="flex gap-2">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-2xl bg-white/12 px-4 text-[15px] outline-none"
            placeholder="Password"
            autoFocus
          />
          <button onClick={() => setTryPassword(password)} className="press h-11 rounded-2xl bg-white px-4 font-semibold text-black">
            Open
          </button>
        </div>
      </div>
    )
  }
  return <div ref={box} className="pt-1" />
}
