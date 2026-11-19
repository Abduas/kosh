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

func TestOpenSignupAndMembers(t *testing.T) {
	srv := newTestServer(t)
	owner := newClient(t, srv)
	owner.do("POST", "/api/auth/signup", map[string]string{"name": "Owner", "username": "owner", "password": "password123"}, 201, nil)
	if !owner.me().IsOwner {
		t.Fatal("first account should be the owner")
	}

	// Anyone can sign up after that, and isn't the owner.
	sara := newClient(t, srv)
	sara.do("POST", "/api/auth/signup", map[string]string{"name": "Sara", "username": "Sara", "password": "short"}, 400, nil)
	sara.do("POST", "/api/auth/signup", map[string]string{"name": "Sara", "username": "OWNER", "password": "password456"}, 400, nil)
	sara.do("POST", "/api/auth/signup", map[string]string{"name": "Sara", "username": "Sara", "password": "password456"}, 201, nil)
	me := sara.me()
	if me.IsOwner || me.Username != "sara" || !me.HasPassword {
		t.Fatalf("new user: %+v", me)
	}
	var boot struct {
		Accounts   []account  `json:"accounts"`
		Categories []category `json:"categories"`
	}
	sara.do("GET", "/api/bootstrap", nil, 200, &boot)
	if len(boot.Accounts) != 1 || len(boot.Categories) == 0 {
		t.Fatalf("new user wasn't seeded: %d accounts, %d categories", len(boot.Accounts), len(boot.Categories))
	}
	newClient(t, srv).do("POST", "/api/auth/login", map[string]string{"username": "sara", "password": "password456"}, 200, nil)

	// The old endpoint name still signs people up.
	newClient(t, srv).do("POST", "/api/auth/setup", map[string]string{"name": "Old", "username": "oldapp", "password": "password789"}, 201, nil)

	// Only the owner sees and removes members.
	sara.do("GET", "/api/members", nil, 403, nil)
	sara.do("DELETE", fmt.Sprintf("/api/members/%d", owner.me().ID), nil, 403, nil)
	var list struct {
		Members []member `json:"members"`
	}
	owner.do("GET", "/api/members", nil, 200, &list)
	if len(list.Members) != 3 || !list.Members[0].IsOwner {
		t.Fatalf("members list: %+v", list)
	}

	// Removing someone deletes their data, transactions included, and signs them out.
	sara.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 5000, "accountId": boot.Accounts[0].ID, "occurredAt": "2026-11-01T10:00"}, 201, nil)
	owner.do("DELETE", fmt.Sprintf("/api/members/%d", owner.me().ID), nil, 400, nil)
	owner.do("DELETE", fmt.Sprintf("/api/members/%d", me.ID), nil, 204, nil)
	sara.do("GET", "/api/bootstrap", nil, 401, nil)
	owner.do("GET", "/api/members", nil, 200, &list)
	if len(list.Members) != 2 {
		t.Fatalf("member not removed: %+v", list.Members)
	}
}

func TestSignupRateLimit(t *testing.T) {
	srv := newTestServer(t)
	c := newClient(t, srv)
	for i := range 5 {
		c.do("POST", "/api/auth/signup", map[string]string{"name": "Bot", "username": fmt.Sprintf("bot%d", i), "password": "password123"}, 201, nil)
	}
	c.do("POST", "/api/auth/signup", map[string]string{"name": "Bot", "username": "bot9", "password": "password123"}, 429, nil)
	// Signing in still works.
	c.do("POST", "/api/auth/login", map[string]string{"username": "bot0", "password": "password123"}, 200, nil)
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
		"owner":  {Provider: "google", ID: "g-1", Email: "owner@gmail.com", EmailVerified: true, Name: "Owner Person"},
		"friend": {Provider: "google", ID: "g-2", Email: "sara.k@gmail.com", EmailVerified: true, Name: "Sara"},
		"pwuser": {Provider: "google", ID: "g-4", Email: "pw@gmail.com", EmailVerified: true, Name: "Pw"},
	})
	srv := newTestServer(t)

	var status struct {
		Google bool `json:"google"`
	}
	newClient(t, srv).do("GET", "/api/auth/status", nil, 200, &status)
	if !status.Google {
		t.Fatal("status should offer Google")
	}

	// The first Google sign-up is the owner, with no password.
	owner := newClient(t, srv)
	if u := owner.google("intent=login", "owner"); u.Path != "/" || u.Query().Get("signedIn") != "1" {
		t.Fatalf("first sign-up landed on %s", u)
	}
	me := owner.me()
	if !me.IsOwner || me.HasPassword || me.GoogleEmail == nil || *me.GoogleEmail != "owner@gmail.com" || me.Username != "owner" {
		t.Fatalf("owner: %+v", me)
	}
	// Setting a first password doesn't need a current one.
	owner.do("PATCH", "/api/me", map[string]string{"newPassword": "password123"}, 200, nil)

	// Anyone new signs up just by continuing with Google.
	friend := newClient(t, srv)
	if u := friend.google("intent=login", "friend"); u.Query().Get("authError") != "" {
		t.Fatalf("sign-up failed: %s", u)
	}
	if m := friend.me(); m.IsOwner || m.Username != "sara.k" {
		t.Fatalf("friend: %+v", m)
	}

	// Next time, the same Google account signs in to the same Kosh account.
	again := newClient(t, srv)
	again.google("intent=login", "friend")
	if again.me().ID != friend.me().ID {
		t.Fatal("Google sign-in made a second account")
	}

	// A password account connects Google in Settings, then signs in with it.
	pw := newClient(t, srv)
	pw.do("POST", "/api/auth/signup", map[string]string{"name": "Pw", "username": "pwuser", "password": "password456"}, 201, nil)
	pw.do("DELETE", "/api/me/google", nil, 200, nil) // nothing connected yet: a no-op
	if u := pw.google("intent=link", "pwuser"); u.Path != "/settings" || u.Query().Get("google") != "linked" {
		t.Fatalf("link landed on %s", u)
	}
	// A Google account with its own Kosh account isn't connected; it's offered
	// to merge, to this account only.
	u := pw.google("intent=link", "friend")
	token := u.Query().Get("merge")
	if u.Path != "/settings" || token == "" {
		t.Fatalf("linking another account's Google landed on %s", u)
	}
	var offer mergeSummary
	pw.do("GET", "/api/merge/"+token, nil, 200, &offer)
	if offer.Username != "sara.k" {
		t.Fatalf("merge offer: %+v", offer)
	}
	friend.do("GET", "/api/merge/"+token, nil, 404, nil)
	friend.do("POST", "/api/merge/"+token, nil, 404, nil)
	viaGoogle := newClient(t, srv)
	viaGoogle.google("intent=login", "pwuser")
	if viaGoogle.me().Username != "pwuser" {
		t.Fatal("linked Google signed in to the wrong account")
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
	if loc := resp.Header.Get("Location"); !strings.Contains(loc, "authError") {
		t.Fatalf("forged callback: %s", loc)
	}
	for _, c := range resp.Cookies() {
		if c.Name == sessionCookie && c.Value != "" {
			t.Fatal("forged callback signed someone in")
		}
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

func TestClientIPUsesProxyEntry(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Add("X-Forwarded-For", "1.2.3.4, 5.6.7.8") // client-sent "1.2.3.4", proxy added 5.6.7.8
	if ip := clientIP(r); ip != "5.6.7.8" {
		t.Fatalf("clientIP = %q", ip)
	}
}
