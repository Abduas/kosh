package main

// Auto-capture. iPhone web apps can't read SMS, so an automation in the
// Shortcuts app forwards each bank message to POST /api/capture/{token}.
// Kosh reads it, skips anything that isn't money moving, links it to a
// payment you already recorded (scan & pay), saves it straight away when it
// knows the payee, and otherwise puts it in a review list.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	_ "time/tzdata" // the server may have no zoneinfo; users' timezones still work
)

// 300 messages an hour per person: far above any real day, low enough that a
// leaked link can't flood the review list.
func newCaptureLimiter() *limiter { return newLimiter(time.Hour, 300) }

// ---- Setup, from Settings ----

type captureSetup struct {
	Enabled    bool    `json:"enabled"`
	Token      string  `json:"token,omitempty"`
	Timezone   string  `json:"timezone,omitempty"`
	LastUsedAt *string `json:"lastUsedAt"`
	Saved      int     `json:"saved"` // messages that became transactions
	// The shared "Kosh" shortcut (an iCloud link), so setup is "add, connect,
	// pick it in each automation" instead of building the request by hand.
	ShortcutURL string `json:"shortcutUrl,omitempty"`
}

// captureShortcutURL is set in Sideyard as CAPTURE_SHORTCUT_URL once someone
// has built the Kosh shortcut and shared it from the Shortcuts app.
func captureShortcutURL() string {
	u := strings.TrimSpace(os.Getenv("CAPTURE_SHORTCUT_URL"))
	if strings.HasPrefix(u, "https://www.icloud.com/shortcuts/") {
		return u
	}
	return ""
}

func (a *api) getCaptureSetup(w http.ResponseWriter, r *http.Request, uid int64) {
	var s captureSetup
	err := a.db.QueryRowContext(r.Context(), `SELECT token, timezone, last_used_at FROM capture_keys WHERE user_id = ?`, uid).
		Scan(&s.Token, &s.Timezone, &s.LastUsedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		serverError(w, err)
		return
	}
	s.Enabled = err == nil
	s.ShortcutURL = captureShortcutURL()
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM captures WHERE user_id = ? AND status = 'saved'`, uid).Scan(&s.Saved); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// putCaptureSetup turns capture on (making a link) or, with rotate, replaces
// the link so the old one stops working. It also records the phone's timezone.
func (a *api) putCaptureSetup(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Timezone string `json:"timezone"`
		Rotate   bool   `json:"rotate"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	tz := "Asia/Kolkata"
	if in.Timezone != "" {
		if _, err := time.LoadLocation(in.Timezone); err != nil || len(in.Timezone) > 64 {
			respondErr(w, errValidation("Unknown timezone"))
			return
		}
		tz = in.Timezone
	}
	token, err := newCaptureToken()
	if err != nil {
		serverError(w, err)
		return
	}
	q := `INSERT INTO capture_keys (user_id, token, timezone) VALUES (?, ?, ?)
		ON CONFLICT (user_id) DO UPDATE SET timezone = excluded.timezone`
	if in.Rotate {
		q += `, token = excluded.token, last_used_at = NULL`
	}
	if _, err := a.db.ExecContext(r.Context(), q, uid, token, tz); err != nil {
		serverError(w, err)
		return
	}
	a.getCaptureSetup(w, r, uid)
}

func (a *api) deleteCaptureSetup(w http.ResponseWriter, r *http.Request, uid int64) {
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM capture_keys WHERE user_id = ?`, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func newCaptureToken() (string, error) {
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// ---- Incoming messages, from the phone ----

// receiveCapture takes a message as JSON {"text": ...}, a form field "text",
// or the raw body: whichever the Shortcuts action sends.
func (a *api) receiveCapture(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		token = strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	}
	var uid int64
	var tz string
	err := a.db.QueryRowContext(r.Context(), `SELECT user_id, timezone FROM capture_keys WHERE token = ?`, token).Scan(&uid, &tz)
	if errors.Is(err, sql.ErrNoRows) || token == "" {
		writeError(w, http.StatusUnauthorized, "This capture link isn't active. Copy a new one from Kosh's Settings.")
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	key := "capture:" + token
	if !a.captures.allow(key) {
		writeError(w, http.StatusTooManyRequests, "Too many messages. Try again later.")
		return
	}
	a.captures.fail(key)

	text, err := readCaptureText(w, r)
	if err != nil {
		writeError(w, http.StatusBadRequest, "Send the message text")
		return
	}
	a.db.ExecContext(r.Context(), `UPDATE capture_keys SET last_used_at = ? WHERE user_id = ?`, time.Now().UTC().Format(timeLayout), uid)

	loc, err := time.LoadLocation(tz)
	if err != nil {
		loc = time.UTC
	}
	// One message, or the phone's queue of messages that arrived while it
	// was offline. The newest one's result is what the phone gets back.
	var status string
	statuses := []string{}
	for _, m := range splitCaptureQueue(text, time.Now(), loc) {
		if status, err = a.recordCapture(r.Context(), uid, m.text, m.at.In(loc).Format(localTimeLayout)); err != nil {
			serverError(w, err)
			return
		}
		statuses = append(statuses, status)
	}
	if len(statuses) == 0 {
		status = captureIgnored
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": status, "statuses": statuses})
}

// The Kosh shortcut adds each message to a file on the phone and sends the
// whole file, deleting it once Kosh has it. Without internet the send fails
// and the file keeps the message, so the next message (or a scheduled run)
// brings it along. Each message there starts with a line "#kosh <time it
// arrived>", so it's dated when it happened, not when it reached Kosh.
// Re-sending one that already arrived is harmless: duplicates are skipped.
var captureQueueMark = regexp.MustCompile(`(?m)^[ \t]*#kosh\b[ \t]*(.*)$`)

type queuedCapture struct {
	text string
	at   time.Time
}

func splitCaptureQueue(body string, now time.Time, loc *time.Location) []queuedCapture {
	marks := captureQueueMark.FindAllStringSubmatchIndex(body, -1)
	if len(marks) == 0 {
		return []queuedCapture{{strings.TrimSpace(body), now}}
	}
	var out []queuedCapture
	if head := strings.TrimSpace(body[:marks[0][0]]); head != "" {
		out = append(out, queuedCapture{head, now})
	}
	for i, m := range marks {
		end := len(body)
		if i+1 < len(marks) {
			end = marks[i+1][0]
		}
		text := strings.TrimSpace(body[m[1]:end])
		if text == "" { // a run with no message, e.g. a scheduled one
			continue
		}
		out = append(out, queuedCapture{text, queuedAt(strings.TrimSpace(body[m[2]:m[3]]), now, loc)})
	}
	return out
}

// queuedAt reads the time the phone stamped on a message: ISO 8601 with a
// time, or just a date if the shortcut's date format left the time off.
func queuedAt(s string, now time.Time, loc *time.Location) time.Time {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05Z0700", "2006-01-02T15:04Z07:00", "2006-01-02 15:04:05 Z0700"} {
		if t, err := time.Parse(layout, s); err == nil {
			if t.After(now) {
				return now
			}
			return t
		}
	}
	if d, err := time.ParseInLocation("2006-01-02", s, loc); err == nil {
		if today := now.In(loc); d.Year() == today.Year() && d.YearDay() == today.YearDay() {
			return now
		}
		if t := d.Add(12 * time.Hour); t.Before(now) { // the day is right; the hour unknown
			return t
		}
	}
	return now
}

func readCaptureText(w http.ResponseWriter, r *http.Request) (string, error) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256<<10)) // room for a day offline
	if err != nil {
		return "", err
	}
	ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	raw := strings.TrimSpace(string(body))
	switch {
	case ct == "application/json" || strings.HasPrefix(raw, "{"):
		var in map[string]any
		if json.Unmarshal(body, &in) == nil {
			for _, k := range []string{"text", "message", "body", "sms"} {
				if s, ok := in[k].(string); ok {
					return s, nil
				}
			}
			for _, v := range in { // any one string field will do
				if s, ok := v.(string); ok {
					return s, nil
				}
			}
		}
	case ct == "application/x-www-form-urlencoded":
		if v, err := url.ParseQuery(raw); err == nil && v.Get("text") != "" {
			return v.Get("text"), nil
		}
	}
	if raw == "" {
		return "", errors.New("empty")
	}
	return raw, nil
}

// Results of recording a message, also what the phone gets back.
const (
	captureIgnored   = "ignored"   // not a payment; not stored
	captureDuplicate = "duplicate" // already had it
	captureMatched   = "matched"   // the payment was already recorded, e.g. by scan & pay
	captureSaved     = "saved"     // saved as a transaction, the payee was known
	captureReview    = "review"    // waiting in the review list
)

func (a *api) recordCapture(ctx context.Context, uid int64, text, occurredAt string) (string, error) {
	sms, ok := parseBankSMS(text)
	if !ok {
		return captureIgnored, nil
	}
	norm := strings.ToLower(strings.TrimSpace(smsSpace.ReplaceAllString(text, " ")))
	sum := sha256.Sum256([]byte(norm))
	textHash := hex.EncodeToString(sum[:])

	var dup int
	if err := a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM captures WHERE user_id = ? AND (text_hash = ? OR (? != '' AND ref = ? AND direction = ?))`,
		uid, textHash, sms.Ref, sms.Ref, sms.Direction).Scan(&dup); err != nil {
		return "", err
	}
	if dup > 0 {
		return captureDuplicate, nil
	}

	accountID, err := a.captureAccount(ctx, uid, sms)
	if err != nil {
		return "", err
	}
	status, txID := captureReview, int64(0)

	if id, err := a.findRecorded(ctx, uid, sms, accountID, occurredAt); err != nil {
		return "", err
	} else if id > 0 {
		status, txID = captureMatched, id
	}

	var auto *transaction
	if status == captureReview && accountID > 0 {
		s, err := a.captureSuggestion(ctx, uid, sms)
		if err != nil {
			return "", err
		}
		on, err := a.autoCaptureOn(ctx, uid)
		if err != nil {
			return "", err
		}
		if s.Known && on {
			t := s.transaction(sms, accountID, occurredAt)
			// Anything that no longer adds up (an archived category, a removed
			// person) goes to review instead.
			if err := a.validateTx(ctx, uid, &t); err == nil {
				auto, status = &t, captureSaved
			}
		}
	}

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	if auto != nil {
		res, err := insertTx(ctx, tx, uid, *auto)
		if err != nil {
			return "", err
		}
		txID, _ = res.LastInsertId()
	}
	if status == captureMatched && sms.Ref != "" {
		if _, err := tx.ExecContext(ctx, `UPDATE transactions SET ref = ? WHERE id = ? AND ref = ''`, sms.Ref, txID); err != nil {
			return "", err
		}
	}
	saved := "review"
	if txID > 0 {
		saved = "saved"
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO captures (user_id, text, text_hash, direction, amount, account_id, bank, last4, payee, merchant, ref, occurred_at, status, transaction_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		uid, strings.TrimSpace(text), textHash, sms.Direction, sms.Amount, nullID(accountID), sms.Bank, sms.Last4, sms.Payee, sms.Merchant, sms.Ref, occurredAt, saved, nullID(txID)); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return captureDuplicate, nil // the same message arrived twice at once
		}
		return "", err
	}
	return status, tx.Commit()
}

func nullID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}

func (a *api) autoCaptureOn(ctx context.Context, uid int64) (bool, error) {
	var raw string
	if err := a.db.QueryRowContext(ctx, `SELECT prefs FROM users WHERE id = ?`, uid).Scan(&raw); err != nil {
		return false, err
	}
	var p struct {
		CaptureAuto *bool `json:"captureAuto"`
	}
	json.Unmarshal([]byte(raw), &p)
	return p.CaptureAuto == nil || *p.CaptureAuto, nil
}

// captureAccount finds which of your accounts a message is about: by its last
// digits, then by bank name, then the only bank account you have. 0 if unsure.
func (a *api) captureAccount(ctx context.Context, uid int64, sms bankSMS) (int64, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id, name, institution, last4, kind FROM accounts WHERE user_id = ? AND archived = 0`, uid)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	type acct struct {
		id                      int64
		name, inst, last4, kind string
	}
	var all []acct
	for rows.Next() {
		var x acct
		if err := rows.Scan(&x.id, &x.name, &x.inst, &x.last4, &x.kind); err != nil {
			return 0, err
		}
		all = append(all, x)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	pick := func(keep func(acct) bool, from []acct) []acct {
		var out []acct
		for _, x := range from {
			if keep(x) {
				out = append(out, x)
			}
		}
		return out
	}
	notCash := pick(func(x acct) bool { return x.kind != "cash" }, all)
	byBank := notCash
	if sms.Bank != "" {
		for i, b := range smsBanks {
			if b.name == sms.Bank {
				re := smsBankRes[i]
				byBank = pick(func(x acct) bool { return re.MatchString(x.name + " " + x.inst) }, notCash)
				break
			}
		}
	}
	if sms.Last4 != "" {
		byDigits := pick(func(x acct) bool {
			return x.last4 != "" && (strings.HasSuffix(x.last4, sms.Last4) || strings.HasSuffix(sms.Last4, x.last4))
		}, notCash)
		if len(byDigits) == 1 {
			return byDigits[0].id, nil
		}
		if len(byDigits) > 1 { // two cards ending alike: let the bank decide
			both := pick(func(x acct) bool {
				for _, y := range byBank {
					if y.id == x.id {
						return true
					}
				}
				return false
			}, byDigits)
			if len(both) == 1 {
				return both[0].id, nil
			}
			return 0, nil
		}
	}
	if sms.Bank != "" && len(byBank) == 1 {
		return byBank[0].id, nil
	}
	if len(notCash) == 1 {
		return notCash[0].id, nil
	}
	return 0, nil
}

var (
	debitKinds  = map[string]bool{"expense": true, "lend": true, "repay": true}
	creditKinds = map[string]bool{"income": true, "borrow": true, "collect": true}
)

func kindFits(kind, direction string) bool {
	if direction == "debit" {
		return debitKinds[kind]
	}
	return creditKinds[kind]
}

// findRecorded looks for a transaction you already entered for this payment:
// same amount, same direction, within 45 minutes, not yet linked to a message.
// A split bill from scan & pay is several transactions that add up to it.
func (a *api) findRecorded(ctx context.Context, uid int64, sms bankSMS, accountID int64, occurredAt string) (int64, error) {
	at, err := time.Parse(localTimeLayout, occurredAt)
	if err != nil {
		return 0, err
	}
	lo, hi := at.Add(-45*time.Minute).Format(localTimeLayout), at.Add(45*time.Minute).Format(localTimeLayout)
	kinds := `('expense', 'lend', 'repay')`
	if sms.Direction == "credit" {
		kinds = `('income', 'borrow', 'collect')`
	}
	unlinked := `t.ref = '' AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.transaction_id = t.id)`
	var id int64
	err = a.db.QueryRowContext(ctx, `SELECT t.id FROM transactions t
		WHERE t.user_id = ? AND t.amount = ? AND t.kind IN `+kinds+` AND t.occurred_at BETWEEN ? AND ? AND `+unlinked+`
		ORDER BY t.account_id = ? DESC, t.occurred_at DESC LIMIT 1`, uid, sms.Amount, lo, hi, accountID).Scan(&id)
	if err == nil || !errors.Is(err, sql.ErrNoRows) {
		return id, err
	}
	if sms.Direction != "debit" {
		return 0, nil
	}
	err = a.db.QueryRowContext(ctx, `SELECT MIN(t.id) FROM transactions t
		WHERE t.user_id = ? AND t.source = 'upi-scan' AND t.occurred_at BETWEEN ? AND ? AND `+unlinked+`
		GROUP BY t.created_at, t.account_id HAVING SUM(t.amount) = ? AND COUNT(*) > 1
		ORDER BY t.account_id = ? DESC LIMIT 1`, uid, lo, hi, sms.Amount, accountID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return id, err
}

// captureSuggestion is how Kosh would file a message: like the last payment to
// the same UPI ID or the same name, or as a plain expense or income.
type captureSuggestion struct {
	Known      bool   `json:"known"`
	Kind       string `json:"kind"`
	CategoryID *int64 `json:"categoryId"`
	PersonID   *int64 `json:"personId"`
	Note       string `json:"note"`
}

func (a *api) captureSuggestion(ctx context.Context, uid int64, sms bankSMS) (captureSuggestion, error) {
	s := captureSuggestion{Kind: "expense", Note: smsNote(sms)}
	if sms.Direction == "credit" {
		s.Kind = "income"
	}
	try := func(q string, args ...any) (bool, error) {
		var kind string
		var cat, per *int64
		err := a.db.QueryRowContext(ctx, q, args...).Scan(&kind, &cat, &per)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !kindFits(kind, sms.Direction)) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		s.Known, s.Kind, s.CategoryID, s.PersonID = true, kind, cat, per
		return true, nil
	}
	if sms.Payee != "" {
		if ok, err := try(`SELECT kind, category_id, person_id FROM transactions WHERE user_id = ? AND payee = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`, uid, sms.Payee); ok || err != nil {
			return s, err
		}
	}
	if sms.Merchant != "" {
		if _, err := try(`SELECT t.kind, t.category_id, t.person_id FROM captures c JOIN transactions t ON t.id = c.transaction_id
			WHERE c.user_id = ? AND c.status = 'saved' AND c.merchant = ? COLLATE NOCASE AND c.direction = ?
			ORDER BY c.id DESC LIMIT 1`, uid, sms.Merchant, sms.Direction); err != nil {
			return s, err
		}
	}
	return s, nil
}

func (s captureSuggestion) transaction(sms bankSMS, accountID int64, occurredAt string) transaction {
	t := transaction{Kind: s.Kind, Amount: sms.Amount, AccountID: accountID, CategoryID: s.CategoryID, PersonID: s.PersonID,
		Note: s.Note, OccurredAt: occurredAt, Source: "sms", Ref: sms.Ref, Payee: sms.Payee}
	return t
}

// smsNote names the other side for the transaction's note: "Swiggy Limited",
// or the UPI ID when that's all the message says.
func smsNote(sms bankSMS) string {
	n := sms.Merchant
	if len([]rune(n)) > 60 {
		n = string([]rune(n)[:60])
	}
	return n
}

// ---- Review, in the app ----

type capture struct {
	ID         int64             `json:"id"`
	Direction  string            `json:"direction"`
	Amount     int64             `json:"amount"`
	AccountID  *int64            `json:"accountId"`
	Bank       string            `json:"bank"`
	Last4      string            `json:"last4"`
	Payee      string            `json:"payee"`
	Merchant   string            `json:"merchant"`
	Ref        string            `json:"ref"`
	OccurredAt string            `json:"occurredAt"`
	Text       string            `json:"text"`
	Suggestion captureSuggestion `json:"suggestion"`
}

func (a *api) listCaptures(w http.ResponseWriter, r *http.Request, uid int64) {
	rows, err := a.db.QueryContext(r.Context(), `SELECT c.id, c.direction, c.amount, a.id, c.bank, c.last4, c.payee, c.merchant, c.ref, c.occurred_at, c.text
		FROM captures c LEFT JOIN accounts a ON a.id = c.account_id AND a.archived = 0
		WHERE c.user_id = ? AND c.status = 'review' ORDER BY c.occurred_at DESC, c.id DESC LIMIT 200`, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	items := []capture{}
	for rows.Next() {
		var c capture
		if err := rows.Scan(&c.ID, &c.Direction, &c.Amount, &c.AccountID, &c.Bank, &c.Last4, &c.Payee, &c.Merchant, &c.Ref, &c.OccurredAt, &c.Text); err != nil {
			rows.Close()
			serverError(w, err)
			return
		}
		items = append(items, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}
	// Suggested afresh each time: what you saved for one message helps the next.
	for i := range items {
		c := &items[i]
		sms := bankSMS{Direction: c.Direction, Payee: c.Payee, Merchant: c.Merchant}
		if c.Suggestion, err = a.captureSuggestion(r.Context(), uid, sms); err != nil {
			serverError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (a *api) dismissCapture(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE captures SET status = 'dismissed' WHERE id = ? AND user_id = ? AND status = 'review'`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// testCapture shows what Kosh reads from a message without saving anything.
func (a *api) testCapture(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Text string `json:"text"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	sms, ok := parseBankSMS(in.Text)
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"recognised": false})
		return
	}
	accountID, err := a.captureAccount(r.Context(), uid, sms)
	if err != nil {
		serverError(w, err)
		return
	}
	s, err := a.captureSuggestion(r.Context(), uid, sms)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"recognised": true, "sms": sms, "accountId": nullID(accountID), "suggestion": s})
}

// claimCapture is used when you save a reviewed message: the transaction takes
// the message's reference, and the message is marked saved in the same tx.
func claimCapture(ctx context.Context, tx *sql.Tx, uid, captureID int64, t *transaction) error {
	var ref, payee string
	err := tx.QueryRowContext(ctx, `SELECT ref, payee FROM captures WHERE id = ? AND user_id = ? AND status = 'review'`, captureID, uid).Scan(&ref, &payee)
	if errors.Is(err, sql.ErrNoRows) {
		return errValidation("This payment was already saved or dismissed")
	}
	if err != nil {
		return err
	}
	t.Source, t.Ref = "sms", ref
	if t.Payee == "" && payee != "" && t.Kind != "transfer" {
		t.Payee = payee
	}
	return nil
}

func markCaptureSaved(ctx context.Context, tx *sql.Tx, captureID, txID int64) error {
	_, err := tx.ExecContext(ctx, `UPDATE captures SET status = 'saved', transaction_id = ? WHERE id = ?`, txID, captureID)
	return err
}
