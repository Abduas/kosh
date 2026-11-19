// Reading a vehicle paper on the phone: text from a PDF, or OCR of a photo
// (or of a scanned PDF), then docparse.ts finds the dates and details.
// Nothing leaves the device for this. pdf.js and Tesseract load only when a
// document is read; Tesseract fetches its engine and English data from a CDN
// the first time (a few MB), then the browser keeps them.

import { parseDocText, type DocGuess } from './docparse'

export class PasswordNeeded extends Error {
  constructor(public wrong: boolean) {
    super(wrong ? 'That password is wrong' : 'This PDF has a password')
  }
}

export type ReadResult = DocGuess & { text: string }

type Status = (s: string) => void

async function ocr(image: ImageBitmap | HTMLCanvasElement | Blob, status?: Status): Promise<string> {
  status?.('Getting ready to read…')
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text') status?.(`Reading… ${Math.round(m.progress * 100)}%`)
    },
  })
  try {
    let input: HTMLCanvasElement | Blob
    if (image instanceof ImageBitmap) {
      const c = document.createElement('canvas')
      c.width = image.width
      c.height = image.height
      c.getContext('2d')!.drawImage(image, 0, 0)
      input = c
    } else input = image
    const { data } = await worker.recognize(input)
    return data.text
  } finally {
    worker.terminate()
  }
}

async function pdfText(file: File, password: string | undefined, status?: Status): Promise<string> {
  status?.('Opening the PDF…')
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  let doc
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password }).promise
  } catch (e) {
    // Insurers often lock policy PDFs with your date of birth or phone number.
    if (e && typeof e === 'object' && 'name' in e && e.name === 'PasswordException') throw new PasswordNeeded(!!password)
    throw e
  }
  let text = ''
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : ' ')
    text += '\n'
  }
  if (text.replace(/\s/g, '').length > 60) return text
  // A scanned PDF has no text: read the first page as a picture.
  const page = await doc.getPage(1)
  const viewport = page.getViewport({ scale: 2.2 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvas, viewport }).promise
  return ocr(canvas, status)
}

/** Loads a photo, shrunk so OCR is quick and uploads are small. */
async function loadImage(file: Blob, maxSide: number): Promise<ImageBitmap> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height))
  if (scale === 1) return bmp
  const out = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * scale), resizeHeight: Math.round(bmp.height * scale), resizeQuality: 'high' })
  bmp.close()
  return out
}

export async function readDocument(file: File, opts: { password?: string; status?: Status } = {}): Promise<ReadResult> {
  let text: string
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    text = await pdfText(file, opts.password, opts.status)
  } else {
    let img: ImageBitmap | Blob
    try {
      img = await loadImage(file, 2400)
    } catch {
      img = file
    }
    text = await ocr(img, opts.status)
  }
  return { ...parseDocText(text), text }
}

/**
 * A phone photo can be 5 MB; the paper reads fine at a tenth of that. PDFs
 * and anything the browser can't draw are sent as they are.
 */
export async function shrinkForUpload(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.size < 700_000) return file
  try {
    const bmp = await loadImage(file, 2000)
    const canvas = document.createElement('canvas')
    canvas.width = bmp.width
    canvas.height = bmp.height
    canvas.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return file
  }
}
