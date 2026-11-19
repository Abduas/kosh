package main

import (
	"encoding/csv"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Reading another app's CSV export. Every money app writes its own columns,
// so instead of a parser per app, columns are recognised by their headers
// (date, amount, type, category, note, account…), the way a person would
// read the file. That covers Dime, Money Manager, Wallet, Spendee, Monefy,
// Money Lover, most bank statements and Kosh's own export.

// importRow is one transaction read from a file, before it's matched to the
// user's accounts and categories.
type importRow struct {
	Line      int
	Kind      string
	Amount    int64
	At        string // local wall-clock time, localTimeLayout
	Note      string
	Category  string
	Account   string
	ToAccount string
	Person    string
}

type importProblem struct {
	Line   int    `json:"line"`
	Reason string `json:"reason"`
}

type parsedImport struct {
	Format   string // the app the file looks like it came from, or ""
	Rows     []importRow
	Problems []importProblem
}

const maxImportRows = 50_000

// Column roles, each with the headers that mean it. A header is lowercased
// with punctuation turned into spaces first, so "Withdrawal Amt." is
// "withdrawal amt" and "Income/Expense" is "income expense".
var importRoles = []struct {
	role    string
	headers []string
}{
	{"date", []string{"date", "transaction date", "txn date", "tran date", "trans date", "posting date", "booking date", "date time", "datetime", "date and time", "timestamp", "created", "created at", "period", "day", "value date"}},
	{"time", []string{"time", "transaction time", "txn time"}},
	{"type", []string{"type", "transaction type", "txn type", "kind", "income expense", "expense income", "dr cr", "cr dr", "debit credit", "credit debit", "direction", "entry type", "category type"}},
	{"amount", []string{"amount", "amt", "transaction amount", "txn amount", "amount inr", "amount rs", "amount in rs", "amount in inr", "inr", "value", "sum", "price", "cost", "total"}},
	{"debit", []string{"debit", "debits", "debit amount", "debit amt", "withdrawal", "withdrawals", "withdrawal amount", "withdrawal amt", "money out", "paid out", "outflow", "spent", "dr", "dr amount", "expense", "expenses"}},
	{"credit", []string{"credit", "credits", "credit amount", "credit amt", "deposit", "deposits", "deposit amount", "deposit amt", "money in", "paid in", "inflow", "received", "cr", "cr amount", "income"}},
	{"category", []string{"category", "category name", "categories", "main category"}},
	{"note", []string{"note", "notes", "description", "memo", "title", "remarks", "remark", "narration", "details", "particulars", "transaction details", "payee", "merchant", "place", "comment", "comments", "name"}},
	{"account", []string{"account", "accounts", "account name", "wallet", "wallet name", "from account", "source account"}},
	{"to", []string{"to account", "to wallet", "transfer to", "destination account"}},
	{"person", []string{"person", "contact", "friend"}},
}

func headerKey(s string) string {
	var b strings.Builder
	space := false
	for _, c := range strings.ToLower(strings.TrimSpace(s)) {
		if unicode.IsLetter(c) || unicode.IsDigit(c) {
			if space && b.Len() > 0 {
				b.WriteByte(' ')
			}
			space = false
			b.WriteRune(c)
		} else {
			space = true
		}
	}
	return b.String()
}

// columns maps roles to column indexes. note may have several (a note and a
// description), joined in order.
type columns struct {
	idx   map[string]int
	notes []int
}

func (c columns) has(role string) bool { _, ok := c.idx[role]; return ok }

func findColumns(header []string) columns {
	c := columns{idx: map[string]int{}}
	for i, h := range header {
		key := headerKey(h)
		for _, r := range importRoles {
			hit := false
			for _, name := range r.headers {
				if key == name {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
			if r.role == "note" {
				c.notes = append(c.notes, i)
			} else if _, taken := c.idx[r.role]; !taken {
				c.idx[r.role] = i
			}
			break
		}
	}
	// A file with an amount column uses it; debit and credit columns are only
	// for statements that split money out and in.
	if c.has("amount") {
		delete(c.idx, "debit")
		delete(c.idx, "credit")
	}
	return c
}

func (c columns) usable() bool {
	return c.has("date") && (c.has("amount") || c.has("debit") || c.has("credit"))
}

func detectFormat(header []string, c columns) string {
	keys := map[string]bool{}
	for _, h := range header {
		keys[headerKey(h)] = true
	}
	switch {
	case keys["to account"] && keys["person"]:
		return "Kosh"
	case len(header) == 5 && keys["date"] && keys["note"] && keys["amount"] && keys["category"] && keys["type"]:
		return "Dime"
	case keys["income expense"] && keys["period"]:
		return "Money Manager"
	case keys["ref currency amount"] || keys["payment type"]:
		return "Wallet"
	case keys["category name"] && keys["wallet"]:
		return "Spendee"
	case keys["converted amount"]:
		return "Monefy"
	case (c.has("debit") || c.has("credit")) && (keys["balance"] || keys["closing balance"]):
		return "a bank statement"
	}
	return ""
}

// sniffDelimiter picks comma, semicolon or tab: whichever splits some line
// near the top into the most fields. (Bank statements can start with a
// title line that has none.)
func sniffDelimiter(text string) rune {
	best, bestN := ',', 0
	for i, line := range strings.SplitN(text, "\n", 21) {
		if i == 20 {
			break
		}
		for _, d := range []rune{',', ';', '\t'} {
			n, quoted := 0, false
			for _, c := range line {
				if c == '"' {
					quoted = !quoted
				} else if c == d && !quoted {
					n++
				}
			}
			if n > bestN {
				best, bestN = d, n
			}
		}
	}
	return best
}

func parseImportCSV(text string, loc *time.Location) (parsedImport, error) {
	var out parsedImport
	text = strings.TrimPrefix(text, "\uFEFF")
	if !utf8.ValidString(text) {
		text = strings.ToValidUTF8(text, "")
	}
	r := csv.NewReader(strings.NewReader(text))
	r.Comma = sniffDelimiter(text)
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	r.TrimLeadingSpace = true
	r.ReuseRecord = false

	// Bank statements often start with a few lines about the account, so the
	// header is the first row that names a date and an amount.
	var cols columns
	var header []string
	line := 0
	for header == nil {
		rec, err := r.Read()
		line++
		if err == io.EOF || line > 40 {
			return out, errValidation("Couldn't find the columns in this file. It needs a header row with at least a date and an amount.")
		}
		if err != nil {
			return out, errValidation("This doesn't look like a CSV file.")
		}
		if c := findColumns(rec); c.usable() {
			cols, header = c, rec
		}
	}
	out.Format = detectFormat(header, cols)

	var records [][]string
	var lines []int
	for {
		rec, err := r.Read()
		line++
		if err == io.EOF {
			break
		}
		if err != nil {
			out.Problems = append(out.Problems, importProblem{line, "Couldn't read this line"})
			continue
		}
		empty := true
		for _, v := range rec {
			if strings.TrimSpace(v) != "" {
				empty = false
				break
			}
		}
		if empty {
			continue
		}
		if len(records) >= maxImportRows {
			return out, errValidation(fmt.Sprintf("That's more than %d rows. Split the file and import it in parts.", maxImportRows))
		}
		records = append(records, rec)
		lines = append(lines, line)
	}

	cell := func(rec []string, role string) string {
		if i, ok := cols.idx[role]; ok && i < len(rec) {
			return strings.TrimSpace(rec[i])
		}
		return ""
	}

	// Whether 03/04 means 3 April or March 4 is decided for the whole file.
	var dates []string
	for _, rec := range records {
		dates = append(dates, cell(rec, "date"))
	}
	dayFirst := dayFirstDates(dates)

	// Apps that sign amounts (Wallet, Monefy, Money Lover) mark spending with a
	// minus. Without any minus, every row without a type is spending.
	signed := false
	if cols.has("amount") && !cols.has("type") {
		for _, rec := range records {
			if _, neg, _, ok := parseAmount(cell(rec, "amount")); ok && neg {
				signed = true
				break
			}
		}
	}

	for n, rec := range records {
		ln := lines[n]
		at, err := parseWhen(cell(rec, "date"), cell(rec, "time"), dayFirst, loc)
		if err != nil {
			out.Problems = append(out.Problems, importProblem{ln, "Couldn't read the date"})
			continue
		}
		row := importRow{Line: ln, At: at}

		typeText := cell(rec, "type")
		row.Kind = classifyType(typeText)
		if row.Kind == "transfer-in" {
			out.Problems = append(out.Problems, importProblem{ln, "Incoming side of a transfer (the outgoing side is imported)"})
			continue
		}
		if cols.has("amount") {
			amt, neg, hint, ok := parseAmount(cell(rec, "amount"))
			if !ok {
				out.Problems = append(out.Problems, importProblem{ln, "No amount"})
				continue
			}
			row.Amount = amt
			if row.Kind == "" {
				row.Kind = hint
			}
			if row.Kind == "" {
				if neg || !signed {
					row.Kind = "expense"
				} else {
					row.Kind = "income"
				}
			}
		} else {
			debit, _, _, dok := parseAmount(cell(rec, "debit"))
			credit, _, _, cok := parseAmount(cell(rec, "credit"))
			switch {
			case dok && debit > 0:
				row.Amount = debit
				if row.Kind == "" {
					row.Kind = "expense"
				}
			case cok && credit > 0:
				row.Amount = credit
				if row.Kind == "" {
					row.Kind = "income"
				}
			}
		}
		if row.Amount <= 0 {
			out.Problems = append(out.Problems, importProblem{ln, "Amount is zero"})
			continue
		}
		if row.Amount > maxAmount {
			out.Problems = append(out.Problems, importProblem{ln, "Amount is too large"})
			continue
		}

		var notes []string
		for _, i := range cols.notes {
			if i < len(rec) {
				v := strings.TrimSpace(strings.TrimPrefix(rec[i], "'"))
				if v != "" && !containsFold(notes, v) {
					notes = append(notes, v)
				}
			}
		}
		row.Note = truncateRunes(strings.Join(notes, " · "), 280)
		row.Account = truncateRunes(cell(rec, "account"), 40)
		row.ToAccount = truncateRunes(cell(rec, "to"), 40)
		row.Person = truncateRunes(cell(rec, "person"), 60)
		if row.Kind == "expense" || row.Kind == "income" {
			row.Category = truncateRunes(cell(rec, "category"), 40)
		}

		switch {
		case row.Kind == "transfer" && (row.ToAccount == "" || strings.EqualFold(row.ToAccount, row.Account)):
			out.Problems = append(out.Problems, importProblem{ln, "Transfer without the account it went to"})
			continue
		case personKinds[row.Kind] && row.Person == "":
			out.Problems = append(out.Problems, importProblem{ln, "Loan without a person"})
			continue
		}
		out.Rows = append(out.Rows, row)
	}

	// Oldest first, so transactions on the same day keep the file's order.
	if len(out.Rows) > 1 && out.Rows[0].At > out.Rows[len(out.Rows)-1].At {
		for i, j := 0, len(out.Rows)-1; i < j; i, j = i+1, j-1 {
			out.Rows[i], out.Rows[j] = out.Rows[j], out.Rows[i]
		}
	}
	sort.SliceStable(out.Rows, func(i, j int) bool { return out.Rows[i].At < out.Rows[j].At })
	return out, nil
}

func containsFold(list []string, s string) bool {
	for _, v := range list {
		if strings.EqualFold(v, s) {
			return true
		}
	}
	return false
}

func truncateRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return strings.TrimSpace(string([]rune(s)[:n]))
}

// classifyType reads a type column: Kosh's own kinds, or words like
// "Expense", "Exp.", "Debit", "DR", "Income", "Credit", "Deposit".
// It returns "" when the value says nothing.
func classifyType(v string) string {
	raw := strings.ToLower(strings.TrimSpace(v))
	s := headerKey(raw)
	switch s {
	case "expense", "income", "lend", "borrow", "collect", "repay":
		return s
	case "transfer", "transfer out":
		return "transfer"
	case "transfer in":
		return "transfer-in"
	case "":
		switch raw {
		case "-":
			return "expense"
		case "+":
			return "income"
		}
		return ""
	}
	if strings.Contains(s, "transfer") {
		if strings.Contains(s, " in") {
			return "transfer-in"
		}
		return "transfer"
	}
	for _, p := range []string{"exp", "deb", "dr", "withdr", "out", "spen", "paid", "payment", "purchase", "spent"} {
		if strings.HasPrefix(s, p) {
			return "expense"
		}
	}
	for _, p := range []string{"inc", "cred", "cr", "dep", "in", "rec", "earn", "refund"} {
		if strings.HasPrefix(s, p) {
			return "income"
		}
	}
	return ""
}

// parseAmount reads "1,234.50", "₹ 1,23,456", "-500", "(500)", "1.234,50",
// "500.00 Dr". It returns paise, whether it was negative, and "expense" or
// "income" when the amount itself says Dr or Cr.
func parseAmount(s string) (int64, bool, string, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	hint := ""
	if strings.HasSuffix(s, "dr") || strings.HasSuffix(s, "dr.") {
		hint = "expense"
	} else if strings.HasSuffix(s, "cr") || strings.HasSuffix(s, "cr.") {
		hint = "income"
	}
	neg := strings.HasPrefix(s, "(") && strings.HasSuffix(s, ")")
	var b strings.Builder
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9', c == '.', c == ',':
			b.WriteRune(c)
		case c == '-' || c == '−':
			neg = true
		}
	}
	n := strings.TrimLeft(b.String(), ".,") // "Rs.500"
	if !strings.ContainsAny(n, "0123456789") {
		return 0, false, "", false
	}
	dot, comma := strings.LastIndex(n, "."), strings.LastIndex(n, ",")
	switch {
	case dot >= 0 && comma >= 0 && comma > dot: // 1.234,50
		n = strings.ReplaceAll(n, ".", "")
		n = strings.Replace(n, ",", ".", 1)
	case dot >= 0 && comma >= 0: // 1,234.50
		n = strings.ReplaceAll(n, ",", "")
	case comma >= 0 && strings.Count(n, ",") == 1 && len(n)-comma-1 <= 2: // 12,50
		n = strings.Replace(n, ",", ".", 1)
	case comma >= 0: // 1,23,456
		n = strings.ReplaceAll(n, ",", "")
	case strings.Count(n, ".") > 1: // 1.234.567
		n = strings.ReplaceAll(n, ".", "")
	}
	f, err := strconv.ParseFloat(n, 64)
	if err != nil || math.IsInf(f, 0) || f > float64(maxAmount)/100 {
		return 0, false, "", false
	}
	return int64(math.Round(f * 100)), neg, hint, true
}

var numericDate = regexp.MustCompile(`^(\d{1,4})[/.\-](\d{1,2})[/.\-](\d{1,4})(?:[ T,]+(.+))?$`)

// dayFirstDates decides whether the file's dates are day/month (India,
// Europe) or month/day (US). A first number over 12 settles it; with no
// evidence, day first.
func dayFirstDates(values []string) bool {
	monthFirst := false
	for _, v := range values {
		m := numericDate.FindStringSubmatch(strings.TrimSpace(v))
		if m == nil || len(m[1]) == 4 {
			continue
		}
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		if a > 12 {
			return true
		}
		if b > 12 {
			monthFirst = true
		}
	}
	return !monthFirst
}

var clockLayouts = []string{
	"15:04", "15:04:05", "3:04 PM", "3:04:05 PM", "3:04PM", "3:04:05PM", "15.04", "15.04.05",
	"15:04:05 -0700", "15:04:05 -07:00", "15:04:05Z07:00", "15:04 -0700", "15:04Z07:00", "15:04:05 MST",
}

var namedDateLayouts = []string{
	"2 Jan 2006", "2 January 2006", "Jan 2, 2006", "January 2, 2006", "Jan 2 2006", "January 2 2006",
	"2-Jan-2006", "2-Jan-06", "2 Jan 06", "2/Jan/2006", "Mon, 2 Jan 2006", "Mon 2 Jan 2006", "Monday, January 2, 2006", "Mon, Jan 2, 2006",
}

var namedClockSuffixes = []string{"", " 15:04", " 15:04:05", " 3:04 PM", " 3:04:05 PM", ", 15:04", ", 3:04 PM", " at 3:04 PM", " at 15:04"}

// tidyWords title-cases month and day names and upper-cases AM/PM, so
// "02-JAN-2026 3:15 pm" parses with Go's layouts.
func tidyWords(s string) string {
	var b strings.Builder
	word := []rune{}
	flush := func() {
		if len(word) == 0 {
			return
		}
		w := strings.ToLower(string(word))
		switch {
		case w == "am" || w == "pm":
			w = strings.ToUpper(w)
		case unicode.IsLetter(word[0]):
			w = strings.ToUpper(w[:1]) + w[1:]
		}
		b.WriteString(w)
		word = word[:0]
	}
	for _, c := range s {
		if unicode.IsLetter(c) {
			word = append(word, c)
			continue
		}
		flush()
		b.WriteRune(c)
	}
	flush()
	return b.String()
}

// parseWhen turns a date (and maybe a separate time) into local wall-clock
// time. Times with a zone, such as Dime's "+0000", move into loc. A date
// without a time is noon, as when a transaction is added without one.
func parseWhen(date, clock string, dayFirst bool, loc *time.Location) (string, error) {
	s := strings.Join(strings.Fields(date+" "+clock), " ")
	if s == "" {
		return "", errValidation("no date")
	}
	ok := func(t time.Time) bool { return t.Year() >= 1970 && t.Year() <= 2200 }

	if m := numericDate.FindStringSubmatch(s); m != nil {
		a, _ := strconv.Atoi(m[1])
		b, _ := strconv.Atoi(m[2])
		c, _ := strconv.Atoi(m[3])
		var y, mo, d int
		switch {
		case len(m[1]) == 4:
			y, mo, d = a, b, c
		case dayFirst:
			d, mo, y = a, b, c
		default:
			mo, d, y = a, b, c
		}
		if y < 100 {
			y += 2000
		}
		if mo < 1 || mo > 12 || d < 1 || d > 31 {
			return "", errValidation("bad date")
		}
		day := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		if day.Day() != d || !ok(day) {
			return "", errValidation("bad date")
		}
		rest := strings.TrimSpace(m[4])
		if rest == "" {
			return day.Add(12 * time.Hour).Format(localTimeLayout), nil
		}
		rest = tidyWords(strings.TrimSuffix(rest, "Z"))
		zoned := strings.HasSuffix(strings.TrimSpace(m[4]), "Z")
		for _, l := range clockLayouts {
			t, err := time.Parse(l, rest)
			if err != nil {
				continue
			}
			at := time.Date(y, time.Month(mo), d, t.Hour(), t.Minute(), 0, 0, t.Location())
			if zoned {
				at = time.Date(y, time.Month(mo), d, t.Hour(), t.Minute(), 0, 0, time.UTC)
			}
			if zoned || strings.Contains(l, "07") || strings.Contains(l, "MST") {
				at = at.In(loc)
			}
			return at.Format(localTimeLayout), nil
		}
		return "", errValidation("bad time")
	}

	for _, l := range []string{time.RFC3339, time.RFC1123Z, time.RFC1123, time.RFC850, time.ANSIC, time.UnixDate, "2006-01-02 15:04:05 -0700 MST"} {
		if t, err := time.Parse(l, s); err == nil && ok(t) {
			return t.In(loc).Format(localTimeLayout), nil
		}
	}
	tidy := tidyWords(s)
	for _, base := range namedDateLayouts {
		for _, suffix := range namedClockSuffixes {
			t, err := time.Parse(base+suffix, tidy)
			if err != nil || !ok(t) {
				continue
			}
			if suffix == "" {
				t = t.Add(12 * time.Hour)
			}
			return t.Format(localTimeLayout), nil
		}
	}
	return "", errValidation("bad date")
}
