package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookie = "kosh_session"
	sessionTTL    = 180 * 24 * time.Hour
	timeLayout    = "2006-01-02T15:04:05Z"
)

// dummyHash is compared against when a username doesn't exist.
var dummyHash = sync.OnceValue(func() []byte {
	h, _ := bcrypt.GenerateFromPassword([]byte("not-a-real-password"), 12)
	return h
})

type authedHandler func(w http.ResponseWriter, r *http.Request, uid int64)

// authed runs h only for a request with a valid session.
func (a *api) authed(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		uid, err := a.sessionUser(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "sign in required")
			return
		}
		h(w, r, uid)
	}
}

func (a *api) sessionUser(r *http.Request) (int64, error) {
	c, err := r.Cookie(sessionCookie)
	if err != nil || c.Value == "" {
		return 0, errors.New("no session")
	}
	var uid int64
	err = a.db.QueryRowContext(r.Context(),
		`SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?`,
		hashToken(c.Value), time.Now().UTC().Format(timeLayout),
	).Scan(&uid)
	return uid, err
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (a *api) startSession(w http.ResponseWriter, r *http.Request, uid int64) error {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(buf)
	expires := time.Now().Add(sessionTTL)
	if _, err := a.db.ExecContext(r.Context(),
		`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`,
		hashToken(token), uid, expires.UTC().Format(timeLayout),
	); err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	return nil
}

// switchSession ends the request's current session, if any, and starts one
// for uid: opening an invite or signing in as someone else on a shared phone.
func (a *api) switchSession(w http.ResponseWriter, r *http.Request, uid int64) error {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
	}
	return a.startSession(w, r, uid)
}

// authStatus tells the frontend which screen to show: setup, login or the app,
// and whether the Google button can work here.
func (a *api) authStatus(w http.ResponseWriter, r *http.Request) {
	var users int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		serverError(w, err)
		return
	}
	_, err := a.sessionUser(r)
	writeJSON(w, http.StatusOK, map[string]bool{"needsSetup": users == 0, "signedIn": err == nil, "google": sideyardConfigured()})
}

type credentials struct {
	Name     string `json:"name"`
	Username string `json:"username"`
	Password string `json:"password"`
}

const defaultPrefs = `{"currency":"INR","theme":"system","accent":"violet"}`

// check tidies new-account details and returns the bcrypt hash of the password.
func (in *credentials) check() (string, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Username = strings.ToLower(strings.TrimSpace(in.Username))
	switch {
	case in.Name == "" || utf8.RuneCountInString(in.Name) > 60:
		return "", errValidation("Enter your name")
	case len(in.Username) < 3 || len(in.Username) > 32 || strings.ContainsAny(in.Username, " \t@/"):
		return "", errValidation("Username needs 3–32 characters, no spaces")
	case utf8.RuneCountInString(in.Password) < 8 || len(in.Password) > 72:
		return "", errValidation("Password needs at least 8 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), 12)
	return string(hash), err
}

// createUser adds an account with starter categories and a Cash account.
func createUser(tx *sql.Tx, in credentials, hash string, owner bool) (int64, error) {
	res, err := tx.Exec(`INSERT INTO users (username, name, password_hash, prefs, is_owner) VALUES (?, ?, ?, ?, ?)`,
		in.Username, in.Name, hash, defaultPrefs, boolInt(owner))
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return 0, errUsernameTaken
		}
		return 0, err
	}
	uid, _ := res.LastInsertId()
	return uid, seedUser(tx, uid)
}

var errUsernameTaken = errors.New("username taken")

func respondCreateUser(w http.ResponseWriter, err error) {
	if errors.Is(err, errUsernameTaken) {
		writeError(w, http.StatusConflict, "That username is taken. Try another.")
		return
	}
	respondErr(w, err)
}

// setup creates the first (owner) account. It only works while there are no users.
func (a *api) setup(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !readJSON(w, r, &in) {
		return
	}
	hash, err := in.check()
	if err != nil {
		respondErr(w, err)
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	var users int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&users); err != nil {
		serverError(w, err)
		return
	}
	if users > 0 {
		writeError(w, http.StatusForbidden, "This app is already set up")
		return
	}
	uid, err := createUser(tx, in, hash, true)
	if err != nil {
		respondCreateUser(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	if err := a.startSession(w, r, uid); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

const errInviteGone = "This invite link has expired or was already used. Ask for a new one."

// inviteInfo lets the sign-up screen check a link and say who sent it.
func (a *api) inviteInfo(w http.ResponseWriter, r *http.Request) {
	var from string
	err := a.db.QueryRowContext(r.Context(), `SELECT u.name FROM invites i JOIN users u ON u.id = i.created_by
		WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`,
		hashToken(r.PathValue("token")), time.Now().UTC().Format(timeLayout)).Scan(&from)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusGone, errInviteGone)
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"invitedBy": from})
}

// join creates an account from a one-time invite link and signs it in.
func (a *api) join(w http.ResponseWriter, r *http.Request) {
	var in struct {
		credentials
		Token string `json:"token"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	hash, err := in.check()
	if err != nil {
		respondErr(w, err)
		return
	}

	tx, err := a.db.BeginTx(r.Context(), nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(timeLayout)
	var inviteID int64
	err = tx.QueryRow(`SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`, hashToken(in.Token), now).Scan(&inviteID)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusGone, errInviteGone)
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	uid, err := createUser(tx, in.credentials, hash, false)
	if err != nil {
		respondCreateUser(w, err)
		return
	}
	if _, err := tx.Exec(`UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?`, uid, now, inviteID); err != nil {
		serverError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	if err := a.switchSession(w, r, uid); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]bool{"ok": true})
}

func (a *api) login(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if !a.limiter.allow(ip) {
		writeError(w, http.StatusTooManyRequests, "Too many attempts. Try again in a few minutes.")
		return
	}
	var in credentials
	if !readJSON(w, r, &in) {
		return
	}
	var uid int64
	var hash string
	err := a.db.QueryRowContext(r.Context(), `SELECT id, password_hash FROM users WHERE username = ?`,
		strings.TrimSpace(in.Username)).Scan(&uid, &hash)
	if errors.Is(err, sql.ErrNoRows) {
		// Spend the same time as a real check so usernames can't be probed.
		bcrypt.CompareHashAndPassword(dummyHash(), []byte(in.Password))
		a.limiter.fail(ip)
		writeError(w, http.StatusUnauthorized, "Wrong username or password")
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
		a.limiter.fail(ip)
		writeError(w, http.StatusUnauthorized, "Wrong username or password")
		return
	}
	a.limiter.reset(ip)
	if err := a.startSession(w, r, uid); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		a.db.ExecContext(r.Context(), `DELETE FROM sessions WHERE token_hash = ?`, hashToken(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode})
	w.WriteHeader(http.StatusNoContent)
}

// loginLimiter allows 8 failed logins per IP per 10 minutes.
type loginLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newLoginLimiter() *loginLimiter { return &loginLimiter{attempts: map[string][]time.Time{}} }

const (
	loginWindow   = 10 * time.Minute
	loginMaxFails = 8
)

func (l *loginLimiter) recent(ip string) []time.Time {
	cutoff := time.Now().Add(-loginWindow)
	kept := l.attempts[ip][:0]
	for _, t := range l.attempts[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.attempts, ip)
		return nil
	}
	l.attempts[ip] = kept
	return kept
}

func (l *loginLimiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recent(ip)) < loginMaxFails
}

func (l *loginLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attempts[ip] = append(l.recent(ip), time.Now())
}

func (l *loginLimiter) reset(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, ip)
}
