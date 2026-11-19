// Reads what matters from the text of a vehicle paper: its type, the date it
// expires, when it was issued, its number, who issued it and the vehicle's
// registration number. The text comes from a PDF or from OCR of a photo
// (docread.ts), so it's often messy; every guess is shown for checking.

export type DocType = 'rc' | 'insurance' | 'puc' | 'road_tax' | 'fitness' | 'permit' | 'licence' | 'warranty' | 'other'

export type DocGuess = {
  type?: DocType
  expiresOn?: string // YYYY-MM-DD
  issuedOn?: string
  number?: string
  issuer?: string
  regNumber?: string
  amount?: number // minor units
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
}

const pad = (n: number) => String(n).padStart(2, '0')

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000
  if (y < 1950 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null
  const dt = new Date(y, m - 1, d)
  if (dt.getMonth() !== m - 1) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

type Found = { date: string; index: number; end: number }

/** Every date in the text, in Indian day-first order unless it's clearly year-first. */
export function findDates(text: string): Found[] {
  const out: Found[] = []
  const add = (date: string | null, m: RegExpExecArray) => {
    if (date && !out.some((f) => f.index === m.index)) out.push({ date, index: m.index, end: m.index + m[0].length })
  }
  let m: RegExpExecArray | null
  // 2026-11-19
  const ymdRe = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/g
  while ((m = ymdRe.exec(text))) add(iso(+m[1], +m[2], +m[3]), m)
  // 19/11/2026, 19-11-26, 19.11.2026
  const dmyRe = /\b(\d{1,2})\s?[-/.]\s?(\d{1,2})\s?[-/.]\s?(\d{4}|\d{2})(?!\d)/g
  while ((m = dmyRe.exec(text))) add(iso(+m[3], +m[2], +m[1]), m)
  // 19 Nov 2026, 19-NOV-2026, 19th November, 2026
  const dMonRe = /\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]*([A-Za-z]{3,9})[\s\-/.,]*(\d{4}|\d{2})(?!\d)/g
  while ((m = dMonRe.exec(text))) {
    const mon = MONTHS[m[2].slice(0, m[2].toLowerCase().startsWith('sept') ? 4 : 3).toLowerCase()]
    if (mon) add(iso(+m[3], mon, +m[1]), m)
  }
  // Nov 19, 2026
  const monDRe = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/g
  while ((m = monDRe.exec(text))) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]
    if (mon) add(iso(+m[3], mon, +m[2]), m)
  }
  return out.sort((a, b) => a.index - b.index)
}

// Words just before a date that say what it is.
const EXPIRY = /(valid\w*\s*(up\s*to|upto|till|until|to|thru|through)|validity|expir\w*|exp\.?\s*date|end\s*date|ends?\s*on|policy\s*end|cover\s*end|to\s*date|due\s*date|next\s*due|renewal\s*date|tax\s*(paid\s*)?(up\s*to|upto|till)|midnight\s*(of|on)?|period\s*to|valid\s*for)/i
const WEAK_EXPIRY = /(\bto\b|\btill\b|\buntil\b|\bupto\b|[-–]\s*$)/i
const ISSUE = /(issue\w*|from|start\w*|commenc\w*|effective|date\s*of\s*(issue|registration|test|reg)|regn?\.?\s*date|registration\s*date|test\s*date|inspection|receipt\s*date|payment\s*date|issued\s*on|dated?)/i
const NOT_IT = /(birth|d\.?o\.?b|manufactur|mfg|first\s*issue|original)/i

export function pickDates(text: string, today = new Date()): { expiresOn?: string; issuedOn?: string } {
  const dates = findDates(text)
  if (!dates.length) return {}
  const now = iso(today.getFullYear(), today.getMonth() + 1, today.getDate())!
  const scored = dates.map((f, i) => {
    // Only the words since the previous date describe this one.
    const from = i > 0 ? dates[i - 1].end : 0
    const near = text.slice(Math.max(from, f.index - 45), f.index)
    const close = text.slice(Math.max(from, f.index - 14), f.index)
    let exp = 0
    let iss = 0
    if (EXPIRY.test(near)) exp += 3
    if (WEAK_EXPIRY.test(close)) exp += 2
    if (ISSUE.test(near)) iss += 3
    if (NOT_IT.test(text.slice(Math.max(from, f.index - 30), f.index))) {
      exp -= 6
      iss -= 6
    }
    if (f.date > now) exp += 1
    else iss += 1
    return { ...f, exp, iss }
  })
  const valid = scored.filter((s) => s.exp > -3)
  const latest = valid.reduce<string | undefined>((m, s) => (!m || s.date > m ? s.date : m), undefined)
  const best = valid
    .map((s) => ({ ...s, exp: s.exp + (s.date === latest ? 1 : 0) }))
    .sort((a, b) => b.exp - a.exp || b.date.localeCompare(a.date))[0]
  // A past date with nothing saying it's an expiry is likelier the issue date.
  const expiresOn = best && (best.exp >= 2 || best.date > now) ? best.date : undefined
  const issue = scored
    .filter((s) => s.date !== expiresOn && (!expiresOn || s.date < expiresOn) && s.iss > 0)
    .sort((a, b) => b.iss - a.iss || b.date.localeCompare(a.date))[0]
  return { expiresOn, issuedOn: issue?.date }
}

const TYPES: [DocType, RegExp][] = [
  ['puc', /pollution\s*under\s*control|\bPUCC?\b|emission\s*test|\bP\.U\.C/i],
  ['licence', /driving\s*licen[cs]e|\bD\.?L\.?\s*No|licen[cs]e\s*no|transport\s*\(?NT\)?|non[-\s]*transport/i],
  ['rc', /registration\s*certificate|certificate\s*of\s*registration|form\s*23|\bR\.?C\.?\s*(book|card|details)/i],
  ['insurance', /[iIl1|]nsurance|po[li1I]i?cy\s*(no|number|schedule|period)|[iIl1|]nsured|premium|third\s*party|own\s*damage|\bIDV\b/i],
  ['road_tax', /road\s*tax|motor\s*vehicles?\s*tax|tax\s*(receipt|token|paid|valid)|life\s*time\s*tax|\bMV\s*tax/i],
  ['fitness', /fitness\s*certificate|certificate\s*of\s*fitness/i],
  ['permit', /\bpermit\b/i],
  ['warranty', /warranty|guarantee/i],
]

export function guessType(text: string): DocType | undefined {
  // These name themselves; their text may still mention insurance or tax.
  for (const t of ['puc', 'licence', 'fitness', 'rc'] as DocType[]) {
    if (TYPES.find(([x]) => x === t)![1].test(text)) return t
  }
  let best: DocType | undefined
  let bestCount = 0
  for (const [type, re] of TYPES) {
    const count = (text.match(new RegExp(re.source, 'gi')) ?? []).length
    if (count > bestCount) {
      best = type
      bestCount = count
    }
  }
  return best
}

export const INSURERS = [
  'ICICI Lombard', 'HDFC ERGO', 'Bajaj Allianz', 'Bajaj General', 'Tata AIG', 'New India Assurance', 'United India', 'Oriental Insurance',
  'National Insurance', 'Reliance General', 'SBI General', 'Go Digit', 'Digit', 'Acko', 'IFFCO Tokio', 'Royal Sundaram', 'Kotak General',
  'Kotak Mahindra General', 'Cholamandalam', 'Chola MS', 'Future Generali', 'Generali Central', 'Liberty General', 'Magma', 'Shriram General',
  'Universal Sompo', 'Zuno', 'Edelweiss', 'Navi General', 'Raheja QBE',
]

function guessIssuer(text: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ')
  for (const name of INSURERS) {
    const re = new RegExp(name.replace(/\s+/g, '\\s*'), 'i')
    if (re.test(flat)) return name === 'Digit' ? 'Go Digit' : name
  }
}

const REG_RE = /\b([A-Z]{2})[\s-]?(\d{1,2})[\s-]?([A-Z]{1,3})[\s-]?(\d{4})\b|\b(\d{2})[\s-]?BH[\s-]?(\d{4})[\s-]?([A-Z]{1,2})\b/

export function guessReg(text: string): string | undefined {
  const m = text.toUpperCase().match(REG_RE)
  if (!m) return
  return (m[1] ? m[1] + m[2].padStart(2, '0') + m[3] + m[4] : m[5] + 'BH' + m[6] + m[7]).replace(/\s/g, '')
}

function guessNumber(text: string, type?: DocType): string | undefined {
  const pats: RegExp[] = []
  if (type === 'licence') pats.push(/\b([A-Z]{2}[\s-]?\d{2}[\s-]?(?:19|20)\d{2}[\s-]?\d{7})\b/, /\b([A-Z]{2}\d{13})\b/)
  pats.push(
    /po[li1I]i?cy\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-]{5,30})/i,
    /certificate\s*(?:sl\.?\s*|serial\s*)?(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-]{4,30})/i,
    /(?:receipt|reference|ref|challan|token)\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-]{4,30})/i,
    /licen[cs]e\s*(?:no|number)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9 /\-]{8,20})/i,
  )
  for (const re of pats) {
    const m = text.match(re)
    // A real number has digits in it.
    if (m && /\d{3}/.test(m[1])) return m[1].replace(/\s+/g, '').replace(/[-/]$/, '')
  }
}

function guessAmount(text: string): number | undefined {
  const re = /(total\s*premium|gross\s*premium|net\s*premium|premium\s*(?:payable|paid|amount)|total\s*(?:amount|payable|paid)|amount\s*(?:paid|payable|received)|tax\s*amount|fees?(?:\s*paid)?)\s*(?:\(.*?\))?\s*[:\-]?\s*(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d{1,2})?)/gi
  let best: number | undefined
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const n = Number(m[2].replace(/,/g, ''))
    if (Number.isFinite(n) && n > 0 && n < 10_000_000) {
      // "Total" beats a line item; keep the largest total.
      if (best === undefined || /total|gross/i.test(m[1]) || n > best) best = Math.round(n * 100)
    }
  }
  return best
}

/** OCR reads O for 0 and l for 1 inside numbers; put them back before parsing. */
export function tidyOcr(text: string): string {
  return text
    .replace(/(?<=\d)[Oo](?=\d)|(?<=\d[-/.])[Oo]|[Oo](?=\d[-/.])/g, '0')
    .replace(/(?<=\d)[lI|](?=\d)/g, '1')
    .replace(/[ \t]+/g, ' ')
}

export function parseDocText(raw: string, today = new Date()): DocGuess {
  const text = tidyOcr(raw)
  const type = guessType(text)
  const { expiresOn, issuedOn } = pickDates(text, today)
  return {
    type,
    expiresOn,
    issuedOn,
    number: guessNumber(text, type),
    issuer: type === 'insurance' ? guessIssuer(text) : undefined,
    regNumber: type === 'licence' ? undefined : guessReg(text),
    amount: guessAmount(text),
  }
}
