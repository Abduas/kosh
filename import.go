package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Import: bring your history from another app. The app sends the file twice:
// once to preview what Kosh read and how it would file it, then again with
// the choices made on that preview.
//
// Each imported transaction gets source "import" and a ref made from its
// contents, so importing the same file again adds nothing. Transactions that
// look like ones already in Kosh (same kind and amount within a day) are
// skipped unless asked for: someone switching apps usually recorded the last
// few weeks in both.

type importRequest struct {
	CSV      string `json:"csv"`
	Timezone string `json:"timezone"`
	// The account for rows that don't name one.
	AccountID int64 `json:"accountId"`
	// Account names in the file → an account ID, or 0 to create it.
	Accounts map[string]int64 `json:"accounts"`
	// "expense:Food" → a category ID, or 0 to create it with Icon.
	Categories map[string]importCategoryChoice `json:"categories"`
	// Lower each existing account's opening balance by what the import adds,
	// so balances today stay what they are.
	KeepBalances   bool `json:"keepBalances"`
	IncludeSimilar bool `json:"includeSimilar"`
}

type importCategoryChoice struct {
	ID   int64  `json:"id"`
	Icon string `json:"icon"`
}

type importPreviewRow struct {
	At     string `json:"at"`
	Kind   string `json:"kind"`
	Amount int64  `json:"amount"`
	Note   string `json:"note"`
}

type importPreviewCategory struct {
	Key   string `json:"key"`
	Kind  string `json:"kind"`
	Name  string `json:"name"`
	Count int    `json:"count"`
	Match *int64 `json:"match"`
}

type importPreviewAccount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
	Match *int64 `json:"match"`
}

type importPreview struct {
	Format       string                  `json:"format"`
	Count        int                     `json:"count"`
	New          int                     `json:"new"`
	Imported     int                     `json:"imported"`
	Similar      int                     `json:"similar"`
	SimilarRows  []importPreviewRow      `json:"similarRows"`
	From         string                  `json:"from"`
	To           string                  `json:"to"`
	Totals       map[string]int64        `json:"totals"`
	Categories   []importPreviewCategory `json:"categories"`
	Accounts     []importPreviewAccount  `json:"accounts"`
	NeedsAccount bool                    `json:"needsAccount"`
	NewPeople    []string                `json:"newPeople"`
	Problems     []importProblem         `json:"problems"`
	ProblemCount int                     `json:"problemCount"`
}

type importResult struct {
	Imported          int `json:"imported"`
	SkippedImported   int `json:"skippedImported"`
	SkippedSimilar    int `json:"skippedSimilar"`
	CreatedCategories int `json:"createdCategories"`
	CreatedAccounts   int `json:"createdAccounts"`
	CreatedPeople     int `json:"createdPeople"`
}

const maxImportBytes = 12 << 20

func (a *api) readImport(w http.ResponseWriter, r *http.Request) (importRequest, parsedImport, bool) {
	var in importRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxImportBytes)).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "That file is too big, or it didn't upload. Files up to 10 MB work.")
		return in, parsedImport{}, false
	}
	loc, err := time.LoadLocation(in.Timezone)
	if in.Timezone == "" || err != nil {
		loc, _ = time.LoadLocation("Asia/Kolkata")
	}
	p, err := parseImportCSV(in.CSV, loc)
	if err != nil {
		respondErr(w, err)
		return in, p, false
	}
	if len(p.Rows) == 0 {
		writeError(w, http.StatusBadRequest, "Found no transactions in this file.")
		return in, p, false
	}
	return in, p, true
}

// rowStatus says, for each row, whether it's new, was imported before, or
// looks like a transaction already in Kosh.
const (
	rowNew = iota
	rowImported
	rowSimilar
)

func importRef(rows []importRow) []string {
	refs := make([]string, len(rows))
	seen := map[string]int{}
	for i, r := range rows {
		key := strings.Join([]string{r.Kind, fmt.Sprint(r.Amount), r.At, r.Note, strings.ToLower(r.Category), strings.ToLower(r.Account), strings.ToLower(r.ToAccount), strings.ToLower(r.Person)}, "\x1f")
		// Two identical teas on the same minute are two teas.
		n := seen[key]
		seen[key] = n + 1
		sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x1f%d", key, n)))
		refs[i] = "csv:" + hex.EncodeToString(sum[:8])
	}
	return refs
}

func (a *api) classifyRows(ctx context.Context, uid int64, rows []importRow, refs []string) ([]int, error) {
	status := make([]int, len(rows))
	from, _ := time.Parse(localTimeLayout, rows[0].At)
	to, _ := time.Parse(localTimeLayout, rows[len(rows)-1].At)
	lo := from.AddDate(0, 0, -2).Format(localTimeLayout)
	hi := to.AddDate(0, 0, 2).Format(localTimeLayout)

	imported := map[string]bool{}
	type existing struct {
		day  time.Time
		used bool
	}
	others := map[string][]*existing{} // kind|amount
	q, err := a.db.QueryContext(ctx, `SELECT kind, amount, occurred_at, source, ref FROM transactions WHERE user_id = ? AND occurred_at BETWEEN ? AND ?`, uid, lo, hi)
	if err != nil {
		return nil, err
	}
	defer q.Close()
	for q.Next() {
		var kind, at, source, ref string
		var amount int64
		if err := q.Scan(&kind, &amount, &at, &source, &ref); err != nil {
			return nil, err
		}
		if source == "import" && ref != "" {
			imported[ref] = true
			continue
		}
		day, _ := time.Parse("2006-01-02", at[:10])
		k := fmt.Sprintf("%s|%d", kind, amount)
		others[k] = append(others[k], &existing{day: day})
	}
	if err := q.Err(); err != nil {
		return nil, err
	}
	for i, r := range rows {
		if imported[refs[i]] {
			status[i] = rowImported
			continue
		}
		day, _ := time.Parse("2006-01-02", r.At[:10])
		for _, e := range others[fmt.Sprintf("%s|%d", r.Kind, r.Amount)] {
			if !e.used && absDuration(day.Sub(e.day)) <= 24*time.Hour {
				e.used = true
				status[i] = rowSimilar
				break
			}
		}
	}
	return status, nil
}

func absDuration(d time.Duration) time.Duration {
	if d < 0 {
		return -d
	}
	return d
}

type nameID struct {
	id   int64
	kind string
	name string
}

func (a *api) userCategories(ctx context.Context, uid int64) ([]nameID, error) {
	return queryNames(ctx, a.db, `SELECT id, kind, name FROM categories WHERE user_id = ? AND archived = 0 ORDER BY sort_order, id`, uid)
}

func queryNames(ctx context.Context, db *sql.DB, query string, args ...any) ([]nameID, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []nameID
	for rows.Next() {
		var n nameID
		if err := rows.Scan(&n.id, &n.kind, &n.name); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// suggestCategory finds the user's category an imported name most likely
// means: the same name, a singular or plural, or a word in a longer name
// ("Food" → "Food & Dining", "Utilities" → "Bills & Utilities",
// "Healthcare" → "Health").
func suggestCategory(kind, name string, cats []nameID) *int64 {
	n := headerKey(name)
	if n == "" {
		return nil
	}
	same := func(a, b string) bool {
		return a == b || strings.TrimSuffix(a, "s") == strings.TrimSuffix(b, "s")
	}
	for _, c := range cats {
		if c.kind == kind && same(headerKey(c.name), n) {
			return &c.id
		}
	}
	if strings.Contains(n, " ") {
		return nil
	}
	for _, c := range cats {
		if c.kind != kind {
			continue
		}
		for _, w := range strings.Fields(headerKey(c.name)) {
			if same(w, n) || (len(w) >= 4 && len(n) >= 4 && (strings.HasPrefix(n, w) || strings.HasPrefix(w, n))) {
				return &c.id
			}
		}
	}
	return nil
}

func categoryKey(kind, name string) string { return kind + ":" + name }

func (a *api) previewImport(w http.ResponseWriter, r *http.Request, uid int64) {
	_, p, ok := a.readImport(w, r)
	if !ok {
		return
	}
	refs := importRef(p.Rows)
	status, err := a.classifyRows(r.Context(), uid, p.Rows, refs)
	if err != nil {
		serverError(w, err)
		return
	}
	cats, err := a.userCategories(r.Context(), uid)
	if err != nil {
		serverError(w, err)
		return
	}
	accts, err := queryNames(r.Context(), a.db, `SELECT id, kind, name FROM accounts WHERE user_id = ? ORDER BY archived, sort_order, id`, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	people, err := queryNames(r.Context(), a.db, `SELECT id, '', name FROM people WHERE user_id = ?`, uid)
	if err != nil {
		serverError(w, err)
		return
	}

	out := importPreview{
		Format:      p.Format,
		Count:       len(p.Rows),
		From:        p.Rows[0].At,
		To:          p.Rows[len(p.Rows)-1].At,
		Totals:      map[string]int64{},
		Problems:    p.Problems,
		SimilarRows: []importPreviewRow{},
		Categories:  []importPreviewCategory{},
		Accounts:    []importPreviewAccount{},
		NewPeople:   []string{},
	}
	if out.Problems == nil {
		out.Problems = []importProblem{}
	}
	out.ProblemCount = len(p.Problems)
	if len(out.Problems) > 50 {
		out.Problems = out.Problems[:50]
	}
	catIndex := map[string]int{}
	acctIndex := map[string]int{}
	newPeople := map[string]bool{}
	addAccount := func(name string) {
		if name == "" {
			out.NeedsAccount = true
			return
		}
		if i, ok := acctIndex[name]; ok {
			out.Accounts[i].Count++
			return
		}
		acctIndex[name] = len(out.Accounts)
		pa := importPreviewAccount{Name: name, Count: 1}
		for _, x := range accts {
			if strings.EqualFold(x.name, name) {
				pa.Match = &x.id
				break
			}
		}
		out.Accounts = append(out.Accounts, pa)
	}
	for i, row := range p.Rows {
		switch status[i] {
		case rowImported:
			out.Imported++
			continue
		case rowSimilar:
			out.Similar++
			if len(out.SimilarRows) < 30 {
				out.SimilarRows = append(out.SimilarRows, importPreviewRow{row.At, row.Kind, row.Amount, row.Note})
			}
		default:
			out.New++
		}
		out.Totals[row.Kind] += row.Amount
		addAccount(row.Account)
		if row.Kind == "transfer" {
			addAccount(row.ToAccount)
		}
		if row.Category != "" {
			key := categoryKey(row.Kind, row.Category)
			if j, ok := catIndex[key]; ok {
				out.Categories[j].Count++
			} else {
				catIndex[key] = len(out.Categories)
				out.Categories = append(out.Categories, importPreviewCategory{Key: key, Kind: row.Kind, Name: row.Category, Count: 1, Match: suggestCategory(row.Kind, row.Category, cats)})
			}
		}
		if row.Person != "" && !newPeople[strings.ToLower(row.Person)] {
			known := false
			for _, x := range people {
				if strings.EqualFold(x.name, row.Person) {
					known = true
					break
				}
			}
			if !known {
				newPeople[strings.ToLower(row.Person)] = true
				out.NewPeople = append(out.NewPeople, row.Person)
			}
		}
	}
	sort.SliceStable(out.Categories, func(i, j int) bool {
		if out.Categories[i].Kind != out.Categories[j].Kind {
			return out.Categories[i].Kind == "expense"
		}
		return out.Categories[i].Count > out.Categories[j].Count
	})
	writeJSON(w, http.StatusOK, out)
}

var importColors = []string{"#7C5CFF", "#3B82F6", "#0EA5E9", "#14B8A6", "#22C55E", "#84CC16", "#EAB308", "#F97316", "#EF4444", "#EC4899", "#A855F7", "#64748B"}

func guessAccountKind(name string) (kind, icon, color string) {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "cash"):
		return "cash", "💵", "#22C55E"
	case strings.Contains(n, "card"):
		return "card", "💳", "#64748B"
	case strings.Contains(n, "wallet") || strings.Contains(n, "paytm") || strings.Contains(n, "pay"):
		return "wallet", "👛", "#0EA5E9"
	case strings.Contains(n, "saving"):
		return "savings", "🐷", "#EC4899"
	case strings.Contains(n, "invest") || strings.Contains(n, "stock") || strings.Contains(n, "mutual"):
		return "investment", "📈", "#8B5CF6"
	}
	return "bank", "🏦", "#3B82F6"
}

func (a *api) commitImport(w http.ResponseWriter, r *http.Request, uid int64) {
	in, p, ok := a.readImport(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	refs := importRef(p.Rows)
	status, err := a.classifyRows(ctx, uid, p.Rows, refs)
	if err != nil {
		serverError(w, err)
		return
	}

	cats, err := a.userCategories(ctx, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()

	var res importResult
	owned := func(table string, id int64, kind string) bool {
		var n int
		q := `SELECT COUNT(*) FROM ` + table + ` WHERE id = ? AND user_id = ?`
		args := []any{id, uid}
		if kind != "" {
			q += ` AND kind = ?`
			args = append(args, kind)
		}
		tx.QueryRowContext(ctx, q, args...).Scan(&n)
		return n == 1
	}

	accountIDs := map[string]int64{}
	created := map[int64]bool{} // accounts made by this import
	account := func(name string) (int64, error) {
		if name == "" {
			if in.AccountID == 0 || !owned("accounts", in.AccountID, "") {
				return 0, errValidation("Pick the account to put these transactions in")
			}
			return in.AccountID, nil
		}
		if id, ok := accountIDs[name]; ok {
			return id, nil
		}
		id, chosen := in.Accounts[name]
		if !chosen {
			// Not asked about: an account with that name, if there is one.
			tx.QueryRowContext(ctx, `SELECT id FROM accounts WHERE user_id = ? AND name = ? COLLATE NOCASE ORDER BY archived, id LIMIT 1`, uid, name).Scan(&id)
		}
		if id != 0 {
			if !owned("accounts", id, "") {
				return 0, errValidation("Pick an account for " + name)
			}
			accountIDs[name] = id
			return id, nil
		}
		kind, icon, color := guessAccountKind(name)
		x, err := tx.ExecContext(ctx, `INSERT INTO accounts (user_id, name, kind, color, icon, sort_order)
			VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts WHERE user_id = ?))`, uid, name, kind, color, icon, uid)
		if err != nil {
			return 0, err
		}
		id, _ = x.LastInsertId()
		accountIDs[name] = id
		created[id] = true
		res.CreatedAccounts++
		return id, nil
	}

	categoryIDs := map[string]int64{}
	category := func(kind, name string) (*int64, error) {
		if name == "" {
			return nil, nil
		}
		key := categoryKey(kind, name)
		if id, ok := categoryIDs[key]; ok {
			return &id, nil
		}
		choice, chosen := in.Categories[key]
		if !chosen {
			// Not asked about: the category the preview suggested.
			if m := suggestCategory(kind, name, cats); m != nil {
				choice.ID = *m
			}
		}
		if choice.ID != 0 {
			if !owned("categories", choice.ID, kind) {
				return nil, errValidation("Pick a category for " + name)
			}
			categoryIDs[key] = choice.ID
			return &choice.ID, nil
		}
		// Created once even when the file spells it two ways.
		var id int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM categories WHERE user_id = ? AND kind = ? AND name = ? COLLATE NOCASE AND archived = 0`, uid, kind, name).Scan(&id)
		if err == sql.ErrNoRows {
			icon := strings.TrimSpace(choice.Icon)
			if icon == "" || len(icon) > 32 {
				icon = "🏷️"
			}
			x, err := tx.ExecContext(ctx, `INSERT INTO categories (user_id, kind, name, icon, color, sort_order)
				VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE user_id = ? AND kind = ?))`,
				uid, kind, name, icon, importColors[res.CreatedCategories%len(importColors)], uid, kind)
			if err != nil {
				return nil, err
			}
			id, _ = x.LastInsertId()
			res.CreatedCategories++
		} else if err != nil {
			return nil, err
		}
		categoryIDs[key] = id
		return &id, nil
	}

	personIDs := map[string]int64{}
	person := func(name string) (*int64, error) {
		if name == "" {
			return nil, nil
		}
		key := strings.ToLower(name)
		if id, ok := personIDs[key]; ok {
			return &id, nil
		}
		var id int64
		err := tx.QueryRowContext(ctx, `SELECT id FROM people WHERE user_id = ? AND name = ? COLLATE NOCASE ORDER BY archived, id LIMIT 1`, uid, name).Scan(&id)
		if err == sql.ErrNoRows {
			x, err := tx.ExecContext(ctx, `INSERT INTO people (user_id, name, color) VALUES (?, ?, ?)`, uid, name, importColors[(res.CreatedPeople+5)%len(importColors)])
			if err != nil {
				return nil, err
			}
			id, _ = x.LastInsertId()
			res.CreatedPeople++
		} else if err != nil {
			return nil, err
		}
		personIDs[key] = id
		return &id, nil
	}

	delta := map[int64]int64{} // what the import adds to each account's balance
	for i, row := range p.Rows {
		switch status[i] {
		case rowImported:
			res.SkippedImported++
			continue
		case rowSimilar:
			if !in.IncludeSimilar {
				res.SkippedSimilar++
				continue
			}
		}
		t := transaction{Kind: row.Kind, Amount: row.Amount, Note: row.Note, OccurredAt: row.At, Source: "import", Ref: refs[i]}
		if t.AccountID, err = account(row.Account); err != nil {
			respondErr(w, err)
			return
		}
		switch row.Kind {
		case "transfer":
			to, err := account(row.ToAccount)
			if err != nil {
				respondErr(w, err)
				return
			}
			if to == t.AccountID {
				continue
			}
			t.ToAccountID = &to
			delta[t.AccountID] -= t.Amount
			delta[to] += t.Amount
		case "expense", "income":
			if t.CategoryID, err = category(row.Kind, row.Category); err != nil {
				respondErr(w, err)
				return
			}
		default:
			if t.PersonID, err = person(row.Person); err != nil {
				respondErr(w, err)
				return
			}
		}
		switch row.Kind {
		case "expense", "lend", "repay":
			delta[t.AccountID] -= t.Amount
		case "income", "borrow", "collect":
			delta[t.AccountID] += t.Amount
		}
		if _, err := insertTx(ctx, tx, uid, t); err != nil {
			serverError(w, err)
			return
		}
		res.Imported++
	}
	if in.KeepBalances {
		for id, d := range delta {
			if created[id] || d == 0 {
				continue
			}
			if _, err := tx.ExecContext(ctx, `UPDATE accounts SET opening_balance = opening_balance - ? WHERE id = ? AND user_id = ?`, d, id, uid); err != nil {
				serverError(w, err)
				return
			}
		}
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
