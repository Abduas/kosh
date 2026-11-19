// Papers on the phone: a copy of each current paper's file is kept in the
// browser's Cache Storage, so they open with no signal (at a checkpoint, in
// a basement parking). The list of papers itself comes from the saved app
// data. Copies are keyed by the file's id, which changes on every upload.

import type { VehicleDoc } from './api'

const CACHE = 'kosh-papers'

const fileUrl = (d: Pick<VehicleDoc, 'id'>) => `/api/vehicle-documents/${d.id}/file`
const copyKey = (d: Pick<VehicleDoc, 'id' | 'fileId'>) => `/offline-papers/${d.id}-${d.fileId}`

const supported = () => typeof caches !== 'undefined'

let syncing: Promise<number> | null = null

/** Saves the files of these papers and forgets any others. Returns how many are saved. */
export function syncPapers(docs: VehicleDoc[]): Promise<number> {
  if (!supported()) return Promise.resolve(0)
  if (syncing) return syncing
  syncing = (async () => {
    const cache = await caches.open(CACHE)
    const want = docs.filter((d) => d.fileId)
    const keep = new Set(want.map((d) => new URL(copyKey(d), location.origin).href))
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req)
    let saved = 0
    for (const d of want) {
      if (await cache.match(copyKey(d))) {
        saved++
        continue
      }
      try {
        const res = await fetch(fileUrl(d), { credentials: 'same-origin' })
        if (res.ok) {
          await cache.put(copyKey(d), res)
          saved++
        }
      } catch {
        // Offline or the file is gone; try again next time.
      }
    }
    // The PDF viewer loads on demand; fetch it now so it's there offline too
    // (the service worker keeps what's fetched from /assets/).
    if (want.some((d) => d.fileType === 'application/pdf')) await warmPdfViewer()
    return saved
  })().finally(() => {
    syncing = null
  })
  return syncing
}

/** The paper's file: the saved copy, or from the server (and then saved). */
export async function paperFile(d: VehicleDoc): Promise<Blob> {
  if (supported()) {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(copyKey(d))
    if (hit) return hit.blob()
    let res: Response
    try {
      res = await fetch(fileUrl(d), { credentials: 'same-origin' })
    } catch {
      throw new Error("This paper isn't saved on this phone yet. Open it once with signal.")
    }
    if (!res.ok) throw new Error("Couldn't open the file")
    await cache.put(copyKey(d), res.clone())
    return res.blob()
  }
  const res = await fetch(fileUrl(d), { credentials: 'same-origin' })
  if (!res.ok) throw new Error("Couldn't open the file")
  return res.blob()
}

export async function savedPaperIds(): Promise<Set<number>> {
  if (!supported()) return new Set()
  const cache = await caches.open(CACHE)
  const ids = (await cache.keys()).map((r) => Number(new URL(r.url).pathname.split('/').pop()!.split('-')[0]))
  return new Set(ids)
}

/** Signing out: the next person mustn't see these. */
export async function forgetPapers() {
  if (supported()) await caches.delete(CACHE)
}

async function warmPdfViewer() {
  try {
    await import('pdfjs-dist')
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    await fetch(worker.default)
  } catch {
    // Offline now; next time.
  }
}
