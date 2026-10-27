package main

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// maxAmount is ₹1 lakh crore in paise, far beyond any personal transaction.
const maxAmount = 1_000_000_000_000_000

const localTimeLayout = "2006-01-02T15:04"

type transaction struct {
	ID          int64  `json:"id"`
	Kind        string `json:"kind"`
	Amount      int64  `json:"amount"`
	AccountID   int64  `json:"accountId"`
	ToAccountID *int64 `json:"toAccountId"`
	CategoryID  *int64 `json:"categoryId"`
	PersonID    *int64 `json:"personId"`
	Note        string `json:"note"`
	OccurredAt  string `json:"occurredAt"`
	Source      string `json:"source"`
	Ref         string `json:"ref"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

var personKinds = map[string]bool{"lend": true, "borrow": true, "collect": true, "repay": true}

const txColumns = `t.id, t.kind, t.amount, t.account_id, t.to_account_id, t.category_id, t.person_id, t.note, t.occurred_at, t.source, t.ref, t.created_at, t.updated_at`

func scanTx(s interface{ Scan(...any) error }) (transaction, error) {
	var t transaction
	err := s.Scan(&t.ID, &t.Kind, &t.Amount, &t.AccountID, &t.ToAccountID, &t.CategoryID, &t.PersonID, &t.Note, &t.OccurredAt, &t.Source, &t.Ref, &t.CreatedAt, &t.UpdatedAt)
	return t, err
}

type txInput struct {
	Kind        *string `json:"kind"`
	Amount      *int64  `json:"amount"`
	AccountID   *int64  `json:"accountId"`
	ToAccountID *int64  `json:"toAccountId"`
	CategoryID  *int64  `json:"categoryId"`
	PersonID    *int64  `json:"personId"`
	Note        *string `json:"note"`
	OccurredAt  *string `json:"occurredAt"`
}

// apply merges the input into t. For fields that depend on kind (toAccountId,
// categoryId, personId) an explicit null in the input clears them, so the
// frontend always sends all three.
func (in txInput) apply(t *transaction) {
	if in.Kind != nil {
		t.Kind = *in.Kind
	}
	if in.Amount != nil {
		t.Amount = *in.Amount
	}
	if in.AccountID != nil {
		t.AccountID = *in.AccountID
	}
	t.ToAccountID = in.ToAccountID
	t.CategoryID = in.CategoryID
	t.PersonID = in.PersonID
	if in.Note != nil {
		t.Note = strings.TrimSpace(*in.Note)
	}
	if in.OccurredAt != nil {
		t.OccurredAt = *in.OccurredAt
	}
}

func normalizeLocalTime(s string) (string, error) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{localTimeLayout, "2006-01-02T15:04:05", "2006-01-02T15:04:05.000", "2006-01-02"} {
		if tm, err := time.Parse(layout, s); err == nil {
			if layout == "2006-01-02" {
				tm = tm.Add(12 * time.Hour)
			}
			if tm.Year() < 1970 || tm.Year() > 2200 {
				break
			}
			return tm.Format(localTimeLayout), nil
		}
	}
	return "", errValidation("Pick a valid date")
}

// validate checks the transaction's shape and that everything it points at
// belongs to uid.
func (a *api) validateTx(ctx context.Context, uid int64, t *transaction) error {
	switch t.Kind {
	case "expense", "income", "transfer", "lend", "borrow", "collect", "repay":
	default:
		return errValidation("Pick a transaction type")
	}
	if t.Amount <= 0 {
		return errValidation("Enter an amount")
	}
	if t.Amount > maxAmount {
		return errValidation("Amount is too large")
	}
	if utf8.RuneCountInString(t.Note) > 280 {
		return errValidation("Note is too long")
	}
	var err error
	if t.OccurredAt, err = normalizeLocalTime(t.OccurredAt); err != nil {
		return err
	}
	if ok, err := a.owned(ctx, "accounts", t.AccountID, uid); err != nil {
		return err
	} else if !ok {
		return errValidation("Pick an account")
	}

	// Drop fields that don't belong to this kind, then require the ones that do.
	if t.Kind != "transfer" {
		t.ToAccountID = nil
	}
	if t.Kind != "expense" && t.Kind != "income" {
		t.CategoryID = nil
	}
	if !personKinds[t.Kind] {
		t.PersonID = nil
	}

	if t.Kind == "transfer" {
		if t.ToAccountID == nil {
			return errValidation("Pick where the money goes")
		}
		if *t.ToAccountID == t.AccountID {
			return errValidation("Pick two different accounts")
		}
		if ok, err := a.owned(ctx, "accounts", *t.ToAccountID, uid); err != nil {
			return err
		} else if !ok {
			return errValidation("Pick where the money goes")
		}
	}
	if t.CategoryID != nil {
		var kind string
		err := a.db.QueryRowContext(ctx, `SELECT kind FROM categories WHERE id = ? AND user_id = ?`, *t.CategoryID, uid).Scan(&kind)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && kind != t.Kind) {
			return errValidation("Pick a category")
		} else if err != nil {
			return err
		}
	}
	if personKinds[t.Kind] {
		if t.PersonID == nil {
			return errValidation("Pick a person")
		}
		if ok, err := a.owned(ctx, "people", *t.PersonID, uid); err != nil {
			return err
		} else if !ok {
			return errValidation("Pick a person")
		}
	}
	return nil
}

func (a *api) getTx(ctx context.Context, uid, id int64) (transaction, error) {
	return scanTx(a.db.QueryRowContext(ctx, `SELECT `+txColumns+` FROM transactions t WHERE t.id = ? AND t.user_id = ?`, id, uid))
}

func (a *api) createTransaction(w http.ResponseWriter, r *http.Request, uid int64) {
	var in txInput
	if !readJSON(w, r, &in) {
		return
	}
	var t transaction
	in.apply(&t)
	if err := a.validateTx(r.Context(), uid, &t); err != nil {
		respondErr(w, err)
		return
	}
	res, err := a.db.ExecContext(r.Context(), `INSERT INTO transactions (user_id, kind, amount, account_id, to_account_id, category_id, person_id, note, occurred_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uid, t.Kind, t.Amount, t.AccountID, t.ToAccountID, t.CategoryID, t.PersonID, t.Note, t.OccurredAt)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	created, err := a.getTx(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

func (a *api) updateTransaction(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in txInput
	if !readJSON(w, r, &in) {
		return
	}
	t, err := a.getTx(r.Context(), uid, id)
	if err != nil {
		respondErr(w, err)
		return
	}
	in.apply(&t)
	if err := a.validateTx(r.Context(), uid, &t); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE transactions SET kind = ?, amount = ?, account_id = ?, to_account_id = ?, category_id = ?,
		person_id = ?, note = ?, occurred_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?`,
		t.Kind, t.Amount, t.AccountID, t.ToAccountID, t.CategoryID, t.PersonID, t.Note, t.OccurredAt, id, uid); err != nil {
		serverError(w, err)
		return
	}
	updated, err := a.getTx(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (a *api) deleteTransaction(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM transactions WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listTransactions returns newest first, filtered, a page at a time.
//
//	from, to       YYYY-MM-DD, inclusive
//	account        matches either side of a transfer
//	category, person
//	kind           comma-separated kinds
//	q              text in the note, category, person or account, or an exact amount
//	cursor, limit  paging; pass back nextCursor for the next page
func (a *api) listTransactions(w http.ResponseWriter, r *http.Request, uid int64) {
	q := r.URL.Query()
	where := []string{"t.user_id = ?"}
	args := []any{uid}

	if from := q.Get("from"); from != "" {
		where = append(where, "t.occurred_at >= ?")
		args = append(args, from)
	}
	if to := q.Get("to"); to != "" {
		where = append(where, "t.occurred_at < ?")
		args = append(args, to+"T99") // sorts after every time on that day
	}
	if v, err := strconv.ParseInt(q.Get("account"), 10, 64); err == nil {
		where = append(where, "(t.account_id = ? OR t.to_account_id = ?)")
		args = append(args, v, v)
	}
	if v, err := strconv.ParseInt(q.Get("category"), 10, 64); err == nil {
		where = append(where, "t.category_id = ?")
		args = append(args, v)
	}
	if v, err := strconv.ParseInt(q.Get("person"), 10, 64); err == nil {
		where = append(where, "t.person_id = ?")
		args = append(args, v)
	}
	if kinds := q.Get("kind"); kinds != "" {
		list := strings.Split(kinds, ",")
		where = append(where, "t.kind IN (?"+strings.Repeat(", ?", len(list)-1)+")")
		for _, k := range list {
			args = append(args, k)
		}
	}
	if text := strings.TrimSpace(q.Get("q")); text != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(text) + "%"
		cond := `(t.note LIKE ? ESCAPE '\' OR c.name LIKE ? ESCAPE '\' OR p.name LIKE ? ESCAPE '\' OR a1.name LIKE ? ESCAPE '\' OR a2.name LIKE ? ESCAPE '\'`
		args = append(args, like, like, like, like, like)
		if f, err := strconv.ParseFloat(strings.ReplaceAll(text, ",", ""), 64); err == nil && f > 0 {
			cond += " OR t.amount = ?"
			args = append(args, int64(math.Round(f*100)))
		}
		where = append(where, cond+")")
	}
	if cursor := q.Get("cursor"); cursor != "" {
		at, idStr, found := strings.Cut(cursor, "|")
		id, err := strconv.ParseInt(idStr, 10, 64)
		if !found || err != nil {
			writeError(w, http.StatusBadRequest, "bad cursor")
			return
		}
		where = append(where, "(t.occurred_at < ? OR (t.occurred_at = ? AND t.id < ?))")
		args = append(args, at, at, id)
	}
	limit := 60
	if v, err := strconv.Atoi(q.Get("limit")); err == nil && v > 0 && v <= 500 {
		limit = v
	}

	query := `SELECT ` + txColumns + ` FROM transactions t
		LEFT JOIN categories c ON c.id = t.category_id
		LEFT JOIN people p ON p.id = t.person_id
		JOIN accounts a1 ON a1.id = t.account_id
		LEFT JOIN accounts a2 ON a2.id = t.to_account_id
		WHERE ` + strings.Join(where, " AND ") + `
		ORDER BY t.occurred_at DESC, t.id DESC LIMIT ?`
	rows, err := a.db.QueryContext(r.Context(), query, append(args, limit+1)...)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	items := []transaction{}
	for rows.Next() {
		t, err := scanTx(rows)
		if err != nil {
			serverError(w, err)
			return
		}
		items = append(items, t)
	}
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}
	var next *string
	if len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		c := last.OccurredAt + "|" + strconv.FormatInt(last.ID, 10)
		next = &c
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "nextCursor": next})
}
