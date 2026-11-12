package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

// Sign in with Google goes through Sideyard, which holds the OAuth client set
// up once on its dashboard's OAuth page; Google only ever calls back to
// Sideyard. The flow:
//
//	GET /auth/google?intent=…  asks Sideyard for a sign-in URL, keeps its state
//	                           in a cookie and sends the browser there
//	GET /auth/callback         Sideyard sends the browser back with a one-time
//	                           code, which is exchanged for who signed in
//
// What happens next depends on intent:
//
//	login  sign in to the account this Google account is connected to
//	setup  create the owner account, while the app has no users
//	join   create an account from an invite link (invite=<token>)
//	link   connect Google to the signed-in account (Settings)
//
// A Google account that isn't connected to anyone can't make an account
// without an invite: Kosh isn't open to everyone with a Google account.

const (
	signinStateCookie  = "kosh_signin_state"
	signinIntentCookie = "kosh_signin_intent"
	googleProvider     = "google"
)

type signedInUser struct {
	Provider      string `json:"provider"`
	ID            string `json:"id"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"emailVerified"`
	Name          string `json:"name"`
	AvatarURL     string `json:"avatarUrl"`
}

func sideyardConfigured() bool {
	return os.Getenv("SIDEYARD_API_URL") != "" && os.Getenv("SIDEYARD_TOKEN") != "" && os.Getenv("SIDEYARD_PROJECT") != ""
}

// sideyardAPI posts JSON to this project's part of Sideyard's API.
func sideyardAPI(ctx context.Context, path string, in, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	u := os.Getenv("SIDEYARD_API_URL") + "/api/projects/" + os.Getenv("SIDEYARD_PROJECT") + "/" + path
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+os.Getenv("SIDEYARD_TOKEN"))
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &e) == nil && e.Error != "" {
			return fmt.Errorf("sideyard %s: %s", path, e.Error)
		}
		return fmt.Errorf("sideyard %s: %s: %s", path, resp.Status, bytes.TrimSpace(data))
	}
	return json.Unmarshal(data, out)
}

// intentPage is where the browser lands after a sign-in with this intent.
func intentPage(intent string) string {
	switch {
	case intent == "link":
		return "/settings"
	case strings.HasPrefix(intent, "join:"):
		return "/join/" + url.PathEscape(strings.TrimPrefix(intent, "join:"))
	default:
		return "/"
	}
}

// authFail sends the browser back to the page it came from with a message
// the app shows there.
func authFail(w http.ResponseWriter, r *http.Request, intent, msg string) {
	http.Redirect(w, r, intentPage(intent)+"?authError="+url.QueryEscape(msg), http.StatusFound)
}

func signinCookie(r *http.Request, name, value string, maxAge int) *http.Cookie {
	return &http.Cookie{Name: name, Value: value, Path: "/auth", MaxAge: maxAge, HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode}
}

func (a *api) startGoogle(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	intent := q.Get("intent")
	switch intent {
	case "login", "setup", "link":
	case "join":
		intent = "join:" + q.Get("invite")
	default:
		intent = "login"
	}
	if !sideyardConfigured() {
		authFail(w, r, intent, "Google sign-in isn't set up on this server.")
		return
	}
	scheme := "http"
	if isHTTPS(r) {
		scheme = "https"
	}
	var start struct {
		URL   string `json:"url"`
		State string `json:"state"`
	}
	err := sideyardAPI(r.Context(), "oauth/start", map[string]string{"provider": googleProvider, "redirect": scheme + "://" + requestHost(r) + "/auth/callback"}, &start)
	if err != nil || start.URL == "" || start.State == "" {
		log.Printf("google sign-in start: %v", err)
		authFail(w, r, intent, "Couldn't reach Google. Try again in a moment.")
		return
	}
	http.SetCookie(w, signinCookie(r, signinStateCookie, start.State, 600))
	http.SetCookie(w, signinCookie(r, signinIntentCookie, url.QueryEscape(intent), 600))
	http.Redirect(w, r, start.URL, http.StatusFound)
}

func (a *api) googleCallback(w http.ResponseWriter, r *http.Request) {
	intent := "login"
	if c, err := r.Cookie(signinIntentCookie); err == nil {
		if v, err := url.QueryUnescape(c.Value); err == nil && v != "" {
			intent = v
		}
	}
	var state string
	if c, err := r.Cookie(signinStateCookie); err == nil {
		state = c.Value
	}
	// The state and intent are single-use.
	http.SetCookie(w, signinCookie(r, signinStateCookie, "", -1))
	http.SetCookie(w, signinCookie(r, signinIntentCookie, "", -1))

	q := r.URL.Query()
	if q.Get("error") != "" || q.Get("code") == "" {
		authFail(w, r, intent, "Google sign-in was cancelled.")
		return
	}
	if state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(q.Get("state"))) != 1 {
		authFail(w, r, intent, "That sign-in took too long. Try again.")
		return
	}
	var g signedInUser
	if err := sideyardAPI(r.Context(), "oauth/exchange", map[string]string{"code": q.Get("code"), "state": state}, &g); err != nil || g.ID == "" {
		log.Printf("google sign-in exchange: %v", err)
		authFail(w, r, intent, "Couldn't finish signing in with Google. Try again.")
		return
	}
	if g.Provider == "" {
		g.Provider = googleProvider
	}

	if intent == "link" {
		a.linkGoogle(w, r, g)
		return
	}

	uid, err := a.identityUser(r.Context(), g)
	switch {
	case err == nil:
		// Already connected: just sign in, whatever the intent.
	case !errors.Is(err, sql.ErrNoRows):
		serverError(w, err)
		return
	case intent == "setup":
		uid, err = a.createGoogleUser(r.Context(), g, "")
	case strings.HasPrefix(intent, "join:"):
		uid, err = a.createGoogleUser(r.Context(), g, strings.TrimPrefix(intent, "join:"))
	default:
		who := g.Email
		if who == "" {
			who = "This Google account"
		}
		authFail(w, r, intent, who+" isn't connected to a Kosh account. Sign in with your username, or ask for an invite link.")
		return
	}
	var ve errValidation
	if errors.As(err, &ve) {
		authFail(w, r, intent, string(ve))
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	if err := a.switchSession(w, r, uid); err != nil {
		serverError(w, err)
		return
	}
	// signedIn tells the app to drop anything cached for a previous user.
	http.Redirect(w, r, "/?signedIn=1", http.StatusFound)
}

func (a *api) identityUser(ctx context.Context, g signedInUser) (int64, error) {
	var uid int64
	err := a.db.QueryRowContext(ctx, `SELECT user_id FROM identities WHERE provider = ? AND provider_id = ?`, g.Provider, g.ID).Scan(&uid)
	if err == nil {
		// Keep the email shown in Settings current.
		a.db.ExecContext(ctx, `UPDATE identities SET email = ? WHERE provider = ? AND provider_id = ? AND email != ?`, g.Email, g.Provider, g.ID, g.Email)
	}
	return uid, err
}

// createGoogleUser makes an account for a Google sign-in. With no invite it
// makes the owner, and only while there are no users yet; with an invite
// token it spends the invite.
func (a *api) createGoogleUser(ctx context.Context, g signedInUser, invite string) (int64, error) {
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(timeLayout)

	owner := invite == ""
	var inviteID int64
	if owner {
		var users int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
			return 0, err
		}
		if users > 0 {
			return 0, errValidation("This Kosh is already set up. Sign in instead.")
		}
	} else {
		err := tx.QueryRow(`SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, hashToken(invite), now).Scan(&inviteID)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, errValidation(errInviteGone)
		} else if err != nil {
			return 0, err
		}
	}

	username, err := freeUsername(tx, g.Email)
	if err != nil {
		return 0, err
	}
	name := strings.TrimSpace(g.Name)
	if name == "" {
		name = username
	}
	if utf8.RuneCountInString(name) > 60 {
		name = string([]rune(name)[:60])
	}
	// No password: they sign in with Google, and can set one in Settings.
	uid, err := createUser(tx, credentials{Name: name, Username: username}, "", owner)
	if err != nil {
		return 0, err
	}
	if _, err := tx.Exec(`INSERT INTO identities (provider, provider_id, user_id, email) VALUES (?, ?, ?, ?)`, g.Provider, g.ID, uid, g.Email); err != nil {
		return 0, err
	}
	if !owner {
		if _, err := tx.Exec(`UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?`, uid, now, inviteID); err != nil {
			return 0, err
		}
	}
	return uid, tx.Commit()
}

// freeUsername turns an email's local part into a username nobody has yet.
func freeUsername(tx *sql.Tx, email string) (string, error) {
	local, _, _ := strings.Cut(strings.ToLower(email), "@")
	var b strings.Builder
	for _, c := range local {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-' {
			b.WriteRune(c)
		}
	}
	base := b.String()
	if len(base) > 26 {
		base = base[:26]
	}
	if len(base) < 3 {
		base += "user"
	}
	for i := 1; i < 1000; i++ {
		candidate := base
		if i > 1 {
			candidate = fmt.Sprintf("%s%d", base, i)
		}
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE username = ?`, candidate).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return candidate, nil
		}
	}
	return "", errors.New("no free username")
}

// linkGoogle connects the Google account to whoever is signed in.
func (a *api) linkGoogle(w http.ResponseWriter, r *http.Request, g signedInUser) {
	uid, err := a.sessionUser(r)
	if err != nil {
		authFail(w, r, "login", "Sign in first, then connect Google in Settings.")
		return
	}
	owner, err := a.identityUser(r.Context(), g)
	switch {
	case err == nil && owner == uid:
		http.Redirect(w, r, "/settings?google=linked", http.StatusFound)
		return
	case err == nil:
		authFail(w, r, "link", "That Google account is already connected to another Kosh account.")
		return
	case !errors.Is(err, sql.ErrNoRows):
		serverError(w, err)
		return
	}
	// Replace any Google account connected before.
	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM identities WHERE user_id = ? AND provider = ?`, uid, g.Provider); err != nil {
		serverError(w, err)
		return
	}
	if _, err := tx.Exec(`INSERT INTO identities (provider, provider_id, user_id, email) VALUES (?, ?, ?, ?)`, g.Provider, g.ID, uid, g.Email); err != nil {
		serverError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	http.Redirect(w, r, "/settings?google=linked", http.StatusFound)
}

// unlinkGoogle disconnects Google, as long as there's a password to sign in with.
func (a *api) unlinkGoogle(w http.ResponseWriter, r *http.Request, uid int64) {
	var hash string
	if err := a.db.QueryRowContext(r.Context(), `SELECT password_hash FROM users WHERE id = ?`, uid).Scan(&hash); err != nil {
		serverError(w, err)
		return
	}
	if hash == "" {
		writeError(w, http.StatusBadRequest, "Set a password first, so you can still sign in.")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM identities WHERE user_id = ? AND provider = ?`, uid, googleProvider); err != nil {
		serverError(w, err)
		return
	}
	a.respondMe(w, r, uid)
}
