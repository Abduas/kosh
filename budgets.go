package main

import (
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type budget struct {
	ID         int64  `json:"id"`
	CategoryID *int64 `json:"categoryId"` // nil: overall monthly budget
	Amount     int64  `json:"amount"`
	Spent      int64  `json:"spent"`
}

// listBudgets returns each budget with what's been spent against it in month (YYYY-MM).
func (a *api) listBudgets(w http.ResponseWriter, r *http.Request, uid int64) {
	month, err := time.Parse("2006-01", r.URL.Query().Get("month"))
	if err != nil {
		month = time.Now()
	}
	from := time.Date(month.Year(), month.Month(), 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 1, 0)
	rows, err := a.db.QueryContext(r.Context(), `SELECT b.id, b.category_id, b.amount,
		COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.user_id = b.user_id AND t.kind = 'expense'
			AND (b.category_id IS NULL OR t.category_id = b.category_id)
			AND t.occurred_at >= ? AND t.occurred_at < ?), 0)
		FROM budgets b WHERE b.user_id = ? ORDER BY b.category_id IS NOT NULL, b.amount DESC`,
		from.Format(dateLayout), to.Format(dateLayout), uid)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	out := []budget{}
	for rows.Next() {
		var b budget
		if err := rows.Scan(&b.ID, &b.CategoryID, &b.Amount, &b.Spent); err != nil {
			serverError(w, err)
			return
		}
		out = append(out, b)
	}
	writeJSON(w, http.StatusOK, out)
}

// upsertBudget sets the monthly budget for a category, or the overall one.
func (a *api) upsertBudget(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		CategoryID *int64 `json:"categoryId"`
		Amount     int64  `json:"amount"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Amount <= 0 || in.Amount > maxAmount {
		writeError(w, http.StatusBadRequest, "Enter a budget amount")
		return
	}
	ctx := r.Context()
	if in.CategoryID != nil {
		var kind string
		err := a.db.QueryRowContext(ctx, `SELECT kind FROM categories WHERE id = ? AND user_id = ?`, *in.CategoryID, uid).Scan(&kind)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			serverError(w, err)
			return
		}
		if err != nil || kind != "expense" {
			writeError(w, http.StatusBadRequest, "Pick an expense category")
			return
		}
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	var id int64
	err = tx.QueryRow(`SELECT id FROM budgets WHERE user_id = ? AND category_id IS ?`, uid, in.CategoryID).Scan(&id)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = tx.Exec(`INSERT INTO budgets (user_id, category_id, amount) VALUES (?, ?, ?)`, uid, in.CategoryID, in.Amount)
	case err == nil:
		_, err = tx.Exec(`UPDATE budgets SET amount = ? WHERE id = ?`, in.Amount, id)
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) deleteBudget(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM budgets WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// exportCSV downloads every transaction as a spreadsheet-friendly CSV.
func (a *api) exportCSV(w http.ResponseWriter, r *http.Request, uid int64) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT t.occurred_at, t.kind, t.amount, a1.name, COALESCE(a2.name, ''),
		COALESCE(c.name, ''), COALESCE(p.name, ''), t.note
		FROM transactions t
		JOIN accounts a1 ON a1.id = t.account_id
		LEFT JOIN accounts a2 ON a2.id = t.to_account_id
		LEFT JOIN categories c ON c.id = t.category_id
		LEFT JOIN people p ON p.id = t.person_id
		WHERE t.user_id = ? ORDER BY t.occurred_at, t.id`, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="kosh-%s.csv"`, time.Now().Format(dateLayout)))
	cw := csv.NewWriter(w)
	cw.Write([]string{"Date", "Time", "Type", "Amount", "Account", "To account", "Category", "Person", "Note"})
	for rows.Next() {
		var at, kind, acc, toAcc, cat, per, note string
		var amount int64
		if err := rows.Scan(&at, &kind, &amount, &acc, &toAcc, &cat, &per, &note); err != nil {
			return
		}
		date, clock, _ := strings.Cut(at, "T")
		cw.Write([]string{date, clock, kind, fmt.Sprintf("%d.%02d", amount/100, amount%100), acc, toAcc, cat, per, csvSafe(note)})
	}
	cw.Flush()
}

// csvSafe stops spreadsheet apps from running a note as a formula.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}
