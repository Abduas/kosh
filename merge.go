package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"sync"
	"time"
)

// Merging two Kosh accounts into one. It happens when someone signed up twice
// (once with a password, once with Google) and connects that Google account
// in Settings while signed in to the other one. Having just signed in to
// both, they're offered to bring the Google one's money over; the Google
// account then signs in here.
//
// The offer lives in memory for ten minutes: a restart only means connecting
// Google again.

const mergeTTL = 10 * time.Minute

type pendingMerge struct {
	into, from int64
	expires    time.Time
}

type mergeOffers struct {
	mu     sync.Mutex
	offers map[string]pendingMerge
}

func newMergeOffers() *mergeOffers { return &mergeOffers{offers: map[string]pendingMerge{}} }

func (m *mergeOffers) add(into, from int64) string {
	buf := make([]byte, 24)
	rand.Read(buf)
	token := base64.RawURLEncoding.EncodeToString(buf)
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for k, v := range m.offers {
		if now.After(v.expires) {
			delete(m.offers, k)
		}
	}
	m.offers[token] = pendingMerge{into: into, from: from, expires: now.Add(mergeTTL)}
	return token
}

// get returns the offer for token, only to the account it was made for.
func (m *mergeOffers) get(token string, uid int64) (pendingMerge, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.offers[token]
	if !ok || p.into != uid || time.Now().After(p.expires) {
		return pendingMerge{}, false
	}
	return p, true
}

func (m *mergeOffers) remove(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.offers, token)
}

type mergeSummary struct {
	Name         string `json:"name"`
	Username     string `json:"username"`
	GoogleEmail  string `json:"googleEmail"`
	Transactions int    `json:"transactions"`
	Accounts     int    `json:"accounts"`
	People       int    `json:"people"`
}

func (a *api) getMerge(w http.ResponseWriter, r *http.Request, uid int64) {
	p, ok := a.merges.get(r.PathValue("token"), uid)
	if !ok {
		writeError(w, http.StatusNotFound, "That took too long. Connect Google again.")
		return
	}
	var s mergeSummary
	err := a.db.QueryRowContext(r.Context(), `SELECT name, username,
		COALESCE((SELECT email FROM identities WHERE user_id = u.id AND provider = 'google'), ''),
		(SELECT COUNT(*) FROM transactions WHERE user_id = u.id),
		(SELECT COUNT(*) FROM accounts WHERE user_id = u.id),
		(SELECT COUNT(*) FROM people WHERE user_id = u.id)
		FROM users u WHERE id = ?`, p.from).Scan(&s.Name, &s.Username, &s.GoogleEmail, &s.Transactions, &s.Accounts, &s.People)
	if err != nil {
		respondErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (a *api) doMerge(w http.ResponseWriter, r *http.Request, uid int64) {
	token := r.PathValue("token")
	p, ok := a.merges.get(token, uid)
	if !ok {
		writeError(w, http.StatusNotFound, "That took too long. Connect Google again.")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	if err := mergeUsers(r.Context(), tx, p.from, p.into); err != nil {
		respondErr(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.merges.remove(token)
	a.respondMe(w, r, uid)
}

// mergeUsers moves everything src has into dst, then removes src.
// Accounts, categories and people with the same name become one; dst's
// opening balances, settings and username stay.
func mergeUsers(ctx context.Context, tx *sql.Tx, src, dst int64) error {
	if src == dst {
		return errors.New("merge into itself")
	}
	exec := func(q string, args ...any) error {
		_, err := tx.ExecContext(ctx, q, args...)
		return err
	}
	list := func(q string, args ...any) ([]nameID, error) {
		rows, err := tx.QueryContext(ctx, q, args...)
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
	// match finds dst's row with the same name (and kind), or 0.
	match := func(table string, n nameID, withKind bool) (int64, error) {
		q := `SELECT id FROM ` + table + ` WHERE user_id = ? AND name = ? COLLATE NOCASE AND archived = 0`
		args := []any{dst, n.name}
		if withKind {
			q += ` AND kind = ?`
			args = append(args, n.kind)
		}
		var id int64
		err := tx.QueryRowContext(ctx, q+` ORDER BY id LIMIT 1`, args...).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return id, err
	}

	// Accounts.
	accts, err := list(`SELECT id, kind, name FROM accounts WHERE user_id = ?`, src)
	if err != nil {
		return err
	}
	for _, x := range accts {
		target, err := match("accounts", x, true)
		if err != nil {
			return err
		}
		if target == 0 {
			if err := exec(`UPDATE accounts SET user_id = ?, sort_order = sort_order + 1000 WHERE id = ?`, dst, x.id); err != nil {
				return err
			}
			continue
		}
		for _, q := range []string{
			`UPDATE transactions SET account_id = ? WHERE account_id = ?`,
			`UPDATE transactions SET to_account_id = ? WHERE to_account_id = ?`,
			`UPDATE captures SET account_id = ? WHERE account_id = ?`,
		} {
			if err := exec(q, target, x.id); err != nil {
				return err
			}
		}
		if err := exec(`DELETE FROM accounts WHERE id = ?`, x.id); err != nil {
			return err
		}
	}

	// Categories, with their budgets.
	cats, err := list(`SELECT id, kind, name FROM categories WHERE user_id = ?`, src)
	if err != nil {
		return err
	}
	for _, x := range cats {
		target, err := match("categories", x, true)
		if err != nil {
			return err
		}
		if target == 0 {
			if err := exec(`UPDATE categories SET user_id = ? WHERE id = ?`, dst, x.id); err != nil {
				return err
			}
			continue
		}
		if err := exec(`UPDATE transactions SET category_id = ? WHERE category_id = ?`, target, x.id); err != nil {
			return err
		}
		if err := exec(`UPDATE budgets SET category_id = ? WHERE category_id = ?`, target, x.id); err != nil {
			return err
		}
		if err := exec(`DELETE FROM categories WHERE id = ?`, x.id); err != nil {
			return err
		}
	}
	// dst's own budget wins where both set one.
	if err := exec(`DELETE FROM budgets WHERE user_id = ? AND IFNULL(category_id, 0) IN (SELECT IFNULL(category_id, 0) FROM budgets WHERE user_id = ?)`, src, dst); err != nil {
		return err
	}
	if err := exec(`UPDATE budgets SET user_id = ? WHERE user_id = ?`, dst, src); err != nil {
		return err
	}

	// People.
	people, err := list(`SELECT id, '', name FROM people WHERE user_id = ?`, src)
	if err != nil {
		return err
	}
	for _, x := range people {
		target, err := match("people", x, false)
		if err != nil {
			return err
		}
		if target == 0 {
			if err := exec(`UPDATE people SET user_id = ? WHERE id = ?`, dst, x.id); err != nil {
				return err
			}
			continue
		}
		if err := exec(`UPDATE transactions SET person_id = ? WHERE person_id = ?`, target, x.id); err != nil {
			return err
		}
		if err := exec(`DELETE FROM people WHERE id = ?`, x.id); err != nil {
			return err
		}
	}

	if err := exec(`UPDATE transactions SET user_id = ? WHERE user_id = ?`, dst, src); err != nil {
		return err
	}

	// Vehicles, their logs and papers move as they are.
	for _, q := range []string{
		`UPDATE vehicles SET user_id = ?, sort_order = sort_order + 1000 WHERE user_id = ?`,
		`UPDATE vehicle_logs SET user_id = ? WHERE user_id = ?`,
		`UPDATE vehicle_documents SET user_id = ? WHERE user_id = ?`,
		`UPDATE service_rules SET user_id = ? WHERE user_id = ?`,
	} {
		if err := exec(q, dst, src); err != nil {
			return err
		}
	}

	// Bank messages. Both accounts may have the same message, if a phone
	// forwarded to both; keep the copy that was saved as a transaction.
	type capture struct {
		id                    int64
		hash, ref, dir, state string
	}
	var caps []capture
	rows, err := tx.QueryContext(ctx, `SELECT id, text_hash, ref, direction, status FROM captures WHERE user_id = ?`, src)
	if err != nil {
		return err
	}
	for rows.Next() {
		var c capture
		if err := rows.Scan(&c.id, &c.hash, &c.ref, &c.dir, &c.state); err != nil {
			rows.Close()
			return err
		}
		caps = append(caps, c)
	}
	rows.Close()
	for _, c := range caps {
		var clash []capture
		rows, err := tx.QueryContext(ctx, `SELECT id, status FROM captures WHERE user_id = ? AND (text_hash = ? OR (? != '' AND ref = ? AND direction = ?))`, dst, c.hash, c.ref, c.ref, c.dir)
		if err != nil {
			return err
		}
		for rows.Next() {
			var d capture
			if err := rows.Scan(&d.id, &d.state); err != nil {
				rows.Close()
				return err
			}
			clash = append(clash, d)
		}
		rows.Close()
		keepSrc := true
		for _, d := range clash {
			if d.state == "saved" || c.state != "saved" {
				keepSrc = false
			}
		}
		if !keepSrc {
			if err := exec(`DELETE FROM captures WHERE id = ?`, c.id); err != nil {
				return err
			}
			continue
		}
		for _, d := range clash {
			if err := exec(`DELETE FROM captures WHERE id = ?`, d.id); err != nil {
				return err
			}
		}
		if err := exec(`UPDATE captures SET user_id = ? WHERE id = ?`, dst, c.id); err != nil {
			return err
		}
	}

	// One capture link per person: keep the one a phone used last, so the
	// phone that's forwarding messages now keeps working.
	var srcUsed, dstUsed sql.NullString
	srcErr := tx.QueryRowContext(ctx, `SELECT last_used_at FROM capture_keys WHERE user_id = ?`, src).Scan(&srcUsed)
	dstErr := tx.QueryRowContext(ctx, `SELECT last_used_at FROM capture_keys WHERE user_id = ?`, dst).Scan(&dstUsed)
	if srcErr == nil && (errors.Is(dstErr, sql.ErrNoRows) || srcUsed.String > dstUsed.String) {
		if err := exec(`DELETE FROM capture_keys WHERE user_id = ?`, dst); err != nil {
			return err
		}
		if err := exec(`UPDATE capture_keys SET user_id = ? WHERE user_id = ?`, dst, src); err != nil {
			return err
		}
	}

	// Sign-in methods: src's Google now signs in to dst.
	if err := exec(`DELETE FROM identities WHERE user_id = ? AND provider IN (SELECT provider FROM identities WHERE user_id = ?)`, dst, src); err != nil {
		return err
	}
	if err := exec(`UPDATE identities SET user_id = ? WHERE user_id = ?`, dst, src); err != nil {
		return err
	}
	if err := exec(`UPDATE users SET is_owner = 1 WHERE id = ? AND (SELECT is_owner FROM users WHERE id = ?) = 1`, dst, src); err != nil {
		return err
	}
	// Everything left (sessions, a capture link not kept) goes with src.
	return exec(`DELETE FROM users WHERE id = ?`, src)
}
