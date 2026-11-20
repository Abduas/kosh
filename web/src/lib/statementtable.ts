// Rebuilding a bank statement's table from the words on its PDF pages.
//
// A PDF has no table, only words at positions. The header row (Date,
// Particulars, Deposits, Withdrawals, Balance…) says where each column is.
// A transaction is a line with a date and an amount; the description lines
// around it belong to it. Banks lay these out differently: some print the
// date on the first line of a description (SBI, HDFC), others in its middle
// (Canara), so which lines go with which date is worked out per statement.
//
// Whether money came in or went out is read from the running balance where
// there is one: if the balance went up by the amount, it came in. That holds
// whatever the columns are called and however close together they are.
//
// This file has no imports so it can be tested on real statements with Node.

export type PdfWord = { page: number; str: string; x: number; y: number; w: number }

export type StatementRow = {
  date: string // YYYY-MM-DD
  note: string
  credit: number // paise; one of credit and debit is set
  debit: number
  balance: number | null
}

export type StatementTable = {
  rows: StatementRow[]
  opening: number | null
  closing: number | null
  csv: string
}

type Role = 'date' | 'note' | 'credit' | 'debit' | 'amount' | 'balance' | 'other'

// Header words (lowercased, punctuation dropped) and the column they name.
const HEADERS: [RegExp, Role][] = [
  [/^(txn |tran |transaction |post |posting |value )?date$/, 'date'],
  [/^(particulars|description|narration|details|transaction details|remarks|transaction remarks)$/, 'note'],
  [/^(deposits?|credits?|cr|deposit amt|credit amount|credit amt|deposit amount)$/, 'credit'],
  [/^(withdrawals?|debits?|dr|withdrawal amt|debit amount|debit amt|withdrawal amount)$/, 'debit'],
  [/^(amount|amount inr|amount rs|transaction amount)$/, 'amount'],
  [/^(balance|closing balance|running balance|balance inr|balance amt|balance amount)$/, 'balance'],
  [/^(chq|cheque|chq no|cheque no|chq ref no|ref no|reference no|chq ref number|branch|init br|instr id)$/, 'other'],
]

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 }

const DATE_NUM = /^(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})$/
const DATE_MON = /^(\d{1,2})[- ]?([A-Za-z]{3,4})[- ,]*(\d{2,4})$/
const MONEY = /^-?(?:₹|rs\.?|inr)?\s*-?[\d,]*\d\.\d{2}\s*(cr|dr)?\.?$/i

function key(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** A date token as YYYY-MM-DD, or null. dayFirst decides 03/04. */
export function readDate(s: string, dayFirst = true): string | null {
  const t = s.trim()
  let y: number, m: number, d: number
  let mt = DATE_NUM.exec(t)
  if (mt) {
    const [a, b, c] = [Number(mt[1]), Number(mt[2]), Number(mt[3])]
    if (mt[1].length === 4) [y, m, d] = [a, b, c]
    else if (dayFirst) [d, m, y] = [a, b, c]
    else [m, d, y] = [a, b, c]
  } else if ((mt = DATE_MON.exec(t))) {
    const mon = MONTHS[mt[2].toLowerCase()]
    if (!mon) return null
    ;[d, m, y] = [Number(mt[1]), mon, Number(mt[3])]
  } else return null
  if (y < 100) y += 2000
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2200) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${y}-${p(m)}-${p(d)}`
}

/** "1,23,456.78 Cr" → paise and its Cr/Dr mark. */
export function readMoney(s: string): { paise: number; mark: '' | 'cr' | 'dr'; minus: boolean } | null {
  const t = s.trim()
  if (!MONEY.test(t)) return null
  const mark = (/(cr|dr)\.?$/i.exec(t)?.[1]?.toLowerCase() ?? '') as '' | 'cr' | 'dr'
  const n = t.replace(/[^\d.]/g, '')
  const v = Math.round(Number(n) * 100)
  return Number.isFinite(v) ? { paise: v, mark, minus: t.includes('-') } : null
}

type Line = { page: number; y: number; words: PdfWord[] }

function toLines(words: PdfWord[]): Line[] {
  const sorted = [...words].filter((w) => w.str.trim()).sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const w of sorted) {
    const last = lines[lines.length - 1]
    if (last && last.page === w.page && Math.abs(last.y - w.y) <= 2.5) last.words.push(w)
    else lines.push({ page: w.page, y: w.y, words: [w] })
  }
  for (const l of lines) l.words.sort((a, b) => a.x - b.x)
  return lines
}

type Column = { role: Role; center: number; left: number; right: number }

/** The header line's columns, or null when the line isn't a header. */
function headerColumns(line: Line): Column[] | null {
  // Header words can be split ("Withdrawal" "Amt.") or joined; try each word
  // and each pair of neighbours.
  const cols: Column[] = []
  const ws = line.words
  for (let i = 0; i < ws.length; i++) {
    for (const span of [2, 1]) {
      if (i + span > ws.length) continue
      const part = ws.slice(i, i + span)
      const k = key(part.map((w) => w.str).join(' '))
      const hit = HEADERS.find(([re]) => re.test(k))
      if (!hit) continue
      const left = part[0].x
      const right = part[span - 1].x + part[span - 1].w
      cols.push({ role: hit[1], center: (left + right) / 2, left, right })
      i += span - 1
      break
    }
  }
  const roles = new Set(cols.map((c) => c.role))
  const money = roles.has('credit') || roles.has('debit') || roles.has('amount')
  return roles.has('date') && money && (roles.has('balance') || roles.has('note')) ? cols : null
}

const isSummary = (text: string) => /^(opening|closing|brought|carried) (balance|forward)|^b\/f|^c\/f|^balance (b|c)\/f/.test(key(text))

/** Reads the transactions from a statement's words. Throws when it can't find the table. */
export function readStatementWords(words: PdfWord[]): StatementTable {
  const lines = toLines(words)

  // Day-first unless a date only works the other way round.
  let dayFirst = true
  for (const w of words) {
    const m = DATE_NUM.exec(w.str.trim())
    if (m && m[1].length !== 4 && Number(m[2]) > 12 && Number(m[1]) <= 12) {
      dayFirst = false
      break
    }
  }

  let cols: Column[] | null = null
  let opening: number | null = null
  let closing: number | null = null

  type Anchor = { line: Line; date: string; amounts: { col: Role; paise: number; mark: string; minus: boolean }[]; notes: { y: number; page: number; text: string }[] }
  const anchors: Anchor[] = []
  // Every line of the table in reading order, to see which lines run together.
  const seq: { page: number; y: number; anchor: Anchor | null; text: string }[] = []
  let done = false

  const nearest = (x: number, roles: Role[]) => {
    let best: Column | null = null
    for (const c of cols!) if (roles.includes(c.role) && (!best || Math.abs(c.center - x) < Math.abs(best.center - x))) best = c
    return best
  }

  for (const line of lines) {
    if (done) break
    const h = headerColumns(line)
    if (h) {
      cols = h
      continue
    }
    if (!cols) continue // above the first header: the account's details

    const dateCol = cols.find((c) => c.role === 'date')!
    const noteCol = cols.find((c) => c.role === 'note')
    const moneyCols = cols.filter((c) => c.role === 'credit' || c.role === 'debit' || c.role === 'amount' || c.role === 'balance')
    const moneyLeft = Math.min(...moneyCols.map((c) => c.left)) - 40

    const text = line.words.map((w) => w.str).join(' ')
    const amounts: Anchor['amounts'] = []
    let date: string | null = null
    const noteWords: string[] = []
    for (const w of line.words) {
      const cx = w.x + w.w / 2
      const money = readMoney(w.str)
      if (money && cx >= moneyLeft) {
        const c = nearest(cx, ['credit', 'debit', 'amount', 'balance'])
        if (c) amounts.push({ col: c.role, ...money })
        continue
      }
      const asDate = readDate(w.str, dayFirst)
      if (asDate && !date && (!noteCol || cx < noteCol.left + 4) && Math.abs(cx - dateCol.center) < 90) {
        date = asDate
        continue
      }
      if (asDate && (!noteCol || cx < noteCol.left)) continue // a value date column
      if (cx < moneyLeft + 40) noteWords.push(w.str)
    }

    if (isSummary(text)) {
      const bal = amounts.find((a) => a.col === 'balance') ?? amounts[amounts.length - 1]
      const v = bal ? (bal.minus || bal.mark === 'dr' ? -bal.paise : bal.paise) : null
      if (/opening|brought|b f/.test(key(text))) opening ??= v
      else {
        closing = v
        if (/closing/.test(key(text))) done = true
      }
      continue
    }
    if (/^(page \d+|page \d+ of \d+|\d+ of \d+)$/i.test(key(text))) continue
    // "Chq: 0" lines carry nothing the description doesn't already say.
    const note = noteWords.join(' ').replace(/\bchq\s*(no)?\.?:?\s*\d*\s*$/i, '').trim()
    if (date && amounts.length > 0) {
      const a: Anchor = { line, date, amounts, notes: note ? [{ y: line.y, page: line.page, text: note }] : [] }
      anchors.push(a)
      seq.push({ page: line.page, y: line.y, anchor: a, text: '' })
    } else seq.push({ page: line.page, y: line.y, anchor: null, text: note })
  }

  if (!cols) throw new Error('Couldn’t find the table of transactions in this PDF.')
  if (anchors.length === 0) throw new Error('Found the table but no transactions in it.')

  // Which transaction each description line belongs to. Lines that run on
  // without a gap form a block; a block with one date is that transaction.
  // Where a block has several dates (tables without spacing between rows),
  // each line goes to the date above it, or to the nearest date when the
  // statement prints dates in the middle of their descriptions: then some
  // description lines come before a page's first date.
  const gaps: number[] = []
  for (let i = 1; i < seq.length; i++) if (seq[i].page === seq[i - 1].page) gaps.push(seq[i - 1].y - seq[i].y)
  gaps.sort((a, b) => a - b)
  const step = gaps.length ? gaps[Math.floor(gaps.length / 4)] : 12 // a line apart, without the blank gaps
  const blocks: (typeof seq)[] = []
  for (let i = 0; i < seq.length; i++) {
    const s = seq[i]
    const prev = seq[i - 1]
    if (!prev || prev.page !== s.page || prev.y - s.y > step * 1.5) blocks.push([s])
    else blocks[blocks.length - 1].push(s)
  }
  const firstOnPage = new Map<number, number>()
  for (const s of seq) if (s.anchor && !firstOnPage.has(s.page)) firstOnPage.set(s.page, s.y)
  const centred = seq.some((s) => !s.anchor && s.text && firstOnPage.has(s.page) && s.y > firstOnPage.get(s.page)!)

  blocks.forEach((block, bi) => {
    const dated = block.filter((s) => s.anchor)
    for (const s of block) {
      if (s.anchor || !s.text) continue
      let best: Anchor | null = null
      if (dated.length === 1) best = dated[0].anchor
      else if (dated.length > 1) {
        let bestD = Infinity
        for (const d of dated) {
          const dist = d.y - s.y // positive: the line is below the date
          if (centred ? Math.abs(dist) < bestD : dist >= 0 && dist < bestD) {
            best = d.anchor
            bestD = Math.abs(dist)
          }
        }
        best ??= dated[0].anchor
      } else {
        // A block without a date: the end of a description cut by a page
        // break, or its start when dates are centred and the date is on the
        // next page.
        const next = blocks.slice(bi + 1).find((b) => b.some((x) => x.anchor))
        const before = blocks
          .slice(0, bi)
          .reverse()
          .find((b) => b.some((x) => x.anchor))
        const lastOnPage = !blocks[bi + 1] || blocks[bi + 1].every((x) => x.page !== s.page)
        if (centred && lastOnPage && next) best = next.find((x) => x.anchor)!.anchor
        else if (before) best = [...before].reverse().find((x) => x.anchor)!.anchor
        else if (next) best = next.find((x) => x.anchor)!.anchor
      }
      best?.notes.push({ page: s.page, y: s.y, text: s.text })
    }
  })

  const rows: StatementRow[] = []
  let prev = opening
  for (const a of anchors) {
    a.notes.sort((p, q) => p.page - q.page || q.y - p.y)
    const note = a.notes
      .map((n) => n.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    const balA = a.amounts.find((x) => x.col === 'balance')
    const balance = balA ? (balA.minus || balA.mark === 'dr' ? -balA.paise : balA.paise) : null
    const moves = a.amounts.filter((x) => x !== balA)
    let credit = 0
    let debit = 0
    for (const m of moves) {
      if (m.col === 'credit' || m.mark === 'cr') credit += m.paise
      else if (m.col === 'debit' || m.mark === 'dr' || m.minus) debit += m.paise
      else credit += m.paise // an unsigned single amount column: decided by the balance below
    }
    const amount = Math.abs(credit - debit)
    if (amount === 0) continue
    // The running balance knows the direction better than column positions.
    if (prev !== null && balance !== null) {
      if (Math.abs(prev + amount - balance) <= 1) [credit, debit] = [amount, 0]
      else if (Math.abs(prev - amount - balance) <= 1) [credit, debit] = [0, amount]
    } else [credit, debit] = credit >= debit ? [amount, 0] : [0, amount]
    if (credit && debit) [credit, debit] = credit >= debit ? [credit - debit, 0] : [0, debit - credit]
    rows.push({ date: a.date, note, credit, debit, balance })
    if (balance !== null) prev = balance
  }

  const money = (p: number) => (p / 100).toFixed(2)
  const cell = (s: string) => `"${s.replace(/"/g, '""')}"`
  const csv = [
    'Date,Particulars,Deposits,Withdrawals,Balance',
    ...rows.map((r) => [r.date, cell(r.note), r.credit ? money(r.credit) : '', r.debit ? money(r.debit) : '', r.balance === null ? '' : money(r.balance)].join(',')),
  ].join('\n')
  return { rows, opening, closing, csv }
}
