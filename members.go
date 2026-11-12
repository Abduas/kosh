package main

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"time"
)

// The owner (the first account) invites people with one-time links and can
// remove them. Everyone's money stays separate: the owner can't see it.

const (
	inviteTTL        = 7 * 24 * time.Hour
	maxPendingInvite = 20
)

// ownerOnly runs h only for the owner.
func (a *api) ownerOnly(h authedHandler) http.HandlerFunc {
	return a.authed(func(w http.ResponseWriter, r *http.Request, uid int64) {
		var owner bool
		if err := a.db.QueryRowContext(r.Context(), `SELECT is_owner FROM users WHERE id = ?`, uid).Scan(&owner); err != nil {
			serverError(w, err)
			return
		}
		if !owner {
			writeError(w, http.StatusForbidden, "Only the owner can manage members")
			return
		}
		h(w, r, uid)
	})
}

type member struct {
	ID          int64   `json:"id"`
	Name        string  `json:"name"`
	Username    string  `json:"username"`
	IsOwner     bool    `json:"isOwner"`
	GoogleEmail *string `json:"googleEmail"`
	CreatedAt   string  `json:"createdAt"`
}

type invite struct {
	ID        int64  `json:"id"`
	ExpiresAt string `json:"expiresAt"`
	CreatedAt string `json:"createdAt"`
}

func (a *api) listMembers(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	rows, err := a.db.QueryContext(ctx, `SELECT u.id, u.name, u.username, u.is_owner,
		(SELECT i.email FROM identities i WHERE i.user_id = u.id AND i.provider = 'google'), u.created_at
		FROM users u ORDER BY u.is_owner DESC, u.created_at, u.id`)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	members := []member{}
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.ID, &m.Name, &m.Username, &m.IsOwner, &m.GoogleEmail, &m.CreatedAt); err != nil {
			serverError(w, err)
			return
		}
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}

	irows, err := a.db.QueryContext(ctx, `SELECT id, expires_at, created_at FROM invites
		WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC, id DESC`, time.Now().UTC().Format(timeLayout))
	if err != nil {
		serverError(w, err)
		return
	}
	defer irows.Close()
	invites := []invite{}
	for irows.Next() {
		var i invite
		if err := irows.Scan(&i.ID, &i.ExpiresAt, &i.CreatedAt); err != nil {
			serverError(w, err)
			return
		}
		invites = append(invites, i)
	}
	if err := irows.Err(); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": members, "invites": invites})
}

// createInvite makes a one-time link that's good for a week. Only its hash is
// stored, so the link is shown once.
func (a *api) createInvite(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	now := time.Now().UTC()
	var pending int
	if err := a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM invites WHERE used_at IS NULL AND expires_at > ?`, now.Format(timeLayout)).Scan(&pending); err != nil {
		serverError(w, err)
		return
	}
	if pending >= maxPendingInvite {
		writeError(w, http.StatusBadRequest, "Too many open invites. Cancel some first.")
		return
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		serverError(w, err)
		return
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	expires := now.Add(inviteTTL).Format(timeLayout)
	res, err := a.db.ExecContext(ctx, `INSERT INTO invites (token_hash, created_by, expires_at) VALUES (?, ?, ?)`, hashToken(token), uid, expires)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "token": token, "expiresAt": expires})
}

func (a *api) deleteInvite(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM invites WHERE id = ? AND used_at IS NULL`, id); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteMember removes someone and all of their money data. The owner can't
// be removed.
func (a *api) deleteMember(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	var owner bool
	if err := tx.QueryRow(`SELECT is_owner FROM users WHERE id = ?`, id).Scan(&owner); err != nil {
		respondErr(w, err)
		return
	}
	if owner {
		writeError(w, http.StatusBadRequest, "The owner can't be removed")
		return
	}
	// Transactions first: they hold accounts and people with ON DELETE RESTRICT.
	// Deleting the user then cascades to everything else they own.
	if _, err := tx.Exec(`DELETE FROM transactions WHERE user_id = ?`, id); err != nil {
		serverError(w, err)
		return
	}
	if _, err := tx.Exec(`DELETE FROM users WHERE id = ?`, id); err != nil {
		serverError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
