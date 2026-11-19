package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
)

// Erasing your data: starting over, say after an import that went wrong.
// Everything money-related goes; the account itself stays as on the day it
// was made (starter categories, a Cash account, first-run setup), with its
// password, Google sign-in and auto-capture link untouched.

func eraseUserData(ctx context.Context, tx *sql.Tx, uid int64) error {
	// Bank messages and transactions first: they point at accounts, people
	// and categories, some with ON DELETE RESTRICT.
	for _, q := range []string{
		`DELETE FROM captures WHERE user_id = ?`,
		`DELETE FROM transactions WHERE user_id = ?`,
		`DELETE FROM budgets WHERE user_id = ?`,
		`DELETE FROM people WHERE user_id = ?`,
		`DELETE FROM categories WHERE user_id = ?`,
		`DELETE FROM accounts WHERE user_id = ?`,
	} {
		if _, err := tx.ExecContext(ctx, q, uid); err != nil {
			return err
		}
	}
	if err := seedUser(tx, uid); err != nil {
		return err
	}
	// Show first-run setup again, and forget the account scans paid from
	// (it's gone). Looks such as theme and accent stay.
	var raw string
	if err := tx.QueryRowContext(ctx, `SELECT prefs FROM users WHERE id = ?`, uid).Scan(&raw); err != nil {
		return err
	}
	prefs := map[string]any{}
	json.Unmarshal([]byte(raw), &prefs)
	delete(prefs, "onboarded")
	delete(prefs, "upiAccountId")
	b, _ := json.Marshal(prefs)
	_, err := tx.ExecContext(ctx, `UPDATE users SET prefs = ? WHERE id = ?`, string(b), uid)
	return err
}

// eraseMe empties the signed-in account. The username must be typed to confirm.
func (a *api) eraseMe(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Username string `json:"username"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	var username string
	if err := tx.QueryRow(`SELECT username FROM users WHERE id = ?`, uid).Scan(&username); err != nil {
		serverError(w, err)
		return
	}
	if !strings.EqualFold(strings.TrimPrefix(strings.TrimSpace(in.Username), "@"), username) {
		writeError(w, http.StatusBadRequest, "Type your username to confirm")
		return
	}
	if err := eraseUserData(r.Context(), tx, uid); err != nil {
		serverError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.respondMe(w, r, uid)
}
