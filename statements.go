package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Checking a bank statement: what the bank says happened in an account, set
// against what Kosh has, without changing anything. It answers three things:
// how much interest the bank paid (many people, Muslims among them, don't
// keep interest and need to know what to give away), what the bank charged,
// and which entries are missing on either side.
//
// The phone turns the statement (PDF, Excel or CSV) into CSV text, the way
// imports do; the file itself never reaches the server. Only rows the person
// picks are added, as source "statement" with a ref made from the row, so
// checking the same statement again adds nothing twice.

const (
	labelInterest     = "interest"      // interest the bank paid you
	labelInterestPaid = "interest-paid" // interest you paid (a loan, an overdraft, a card)
	labelTDS          = "tds"           // tax taken from interest
	labelCharges      = "charges"       // the bank's fees
)

var (
	// Payments between people (UPI, NEFT, IMPS, RTGS) carry names and handles
	// that can look like anything, so only the bank's own entries are labelled.
	stmtTransfer = regexp.MustCompile(`^(UPI|NEFT|IMPS|RTGS|INET-IMPS|MMT|NACH|ACH|ECS|BIL/|BY TRANSFER|TO TRANSFER|BY CLG|ATM|POS|NWD|CASH)\b`)
	// Interest, however banks abbreviate it: "SBINT", "SB INT", "INT.PD",
	// "Int Paid", "CREDIT INTEREST", "FD INT", "INTEREST ON …". INT must be a
	// whole word, so INTERNET, INTL and INTERNATIONAL aren't interest.
	stmtInterest = regexp.MustCompile(`\b(INTEREST|(SB|SBA|SAV|SAVINGS|FD|TD|RD|MOD|SWEEP|DEP|TDR|STDR)[ -]?INT|INT\.?[ -]?(PD|PAID|CR|CRED|CREDIT|CREDITED|COLL|COLLECTED|ON|FOR|APPLIED|CAPITALI[SZ]ED|AMT|AMOUNT)|INT)\b`)
	stmtTDS      = regexp.MustCompile(`\b(TDS|TAX DEDUCTED)\b`)
	stmtCharges  = regexp.MustCompile(`\b(CHARGES?|CHRGS?|CHGS?|FEES?|PENALTY|PENAL|GST|AMC|ANNUAL MAINT|MIN(IMUM)? ?BAL|NON[- ]MAINT|SMS ALERT|CONSOLIDATED CHARGES|SERVICE TAX|DEBIT CARD ANNUAL)\b`)
)

// statementLabel says what a statement row is, when it's one of the bank's
// own entries Kosh recognises.
func statementLabel(note string, in bool) string {
	n := strings.ToUpper(strings.Join(strings.Fields(note), " "))
	if stmtTransfer.MatchString(n) {
		return ""
	}
	switch {
	case in && stmtInterest.MatchString(n):
		return labelInterest
	case !in && stmtTDS.MatchString(n):
		return labelTDS
	case !in && stmtInterest.MatchString(n):
		return labelInterestPaid
	case !in && stmtCharges.MatchString(n):
		return labelCharges
	}
	return ""
}

type statementRow struct {
	Index   int    `json:"index"`
	At      string `json:"at"`
	Kind    string `json:"kind"` // income or expense, from the account's side
	Amount  int64  `json:"amount"`
	Note    string `json:"note"`
	Balance *int64 `json:"balance"`
	Label   string `json:"label"`
	// The Kosh transaction it matched, if any.
	Match *statementMatch `json:"match"`
}

type statementMatch struct {
	ID         int64  `json:"id"`
	At         string `json:"at"`
	Kind       string `json:"kind"`
	CategoryID *int64 `json:"categoryId"`
	Note       string `json:"note"`
}

type koshOnlyRow struct {
	ID     int64  `json:"id"`
	At     string `json:"at"`
	Kind   string `json:"kind"` // the transaction's own kind
	In     bool   `json:"in"`   // whether it put money into this account
	Amount int64  `json:"amount"`
	Note   string `json:"note"`
}

type statementCheck struct {
	AccountID int64  `json:"accountId"`
	From      string `json:"from"`
	To        string `json:"to"`
	Count     int    `json:"count"`
	MoneyIn   int64  `json:"moneyIn"`
	MoneyOut  int64  `json:"moneyOut"`
	// The statement's balances, when it prints a running balance.
	Opening *int64 `json:"opening"`
	Closing *int64 `json:"closing"`
	// Rows whose balance doesn't follow from the one before: a sign that the
	// file was read wrong or is missing rows.
	Breaks []int `json:"breaks"`
	// Kosh's balance for the account at the end of the statement's last day.
	KoshClosing int64 `json:"koshClosing"`
	// Totals of the rows Kosh recognised.
	Interest     int64 `json:"interest"`
	InterestPaid int64 `json:"interestPaid"`
	TDS          int64 `json:"tds"`
	Charges      int64 `json:"charges"`

	Rows     []statementRow `json:"rows"`
	Matched  int            `json:"matched"`
	Missing  int            `json:"missing"`
	KoshOnly []koshOnlyRow  `json:"koshOnly"`
	// The categories interest and charges go into, when the person has them.
	InterestCategoryID *int64          `json:"interestCategoryId"`
	ChargesCategoryID  *int64          `json:"chargesCategoryId"`
	Problems           []importProblem `json:"problems"`
}

// POST /api/statements/check
func (a *api) checkStatement(w http.ResponseWriter, r *http.Request, uid int64) {
	in, p, ok := a.readImport(w, r)
	if !ok {
		return
	}
	if !a.ownsAccount(r.Context(), uid, in.AccountID) {
		respondErr(w, errValidation("Pick the account this statement is for"))
		return
	}
	for _, row := range p.Rows {
		if row.Kind != "income" && row.Kind != "expense" {
			respondErr(w, errValidation("This doesn't look like a bank statement: it has transfers or loans in it. Use Import for files from other apps."))
			return
		}
	}
	out, err := a.compareStatement(r.Context(), uid, in.AccountID, p)
	if err != nil {
		respondErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (a *api) ownsAccount(ctx context.Context, uid, id int64) bool {
	var n int
	a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE id = ? AND user_id = ?`, id, uid).Scan(&n)
	return n == 1
}

func (a *api) compareStatement(ctx context.Context, uid, accountID int64, p parsedImport) (statementCheck, error) {
	out := statementCheck{AccountID: accountID, Breaks: []int{}, KoshOnly: []koshOnlyRow{}, Problems: p.Problems}
	if out.Problems == nil {
		out.Problems = []importProblem{}
	}
	// The bank's own order, oldest first: banks list entries as they were
	// posted, which isn't always date order (interest dated the 28th can come
	// before payments of the 27th), and the running balance follows it.
	posted := append([]importRow(nil), p.Rows...)
	sort.SliceStable(posted, func(i, j int) bool { return posted[i].Line < posted[j].Line })
	if posted[0].At > posted[len(posted)-1].At {
		for i, j := 0, len(posted)-1; i < j; i, j = i+1, j-1 {
			posted[i], posted[j] = posted[j], posted[i]
		}
	}
	rows := make([]statementRow, len(posted))
	for i, x := range posted {
		rows[i] = statementRow{Index: i, At: x.At, Kind: x.Kind, Amount: x.Amount, Note: x.Note, Balance: x.Balance, Label: statementLabel(x.Note, x.Kind == "income")}
		if x.Kind == "income" {
			out.MoneyIn += x.Amount
		} else {
			out.MoneyOut += x.Amount
		}
		switch rows[i].Label {
		case labelInterest:
			out.Interest += x.Amount
		case labelInterestPaid:
			out.InterestPaid += x.Amount
		case labelTDS:
			out.TDS += x.Amount
		case labelCharges:
			out.Charges += x.Amount
		}
	}
	out.Count = len(rows)
	out.From, out.To = rows[0].At[:10], rows[0].At[:10]
	for _, r := range rows {
		out.From, out.To = min(out.From, r.At[:10]), max(out.To, r.At[:10])
	}

	// The running balance: each row's balance should be the one before plus
	// or minus its amount.
	signed := func(r statementRow) int64 {
		if r.Kind == "income" {
			return r.Amount
		}
		return -r.Amount
	}
	var prev *int64
	for i, r := range rows {
		if r.Balance == nil {
			prev = nil
			continue
		}
		if i == 0 {
			o := *r.Balance - signed(r)
			out.Opening = &o
		} else if prev != nil && *prev+signed(r) != *r.Balance {
			out.Breaks = append(out.Breaks, i)
		}
		prev = r.Balance
	}
	if last := rows[len(rows)-1]; last.Balance != nil {
		c := *last.Balance
		out.Closing = &c
	}

	// Kosh's side: everything that touched the account around the period.
	from, _ := time.Parse("2006-01-02", out.From)
	to, _ := time.Parse("2006-01-02", out.To)
	const slack = 3
	lo := from.AddDate(0, 0, -slack).Format("2006-01-02")
	hi := to.AddDate(0, 0, slack+1).Format("2006-01-02")
	q, err := a.db.QueryContext(ctx, `SELECT id, kind, amount, occurred_at, note, ref, category_id, account_id = ? FROM transactions
		WHERE user_id = ? AND (account_id = ? OR to_account_id = ?) AND occurred_at >= ? AND occurred_at < ? ORDER BY occurred_at, id`,
		accountID, uid, accountID, accountID, lo, hi)
	if err != nil {
		return out, err
	}
	type koshTx struct {
		koshOnlyRow
		ref        string
		categoryID *int64
		day        time.Time
		used       bool
	}
	var kosh []*koshTx
	for q.Next() {
		var t koshTx
		var fromHere bool
		if err := q.Scan(&t.ID, &t.Kind, &t.Amount, &t.At, &t.Note, &t.ref, &t.categoryID, &fromHere); err != nil {
			q.Close()
			return out, err
		}
		switch t.Kind {
		case "income", "borrow", "collect":
			t.In = true
		case "transfer":
			t.In = !fromHere
		}
		t.day, _ = time.Parse("2006-01-02", t.At[:10])
		kosh = append(kosh, &t)
	}
	q.Close()
	if err := q.Err(); err != nil {
		return out, err
	}

	match := func(i int, t *koshTx) {
		t.used = true
		rows[i].Match = &statementMatch{ID: t.ID, At: t.At, Kind: t.Kind, CategoryID: t.categoryID, Note: t.Note}
	}
	// First, payments whose UPI reference Kosh saved from the bank's SMS: the
	// statement's description has the same number.
	for i, r := range rows {
		for _, t := range kosh {
			if !t.used && t.ref != "" && len(t.ref) >= 8 && t.In == (r.Kind == "income") && t.Amount == r.Amount && strings.Contains(r.Note, t.ref) {
				match(i, t)
				break
			}
		}
	}
	// Then the same amount in the same direction within a few days, closest
	// dates first, so two ₹100s a day apart each find their own.
	type pair struct {
		row, tx int
		gap     time.Duration
	}
	var pairs []pair
	for i, r := range rows {
		if r.Match != nil {
			continue
		}
		day, _ := time.Parse("2006-01-02", r.At[:10])
		for j, t := range kosh {
			if t.used || t.In != (r.Kind == "income") || t.Amount != r.Amount {
				continue
			}
			if gap := absDuration(t.day.Sub(day)); gap <= slack*24*time.Hour {
				pairs = append(pairs, pair{i, j, gap})
			}
		}
	}
	sort.SliceStable(pairs, func(x, y int) bool { return pairs[x].gap < pairs[y].gap })
	for _, pr := range pairs {
		if rows[pr.row].Match == nil && !kosh[pr.tx].used {
			match(pr.row, kosh[pr.tx])
		}
	}

	for _, r := range rows {
		if r.Match != nil {
			out.Matched++
		} else {
			out.Missing++
		}
	}
	// Kosh entries in the statement's own days that the bank doesn't have.
	for _, t := range kosh {
		day := t.At[:10]
		if !t.used && day >= out.From && day <= out.To {
			out.KoshOnly = append(out.KoshOnly, t.koshOnlyRow)
		}
	}
	out.Rows = rows

	if out.KoshClosing, err = a.balanceAt(ctx, uid, accountID, out.To); err != nil {
		return out, err
	}
	out.InterestCategoryID, err = a.roleCategory(ctx, a.db, uid, labelInterest)
	if err != nil {
		return out, err
	}
	out.ChargesCategoryID, err = a.roleCategory(ctx, a.db, uid, labelCharges)
	return out, err
}

// balanceAt is an account's balance at the end of day (YYYY-MM-DD).
func (a *api) balanceAt(ctx context.Context, uid, accountID int64, day string) (int64, error) {
	end := day + "T99"
	var bal int64
	err := a.db.QueryRowContext(ctx, `SELECT a.opening_balance
		+ COALESCE((SELECT SUM(`+accountEffect+`) FROM transactions t WHERE t.account_id = a.id AND t.occurred_at <= ?), 0)
		+ COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.to_account_id = a.id AND t.occurred_at <= ?), 0)
		FROM accounts a WHERE a.id = ? AND a.user_id = ?`, end, end, accountID, uid).Scan(&bal)
	return bal, err
}

type querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// roleCategory is the person's category for a role, or nil when they have
// none. The starter Interest category has the role already.
func (a *api) roleCategory(ctx context.Context, db querier, uid int64, role string) (*int64, error) {
	var id int64
	err := db.QueryRowContext(ctx, `SELECT id FROM categories WHERE user_id = ? AND role = ? ORDER BY archived, id LIMIT 1`, uid, role).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &id, err
}

var roleCategories = map[string]struct{ kind, name, icon, color string }{
	labelInterest:    {"income", "Interest", "📈", "#8B5CF6"},
	"interest-given": {"expense", "Interest given away", "🤲", "#14B8A6"},
	labelCharges:     {"expense", "Bank charges", "🧾", "#64748B"},
}

// ensureRoleCategory finds or makes the category for a role. A category of
// the right kind and name that predates roles is adopted.
func ensureRoleCategory(ctx context.Context, tx *sql.Tx, uid int64, role string) (int64, error) {
	def := roleCategories[role]
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM categories WHERE user_id = ? AND role = ? ORDER BY archived, id LIMIT 1`, uid, role).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	err = tx.QueryRowContext(ctx, `SELECT id FROM categories WHERE user_id = ? AND kind = ? AND name = ? COLLATE NOCASE AND role = '' ORDER BY archived, id LIMIT 1`, uid, def.kind, def.name).Scan(&id)
	if err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE categories SET role = ?, archived = 0 WHERE id = ?`, role, id)
		return id, err
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO categories (user_id, kind, name, icon, color, sort_order, role)
		VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE user_id = ? AND kind = ?), ?)`,
		uid, def.kind, def.name, def.icon, def.color, uid, def.kind, role)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// POST /api/statements/add: add the statement rows the person picked.
func (a *api) addStatementRows(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		AccountID int64 `json:"accountId"`
		Rows      []struct {
			At     string `json:"at"`
			Kind   string `json:"kind"`
			Amount int64  `json:"amount"`
			Note   string `json:"note"`
			Label  string `json:"label"`
		} `json:"rows"`
		// Lower the account's opening balance by what's added, so its
		// balance today stays what it is.
		KeepBalance bool `json:"keepBalance"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if !a.ownsAccount(r.Context(), uid, in.AccountID) {
		respondErr(w, errValidation("Pick the account these are for"))
		return
	}
	if len(in.Rows) == 0 || len(in.Rows) > maxImportRows {
		respondErr(w, errValidation("Pick the entries to add"))
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()

	categories := map[string]int64{}
	added, skipped := 0, 0
	var delta int64
	seen := map[string]int{}
	for _, row := range in.Rows {
		if (row.Kind != "income" && row.Kind != "expense") || row.Amount <= 0 || row.Amount > maxAmount {
			respondErr(w, errValidation("One of the entries isn't money in or out"))
			return
		}
		if _, err := time.Parse(localTimeLayout, row.At); err != nil {
			respondErr(w, errValidation("One of the entries has no date"))
			return
		}
		note := truncateRunes(strings.TrimSpace(row.Note), 280)
		key := fmt.Sprintf("%d\x1f%s\x1f%s\x1f%d\x1f%s", in.AccountID, row.At, row.Kind, row.Amount, note)
		n := seen[key]
		seen[key] = n + 1
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x1f%d", key, n)))
		ref := "stmt:" + hex.EncodeToString(sum[:8])
		var exists int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM transactions WHERE user_id = ? AND source = 'statement' AND ref = ?`, uid, ref).Scan(&exists); err != nil {
			serverError(w, err)
			return
		}
		if exists > 0 {
			skipped++
			continue
		}
		t := transaction{Kind: row.Kind, Amount: row.Amount, AccountID: in.AccountID, Note: note, OccurredAt: row.At, Source: "statement", Ref: ref}
		role := ""
		switch {
		case row.Label == labelInterest && row.Kind == "income":
			role = labelInterest
		case row.Label == labelCharges && row.Kind == "expense":
			role = labelCharges
		}
		if role != "" {
			id, ok := categories[role]
			if !ok {
				if id, err = ensureRoleCategory(ctx, tx, uid, role); err != nil {
					serverError(w, err)
					return
				}
				categories[role] = id
			}
			t.CategoryID = &id
		}
		if _, err := insertTx(ctx, tx, uid, t); err != nil {
			serverError(w, err)
			return
		}
		added++
		if row.Kind == "income" {
			delta += row.Amount
		} else {
			delta -= row.Amount
		}
	}
	if in.KeepBalance && delta != 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE accounts SET opening_balance = opening_balance - ? WHERE id = ? AND user_id = ?`, delta, in.AccountID, uid); err != nil {
			serverError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"added": added, "skipped": skipped})
}

// POST /api/statements/mark-interest: file Kosh transactions under Interest
// (the statement showed they were interest, but Kosh had them as something
// else).
func (a *api) markInterest(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if len(in.IDs) == 0 || len(in.IDs) > 1000 {
		respondErr(w, errValidation("Pick the entries that were interest"))
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	cat, err := ensureRoleCategory(ctx, tx, uid, labelInterest)
	if err != nil {
		serverError(w, err)
		return
	}
	n := 0
	for _, id := range in.IDs {
		res, err := tx.ExecContext(ctx, `UPDATE transactions SET category_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
			WHERE id = ? AND user_id = ? AND kind = 'income'`, cat, id, uid)
		if err != nil {
			serverError(w, err)
			return
		}
		c, _ := res.RowsAffected()
		n += int(c)
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": n, "categoryId": cat})
}

// ---- Interest to give away ----

type interestYear struct {
	Year   string `json:"year"`
	Earned int64  `json:"earned"`
	Given  int64  `json:"given"`
}

type interestEntry struct {
	ID        int64  `json:"id"`
	At        string `json:"at"`
	Amount    int64  `json:"amount"`
	Note      string `json:"note"`
	AccountID int64  `json:"accountId"`
	Given     bool   `json:"given"` // given away, rather than earned
}

type interestSummary struct {
	Earned  int64           `json:"earned"`
	Given   int64           `json:"given"`
	ToGive  int64           `json:"toGive"`
	Years   []interestYear  `json:"years"`
	Entries []interestEntry `json:"entries"`
}

// interestTotals is what the person earned in interest (income in their
// interest category) and what they've given away (expenses in their
// interest-given category), by year.
func (a *api) interestTotals(ctx context.Context, uid int64) (interestSummary, error) {
	out := interestSummary{Years: []interestYear{}, Entries: []interestEntry{}}
	rows, err := a.db.QueryContext(ctx, `SELECT t.id, t.occurred_at, t.amount, t.note, t.account_id, c.role = 'interest-given'
		FROM transactions t JOIN categories c ON c.id = t.category_id
		WHERE t.user_id = ? AND ((c.role = 'interest' AND t.kind = 'income') OR (c.role = 'interest-given' AND t.kind = 'expense'))
		ORDER BY t.occurred_at DESC, t.id DESC`, uid)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	years := map[string]*interestYear{}
	for rows.Next() {
		var e interestEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Amount, &e.Note, &e.AccountID, &e.Given); err != nil {
			return out, err
		}
		y := e.At[:4]
		if years[y] == nil {
			years[y] = &interestYear{Year: y}
		}
		if e.Given {
			out.Given += e.Amount
			years[y].Given += e.Amount
		} else {
			out.Earned += e.Amount
			years[y].Earned += e.Amount
		}
		out.Entries = append(out.Entries, e)
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, y := range years {
		out.Years = append(out.Years, *y)
	}
	sort.Slice(out.Years, func(i, j int) bool { return out.Years[i].Year > out.Years[j].Year })
	out.ToGive = max(out.Earned-out.Given, 0)
	return out, nil
}

// GET /api/interest
func (a *api) getInterest(w http.ResponseWriter, r *http.Request, uid int64) {
	out, err := a.interestTotals(r.Context(), uid)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// POST /api/interest/give: record giving interest away, as an expense from
// an account in the "Interest given away" category.
func (a *api) giveInterest(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Amount     int64  `json:"amount"`
		AccountID  int64  `json:"accountId"`
		Note       string `json:"note"`
		OccurredAt string `json:"occurredAt"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Amount <= 0 || in.Amount > maxAmount {
		respondErr(w, errValidation("Enter how much you gave"))
		return
	}
	if !a.ownsAccount(r.Context(), uid, in.AccountID) {
		respondErr(w, errValidation("Pick the account it was paid from"))
		return
	}
	if _, err := time.Parse(localTimeLayout, in.OccurredAt); err != nil {
		respondErr(w, errValidation("Pick when you gave it"))
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	cat, err := ensureRoleCategory(ctx, tx, uid, "interest-given")
	if err != nil {
		serverError(w, err)
		return
	}
	note := truncateRunes(strings.TrimSpace(in.Note), 280)
	if note == "" {
		note = "Interest given away"
	}
	t := transaction{Kind: "expense", Amount: in.Amount, AccountID: in.AccountID, CategoryID: &cat, Note: note, OccurredAt: in.OccurredAt, Source: "manual"}
	if _, err := insertTx(ctx, tx, uid, t); err != nil {
		serverError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	out, err := a.interestTotals(ctx, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
