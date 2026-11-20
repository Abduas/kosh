package main

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Agent connections: keys you hand an agent, and OAuth sign-ins (oauth.go).
// Both end up as a row in agent_connections, listed in Settings → AI agents
// where each can be made read-only or disconnected.

type agentConn struct {
	ID         int64   `json:"id"`
	Name       string  `json:"name"`
	Kind       string  `json:"kind"`  // key or oauth
	Scope      string  `json:"scope"` // read or write
	LastUsedAt *string `json:"lastUsedAt"`
	CreatedAt  string  `json:"createdAt"`
}

const (
	keyPrefix     = "kosh_k_"
	accessPrefix  = "kosh_at_"
	refreshPrefix = "kosh_rt_"
)

func newSecret(prefix string) string { return prefix + randomKey() + randomKey() }

// baseURL is how this Kosh is reached from outside, behind Sideyard's proxy.
func baseURL(r *http.Request) string {
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	return scheme + "://" + requestHost(r)
}

// callerFromToken finds the connection a key or OAuth access token belongs to.
func (a *api) callerFromToken(ctx context.Context, token string) (agentCaller, error) {
	var c agentCaller
	var q string
	switch {
	case strings.HasPrefix(token, keyPrefix):
		q = `SELECT id, user_id, name, scope FROM agent_connections WHERE key_hash = ?`
	case strings.HasPrefix(token, accessPrefix):
		q = `SELECT id, user_id, name, scope FROM agent_connections WHERE access_hash = ? AND access_expires_at > '` +
			time.Now().UTC().Format(timeLayout) + `'`
	default:
		return c, errors.New("not a Kosh token")
	}
	err := a.db.QueryRowContext(ctx, q, hashToken(token)).Scan(&c.connID, &c.uid, &c.name, &c.scope)
	return c, err
}

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

// ---- Settings → AI agents ----

func (a *api) listAgents(w http.ResponseWriter, r *http.Request, uid int64) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT id, name, kind, scope, last_used_at, created_at FROM agent_connections WHERE user_id = ? ORDER BY id DESC`, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	list := []agentConn{}
	for rows.Next() {
		var c agentConn
		if err := rows.Scan(&c.ID, &c.Name, &c.Kind, &c.Scope, &c.LastUsedAt, &c.CreatedAt); err != nil {
			serverError(w, err)
			return
		}
		list = append(list, c)
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": list, "mcpUrl": baseURL(r) + "/mcp"})
}

// createAgentKey makes a key for an agent with its own computer and the
// message to send it. The key is shown only now.
func (a *api) createAgentKey(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Name  string `json:"name"`
		Scope string `json:"scope"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	name, err := cleanName(in.Name, "Name", 40)
	if err != nil {
		respondErr(w, err)
		return
	}
	if in.Scope != "read" && in.Scope != "write" {
		respondErr(w, errValidation("Pick what it may do"))
		return
	}
	var n int
	a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM agent_connections WHERE user_id = ?`, uid).Scan(&n)
	if n >= 20 {
		respondErr(w, errValidation("Disconnect an agent you no longer use first"))
		return
	}
	key := newSecret(keyPrefix)
	res, err := a.db.ExecContext(r.Context(), `INSERT INTO agent_connections (user_id, name, kind, scope, key_hash) VALUES (?, ?, 'key', ?, ?)`,
		uid, name, in.Scope, hashToken(key))
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	var first string
	a.db.QueryRowContext(r.Context(), `SELECT name FROM users WHERE id = ?`, uid).Scan(&first)
	first, _, _ = strings.Cut(first, " ")
	link := baseURL(r) + "/agent/" + key
	access := "read my money and vehicle records and add new entries"
	if in.Scope == "read" {
		access = "read my money and vehicle records (read-only)"
	}
	msg := "Please connect to my Kosh, the app where I track my money and vehicles. " +
		"Open this link and follow the instructions there: " + link + "\n\n" +
		"It lets you " + access + ". Keep the link private and don't share it with anyone. " +
		"When I tell you I spent or received money, or about fuel, a service or my vehicle papers, record it in Kosh."
	writeJSON(w, http.StatusCreated, map[string]any{
		"connection": agentConn{ID: id, Name: name, Kind: "key", Scope: in.Scope, CreatedAt: time.Now().UTC().Format(timeLayout)},
		"key":        key, "link": link, "message": msg, "owner": first,
	})
}

func (a *api) updateAgent(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in struct {
		Scope string `json:"scope"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if in.Scope != "read" && in.Scope != "write" {
		respondErr(w, errValidation("Pick what it may do"))
		return
	}
	res, err := a.db.ExecContext(r.Context(), `UPDATE agent_connections SET scope = ? WHERE id = ? AND user_id = ?`, in.Scope, id, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// deleteAgent disconnects: its key or tokens stop working at once. What it
// added stays.
func (a *api) deleteAgent(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM agent_connections WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

var errNoCaller = errors.New("no agent")

// agentFromRequest accepts a Bearer key or token.
func (a *api) agentFromRequest(r *http.Request) (agentCaller, error) {
	t := bearer(r)
	if t == "" {
		return agentCaller{}, errNoCaller
	}
	c, err := a.callerFromToken(r.Context(), t)
	if errors.Is(err, sql.ErrNoRows) {
		return c, errNoCaller
	}
	return c, err
}
