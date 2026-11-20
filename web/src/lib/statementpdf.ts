// Reading a bank statement on the phone: a PDF's words go through
// statementtable.ts to become CSV; Excel and CSV files go through the import
// reader. Either way the server gets CSV text and never the file.

import { PasswordNeeded } from './docread'
import { readImportFile } from './importfile'
import { readStatementWords, type PdfWord } from './statementtable'

export const STATEMENT_ACCEPT = '.pdf,.csv,.tsv,.txt,.xls,.xlsx,.xlsm,.ods,application/pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const isPdf = (f: File) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')

export async function readStatementFile(file: File, opts: { password?: string; status?: (s: string) => void } = {}): Promise<string> {
  if (!isPdf(file)) return readImportFile(file)
  const { status, password } = opts
  status?.('Opening the PDF…')
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), password })
  const words: PdfWord[] = []
  try {
    let doc
    try {
      doc = await task.promise
    } catch (e) {
      // Banks lock statements with something like your date of birth.
      if (e && typeof e === 'object' && 'name' in e && e.name === 'PasswordException') throw new PasswordNeeded(!!password)
      throw e
    }
    for (let n = 1; n <= doc.numPages; n++) {
      if (n % 10 === 1) status?.(`Reading page ${n} of ${doc.numPages}…`)
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      for (const item of content.items) {
        if ('str' in item && item.str.trim()) words.push({ page: n, str: item.str, x: item.transform[4], y: item.transform[5], w: item.width })
      }
      page.cleanup()
    }
  } finally {
    // Frees the worker's copy of the file: statements run to hundreds of pages.
    task.destroy()
  }
  if (words.length < 20) throw new Error('This PDF is a scan, with no text to read. Download the statement from net banking as a PDF or Excel file instead.')
  return readStatementWords(words).csv
}
