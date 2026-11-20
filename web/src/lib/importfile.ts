// Turns whatever an app exported into CSV text for the server: a CSV in any
// common encoding, an Excel file (Money Manager, bank statements), or a zip
// with a CSV inside (YNAB). SheetJS loads only when a file needs it.

const MAX_CSV = 10 * 1024 * 1024

const startsWith = (b: Uint8Array, ...sig: number[]) => sig.every((x, i) => b[i] === x)

function decodeText(b: Uint8Array): string {
  if (startsWith(b, 0xff, 0xfe)) return new TextDecoder('utf-16le').decode(b)
  if (startsWith(b, 0xfe, 0xff)) return new TextDecoder('utf-16be').decode(b)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    // Older Excel-made CSVs are Windows-1252.
    return new TextDecoder('windows-1252').decode(b)
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

async function spreadsheetToCSV(b: Uint8Array): Promise<string> {
  const XLSX = await import('xlsx')
  const book = XLSX.read(b, { type: 'array', cellNF: true, dense: false })
  // The sheet with the most rows is the transactions.
  let best: import('xlsx').WorkSheet | null = null
  let bestRows = -1
  for (const name of book.SheetNames) {
    const ws = book.Sheets[name]
    const ref = ws['!ref']
    const rows = ref ? XLSX.utils.decode_range(ref).e.r : 0
    if (rows > bestRows) {
      best = ws
      bestRows = rows
    }
  }
  if (!best) throw new Error('This spreadsheet is empty.')
  // Dates as yyyy-mm-dd hh:mm, whatever the sheet's format, so 03/04 can't be
  // read the wrong way round.
  for (const key of Object.keys(best)) {
    if (key.startsWith('!')) continue
    const c = best[key] as import('xlsx').CellObject
    if (c.t === 'n' && typeof c.v === 'number' && c.z && XLSX.SSF.is_date(String(c.z))) {
      const d = XLSX.SSF.parse_date_code(c.v)
      if (d) c.w = `${d.y}-${pad(d.m)}-${pad(d.d)}` + (d.H || d.M ? ` ${pad(d.H)}:${pad(d.M)}` : '')
    }
  }
  return XLSX.utils.sheet_to_csv(best, { blankrows: false })
}

async function zipToCSV(b: Uint8Array): Promise<string | null> {
  const XLSX = await import('xlsx')
  const zip = XLSX.CFB.read(b, { type: 'array' })
  const files: { name: string; content: Uint8Array }[] = []
  zip.FileIndex.forEach((f: { name: string; type: number; content?: ArrayLike<number> }, i: number) => {
    const path: string = zip.FullPaths[i] ?? f.name
    if (f.type === 2 && f.content && /\.(csv|tsv|txt)$/i.test(path) && !/(^|\/)__MACOSX\//.test(path)) files.push({ name: path, content: new Uint8Array(f.content) })
  })
  if (!files.length) return null
  // YNAB's zip has the transactions ("Register") and the month plan ("Plan").
  const pick = files.find((f) => /register|transactions/i.test(f.name)) ?? files.sort((a, b) => b.content.length - a.content.length)[0]
  return decodeText(pick.content)
}

/** Reads an exported file as CSV text, or throws a message to show. */
export async function readImportFile(f: File): Promise<string> {
  if (f.size > 20 * 1024 * 1024) throw new Error('That file is over 20 MB. Export a shorter period and try again.')
  const b = new Uint8Array(await f.arrayBuffer())
  const name = f.name.toLowerCase()
  let csv: string
  if (startsWith(b, 0x50, 0x4b)) {
    // A zip: an Excel or Numbers file, or a zip of CSVs.
    if (/\.(xlsx|xlsm|ods|numbers)$/.test(name)) csv = await spreadsheetToCSV(b)
    else csv = (await zipToCSV(b)) ?? (await spreadsheetToCSV(b))
  } else if (startsWith(b, 0xd0, 0xcf, 0x11, 0xe0) || /\.(xls|xlsx|ods)$/.test(name)) {
    // Old Excel, or an "xls" that's really an HTML or XML table.
    csv = await spreadsheetToCSV(b)
  } else {
    csv = decodeText(b)
  }
  if (!csv.trim()) throw new Error('This file is empty.')
  if (new Blob([csv]).size > MAX_CSV) throw new Error('That file is too long. Export a shorter period and try again.')
  return csv
}
