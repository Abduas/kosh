package main

import (
	"net/http"
)

// Anyone can sign up. The owner (the first account) sees who has and can
// remove accounts, such as ones made by bots. Everyone's money stays
// separate: the owner can't see it.
//
// The invites table (migration 5) is from an earlier invite-only version
// and is no longer used.

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

func (a *api) listMembers(w http.ResponseWriter, r *http.Request, uid int64) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT u.id, u.name, u.username, u.is_owner,
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

	writeJSON(w, http.StatusOK, map[string]any{"members": members})
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
