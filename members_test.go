package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

type meResp struct {
	ID          int64   `json:"id"`
	Username    string  `json:"username"`
	IsOwner     bool    `json:"isOwner"`
	HasPassword bool    `json:"hasPassword"`
	GoogleEmail *string `json:"googleEmail"`
}

func (c *client) me() meResp {
	c.t.Helper()
	var b struct {
		User meResp `json:"user"`
	}
	c.do("GET", "/api/bootstrap", nil, 200, &b)
	return b.User
}

func (c *client) invite() string {
	c.t.Helper()
	var inv struct {
		Token string `json:"token"`
	}
	c.do("POST", "/api/invites", nil, 201, &inv)
	return inv.Token
}

func TestInvitesAndMembers(t *testing.T) {
	srv := newTestServer(t)
	owner := newClient(t, srv)
	owner.do("POST", "/api/auth/setup", map[string]string{"name": "Owner", "username": "owner", "password": "password123"}, 201, nil)
	if !owner.me().IsOwner {
		t.Fatal("first account should be the owner")
	}

	token := owner.invite()
	anon := newClient(t, srv)
	var info struct {
		InvitedBy string `json:"invitedBy"`
	}
	anon.do("GET", "/api/auth/invite/"+token, nil, 200, &info)
	if info.InvitedBy != "Owner" {
		t.Fatalf("invitedBy = %q", info.InvitedBy)
	}
	anon.do("GET", "/api/auth/invite/nope", nil, 410, nil)

	// Joining needs a real invite and a free username.
	anon.do("POST", "/api/auth/join", map[string]string{"token": "nope", "name": "Sara", "username": "sara", "password": "password456"}, 410, nil)
	anon.do("POST", "/api/auth/join", map[string]string{"token": token, "name": "Sara", "username": "OWNER", "password": "password456"}, 409, nil)
	anon.do("POST", "/api/auth/join", map[string]string{"token": token, "name": "Sara", "username": "sara", "password": "password456"}, 201, nil)
	sara := anon.me()
	if sara.IsOwner || sara.Username != "sara" {
		t.Fatalf("joined user: %+v", sara)
	}

	// The link works once.
	again := newClient(t, srv)
	again.do("POST", "/api/auth/join", map[string]string{"token": token, "name": "X", "username": "xavier", "password": "password789"}, 410, nil)

	// A member gets their own starter data and can sign in again.
	var boot struct {
		Accounts   []account  `json:"accounts"`
		Categories []category `json:"categories"`
	}
	anon.do("GET", "/api/bootstrap", nil, 200, &boot)
	if len(boot.Accounts) != 1 || len(boot.Categories) == 0 {
		t.Fatalf("member wasn't seeded: %d accounts, %d categories", len(boot.Accounts), len(boot.Categories))
	}
	fresh := newClient(t, srv)
	fresh.do("POST", "/api/auth/login", map[string]string{"username": "sara", "password": "password456"}, 200, nil)

	// Only the owner manages members.
	anon.do("GET", "/api/members", nil, 403, nil)
	anon.do("POST", "/api/invites", nil, 403, nil)
	anon.do("DELETE", fmt.Sprintf("/api/members/%d", owner.me().ID), nil, 403, nil)

	pending := owner.invite()
	var list struct {
		Members []member `json:"members"`
		Invites []invite `json:"invites"`
	}
	owner.do("GET", "/api/members", nil, 200, &list)
	if len(list.Members) != 2 || len(list.Invites) != 1 {
		t.Fatalf("members list: %+v", list)
	}
	owner.do("DELETE", fmt.Sprintf("/api/invites/%d", list.Invites[0].ID), nil, 204, nil)
	newClient(t, srv).do("GET", "/api/auth/invite/"+pending, nil, 410, nil)

	// Removing a member deletes their data, transactions included, and signs them out.
	acc := boot.Accounts[0].ID
	anon.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 5000, "accountId": acc, "occurredAt": "2026-11-01T10:00"}, 201, nil)
	owner.do("DELETE", fmt.Sprintf("/api/members/%d", owner.me().ID), nil, 400, nil)
	owner.do("DELETE", fmt.Sprintf("/api/members/%d", sara.ID), nil, 204, nil)
	anon.do("GET", "/api/bootstrap", nil, 401, nil)
	owner.do("GET", "/api/members", nil, 200, &list)
	if len(list.Members) != 1 {
		t.Fatalf("member not removed: %+v", list.Members)
	}
}

// fakeSideyard stands in for Sideyard's sign-in API. Each code maps to a
// Google identity.
func fakeSideyard(t *testing.T, people map[string]signedInUser) {
	t.Helper()
	sy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sy-token" {
			http.Error(w, `{"error":"bad token"}`, 401)
			return
		}
		var in map[string]string
		json.NewDecoder(r.Body).Decode(&in)
		switch r.URL.Path {
		case "/api/projects/kosh/oauth/start":
			if in["provider"] != "google" || !strings.HasSuffix(in["redirect"], "/auth/callback") {
				http.Error(w, `{"error":"bad start"}`, 400)
				return
			}
			json.NewEncoder(w).Encode(map[string]string{"url": "https://accounts.google.test/o", "state": "state-123"})
		case "/api/projects/kosh/oauth/exchange":
			p, ok := people[in["code"]]
			if !ok || in["state"] != "state-123" {
				http.Error(w, `{"error":"bad code"}`, 400)
				return
			}
			json.NewEncoder(w).Encode(p)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(sy.Close)
	t.Setenv("SIDEYARD_API_URL", sy.URL)
	t.Setenv("SIDEYARD_PROJECT", "kosh")
	t.Setenv("SIDEYARD_TOKEN", "sy-token")
}

// google runs the browser side of a Google sign-in and returns where the app
// sent the browser at the end.
func (c *client) google(query, code string) *url.URL {
	c.t.Helper()
	hc := *c.hc
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := hc.Get(c.srv.URL + "/auth/google?" + query)
	if err != nil {
		c.t.Fatal(err)
	}
	resp.Body.Close()
	if loc := resp.Header.Get("Location"); resp.StatusCode != 302 || loc != "https://accounts.google.test/o" {
		c.t.Fatalf("start: %d %s", resp.StatusCode, loc)
	}
	resp, err = hc.Get(c.srv.URL + "/auth/callback?state=state-123&code=" + code)
	if err != nil {
		c.t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 302 {
		c.t.Fatalf("callback: %d", resp.StatusCode)
	}
	u, _ := url.Parse(resp.Header.Get("Location"))
	return u
}

func TestGoogleSignIn(t *testing.T) {
	fakeSideyard(t, map[string]signedInUser{
		"owner":    {Provider: "google", ID: "g-1", Email: "owner@gmail.com", EmailVerified: true, Name: "Owner Person"},
		"friend":   {Provider: "google", ID: "g-2", Email: "sara.k@gmail.com", EmailVerified: true, Name: "Sara"},
		"stranger": {Provider: "google", ID: "g-3", Email: "who@gmail.com", EmailVerified: true, Name: "Who"},
		"pwuser":   {Provider: "google", ID: "g-4", Email: "pw@gmail.com", EmailVerified: true, Name: "Pw"},
	})
	srv := newTestServer(t)

	var status struct {
		Google bool `json:"google"`
	}
	newClient(t, srv).do("GET", "/api/auth/status", nil, 200, &status)
	if !status.Google {
		t.Fatal("status should offer Google")
	}

	// First run: Google creates the owner, with no password.
	owner := newClient(t, srv)
	if u := owner.google("intent=setup", "owner"); u.Path != "/" || u.Query().Get("signedIn") != "1" {
		t.Fatalf("setup landed on %s", u)
	}
	me := owner.me()
	if !me.IsOwner || me.HasPassword || me.GoogleEmail == nil || *me.GoogleEmail != "owner@gmail.com" || me.Username != "owner" {
		t.Fatalf("owner: %+v", me)
	}
	// Setting a first password doesn't need a current one.
	owner.do("PATCH", "/api/me", map[string]string{"newPassword": "password123"}, 200, nil)

	// A second setup through Google is refused.
	if u := newClient(t, srv).google("intent=setup", "stranger"); u.Query().Get("authError") == "" {
		t.Fatalf("second setup allowed: %s", u)
	}

	// A Google account nobody has connected can't get in without an invite.
	if u := newClient(t, srv).google("intent=login", "stranger"); u.Path != "/" || !strings.Contains(u.Query().Get("authError"), "who@gmail.com") {
		t.Fatalf("stranger landed on %s", u)
	}

	// An invite lets a new person join with Google.
	token := owner.invite()
	friend := newClient(t, srv)
	if u := friend.google("intent=join&invite="+token, "friend"); u.Query().Get("authError") != "" {
		t.Fatalf("join failed: %s", u)
	}
	if m := friend.me(); m.IsOwner || m.Username != "sara.k" {
		t.Fatalf("friend: %+v", m)
	}
	// The invite is spent.
	if u := newClient(t, srv).google("intent=join&invite="+token, "stranger"); u.Path != "/join/"+token || u.Query().Get("authError") == "" {
		t.Fatalf("spent invite reused: %s", u)
	}

	// Next time, plain Google sign-in finds them.
	again := newClient(t, srv)
	if u := again.google("intent=login", "friend"); u.Query().Get("authError") != "" {
		t.Fatalf("login failed: %s", u)
	}
	if again.me().Username != "sara.k" {
		t.Fatal("signed in as the wrong person")
	}

	// A password account connects Google in Settings, then signs in with it.
	pw := newClient(t, srv)
	pw.do("POST", "/api/auth/join", map[string]string{"token": owner.invite(), "name": "Pw", "username": "pwuser", "password": "password456"}, 201, nil)
	pw.do("DELETE", "/api/me/google", nil, 200, nil) // nothing connected yet: a no-op
	if u := pw.google("intent=link", "pwuser"); u.Path != "/settings" || u.Query().Get("google") != "linked" {
		t.Fatalf("link landed on %s", u)
	}
	// Someone else's Google account can't be connected.
	if u := pw.google("intent=link", "friend"); !strings.Contains(u.Query().Get("authError"), "another") {
		t.Fatalf("linked someone else's Google: %s", u)
	}
	if u := newClient(t, srv).google("intent=login", "pwuser"); u.Query().Get("authError") != "" {
		t.Fatalf("linked login failed: %s", u)
	}

	// Disconnecting needs a password to fall back on.
	friend.do("DELETE", "/api/me/google", nil, 400, nil)
	pw.do("DELETE", "/api/me/google", nil, 200, nil)
	if pw.me().GoogleEmail != nil {
		t.Fatal("Google still connected")
	}

	// A callback whose state doesn't match the cookie is rejected.
	hc := *newClient(t, srv).hc
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	resp, err := hc.Get(srv.URL + "/auth/callback?state=state-123&code=owner")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if loc := resp.Header.Get("Location"); !strings.Contains(loc, "authError") || len(resp.Cookies()) > 0 && resp.Cookies()[0].Name == sessionCookie {
		t.Fatalf("forged callback: %s", loc)
	}
}

// An existing single-user Kosh upgrades with its one user as the owner.
func TestExistingUserBecomesOwner(t *testing.T) {
	path := t.TempDir() + "/old.db"
	all := migrations
	migrations = all[:4] // the schema before members
	db, err := openDB(path)
	migrations = all
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO users (username, name, password_hash) VALUES ('me', 'Me', 'x')`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	db, err = openDB(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var owner bool
	if err := db.QueryRow(`SELECT is_owner FROM users WHERE username = 'me'`).Scan(&owner); err != nil || !owner {
		t.Fatalf("existing user isn't the owner: %v %v", owner, err)
	}
}
