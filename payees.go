package main

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"
)

// payeeMemory is what Kosh remembers about a UPI ID from the last payment to it,
// so the next scan of the same QR fills in kind, account, category and person.
type payeeMemory struct {
	Known      bool   `json:"known"`
	Kind       string `json:"kind,omitempty"`
	AccountID  int64  `json:"accountId,omitempty"`
	CategoryID *int64 `json:"categoryId,omitempty"`
	PersonID   *int64 `json:"personId,omitempty"`
	Note       string `json:"note,omitempty"`
	Count      int    `json:"count"`
	LastAmount int64  `json:"lastAmount,omitempty"`
	LastAt     string `json:"lastAt,omitempty"`
}

// lookupPayee answers GET /api/payees?vpa=name@bank.
func (a *api) lookupPayee(w http.ResponseWriter, r *http.Request, uid int64) {
	vpa := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("vpa")))
	if vpa == "" || len(vpa) > 100 {
		writeError(w, http.StatusBadRequest, "vpa is required")
		return
	}
	var m payeeMemory
	err := a.db.QueryRowContext(r.Context(), `SELECT kind, account_id, category_id, person_id, note, amount, occurred_at,
			(SELECT COUNT(*) FROM transactions WHERE user_id = ? AND payee = ?)
		FROM transactions WHERE user_id = ? AND payee = ?
		ORDER BY occurred_at DESC, id DESC LIMIT 1`, uid, vpa, uid, vpa).
		Scan(&m.Kind, &m.AccountID, &m.CategoryID, &m.PersonID, &m.Note, &m.LastAmount, &m.LastAt, &m.Count)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusOK, payeeMemory{})
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	m.Known = true
	writeJSON(w, http.StatusOK, m)
}
