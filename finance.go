package main

import (
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

// ---- Types sent to the frontend ----

type account struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	Kind           string `json:"kind"`
	Institution    string `json:"institution"`
	Last4          string `json:"last4"`
	Color          string `json:"color"`
	Icon           string `json:"icon"`
	OpeningBalance int64  `json:"openingBalance"`
	Balance        int64  `json:"balance"`
	IncludeInTotal bool   `json:"includeInTotal"`
	Archived       bool   `json:"archived"`
	SortOrder      int64  `json:"sortOrder"`
	TxCount        int64  `json:"txCount"`
}

type category struct {
	ID        int64  `json:"id"`
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Icon      string `json:"icon"`
	Color     string `json:"color"`
	Archived  bool   `json:"archived"`
	SortOrder int64  `json:"sortOrder"`
	UseCount  int64  `json:"useCount"`
}

type person struct {
	ID           int64  `json:"id"`
	Name         string `json:"name"`
	Phone        string `json:"phone"`
	Note         string `json:"note"`
	Color        string `json:"color"`
	Archived     bool   `json:"archived"`
	Balance      int64  `json:"balance"` // positive: they owe you
	LastActivity string `json:"lastActivity"`
	TxCount      int64  `json:"txCount"`
}

type user struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Username    string          `json:"username"`
	Prefs       json.RawMessage `json:"prefs"`
	IsOwner     bool            `json:"isOwner"`
	HasPassword bool            `json:"hasPassword"`
	GoogleEmail *string         `json:"googleEmail"` // null when Google isn't connected
}

// ---- Queries ----

// Signed effect of a transaction on account_id. Transfers also add to to_account_id.
const accountEffect = `CASE WHEN t.kind IN ('income', 'borrow', 'collect') THEN t.amount ELSE -t.amount END`

// Signed effect on a person's balance, where positive means they owe you.
const personEffect = `CASE WHEN t.kind IN ('lend', 'repay') THEN t.amount ELSE -t.amount END`

func (a *api) loadAccounts(ctx context.Context, uid int64, onlyID int64) ([]account, error) {
	q := `SELECT a.id, a.name, a.kind, a.institution, a.last4, a.color, a.icon, a.opening_balance,
		a.opening_balance
			+ COALESCE((SELECT SUM(` + accountEffect + `) FROM transactions t WHERE t.account_id = a.id), 0)
			+ COALESCE((SELECT SUM(t.amount) FROM transactions t WHERE t.to_account_id = a.id), 0),
		a.include_in_total, a.archived, a.sort_order,
		(SELECT COUNT(*) FROM transactions t WHERE t.account_id = a.id OR t.to_account_id = a.id)
		FROM accounts a WHERE a.user_id = ? AND (? = 0 OR a.id = ?)
		ORDER BY a.archived, a.sort_order, a.id`
	rows, err := a.db.QueryContext(ctx, q, uid, onlyID, onlyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []account{}
	for rows.Next() {
		var x account
		if err := rows.Scan(&x.ID, &x.Name, &x.Kind, &x.Institution, &x.Last4, &x.Color, &x.Icon, &x.OpeningBalance,
			&x.Balance, &x.IncludeInTotal, &x.Archived, &x.SortOrder, &x.TxCount); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (a *api) loadCategories(ctx context.Context, uid int64, onlyID int64) ([]category, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT c.id, c.kind, c.name, c.icon, c.color, c.archived, c.sort_order,
		(SELECT COUNT(*) FROM transactions t WHERE t.category_id = c.id AND t.occurred_at >= strftime('%Y-%m-%d', 'now', '-90 days'))
		FROM categories c WHERE c.user_id = ? AND (? = 0 OR c.id = ?)
		ORDER BY c.kind, c.archived, c.sort_order, c.id`, uid, onlyID, onlyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []category{}
	for rows.Next() {
		var x category
		if err := rows.Scan(&x.ID, &x.Kind, &x.Name, &x.Icon, &x.Color, &x.Archived, &x.SortOrder, &x.UseCount); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (a *api) loadPeople(ctx context.Context, uid int64, onlyID int64) ([]person, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT p.id, p.name, p.phone, p.note, p.color, p.archived,
		COALESCE((SELECT SUM(`+personEffect+`) FROM transactions t WHERE t.person_id = p.id), 0),
		COALESCE((SELECT MAX(t.occurred_at) FROM transactions t WHERE t.person_id = p.id), ''),
		(SELECT COUNT(*) FROM transactions t WHERE t.person_id = p.id)
		FROM people p WHERE p.user_id = ? AND (? = 0 OR p.id = ?)
		ORDER BY p.archived, p.name COLLATE NOCASE`, uid, onlyID, onlyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []person{}
	for rows.Next() {
		var x person
		if err := rows.Scan(&x.ID, &x.Name, &x.Phone, &x.Note, &x.Color, &x.Archived, &x.Balance, &x.LastActivity, &x.TxCount); err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (a *api) loadUser(ctx context.Context, uid int64) (user, error) {
	var u user
	var prefs string
	err := a.db.QueryRowContext(ctx, `SELECT u.id, u.name, u.username, u.prefs, u.is_owner, u.password_hash != '',
		(SELECT i.email FROM identities i WHERE i.user_id = u.id AND i.provider = 'google')
		FROM users u WHERE u.id = ?`, uid).Scan(&u.ID, &u.Name, &u.Username, &prefs, &u.IsOwner, &u.HasPassword, &u.GoogleEmail)
	u.Prefs = json.RawMessage(prefs)
	return u, err
}

// bootstrap returns everything the app needs to draw its first screen in one request.
func (a *api) bootstrap(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	u, err := a.loadUser(ctx, uid)
	if err != nil {
		respondErr(w, err)
		return
	}
	accounts, err := a.loadAccounts(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	categories, err := a.loadCategories(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	people, err := a.loadPeople(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "accounts": accounts, "categories": categories, "people": people})
}

// ---- Validation helpers ----

var (
	colorRe = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
	last4Re = regexp.MustCompile(`^[0-9]{4}$`)
)

func cleanName(s string, field string, max int) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errValidation(field + " is required")
	}
	if utf8.RuneCountInString(s) > max {
		return "", errValidation(field + " is too long")
	}
	return s, nil
}

func checkColor(s string) error {
	if !colorRe.MatchString(s) {
		return errValidation("Pick a color")
	}
	return nil
}

func checkIcon(s string) error {
	if s == "" || len(s) > 40 {
		return errValidation("Pick an icon")
	}
	return nil
}

// owned reports whether row id in table belongs to uid. table is never user input.
func (a *api) owned(ctx context.Context, table string, id, uid int64) (bool, error) {
	var n int
	err := a.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE id = ? AND user_id = ?`, id, uid).Scan(&n)
	return n == 1, err
}

// ---- Me ----

var allowedPrefs = map[string]func(any) bool{
	"currency":    func(v any) bool { s, ok := v.(string); return ok && len(s) == 3 },
	"theme":       func(v any) bool { s, ok := v.(string); return ok && (s == "system" || s == "light" || s == "dark") },
	"accent":      func(v any) bool { s, ok := v.(string); return ok && len(s) <= 20 },
	"upiId":       func(v any) bool { s, ok := v.(string); return ok && len(s) <= 80 },
	"hideAmounts": func(v any) bool { _, ok := v.(bool); return ok },
	"onboarded":   func(v any) bool { _, ok := v.(bool); return ok },
	"weekStart":   func(v any) bool { f, ok := v.(float64); return ok && (f == 0 || f == 1) },
	// The day of the month a budget month begins, like payday. 1 is the
	// calendar month; 28 at most so every month has that day.
	"monthStart": func(v any) bool { f, ok := v.(float64); return ok && f >= 1 && f <= 28 && f == float64(int64(f)) },
	// The account scan & pay uses unless you pick another; 0 means none chosen.
	"upiAccountId": func(v any) bool { f, ok := v.(float64); return ok && f >= 0 && f == float64(int64(f)) },
	// Auto-capture saves a bank message straight away when it knows the payee.
	"captureAuto": func(v any) bool { _, ok := v.(bool); return ok },
	// The payment apps you use (gpay, phonepe…), first is the favourite.
	"payApps": func(v any) bool {
		list, ok := v.([]any)
		if !ok || len(list) > 16 {
			return false
		}
		for _, x := range list {
			if s, ok := x.(string); !ok || s == "" || len(s) > 24 {
				return false
			}
		}
		return true
	},
	// The parts of Kosh you use: "finance", "vehicles" or both. Missing
	// means finance only, as before vehicles existed.
	"modules": func(v any) bool {
		list, ok := v.([]any)
		if !ok || len(list) == 0 || len(list) > 2 {
			return false
		}
		seen := map[string]bool{}
		for _, x := range list {
			s, ok := x.(string)
			if !ok || (s != "finance" && s != "vehicles") || seen[s] {
				return false
			}
			seen[s] = true
		}
		return true
	},
}

func (a *api) updateMe(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Name            *string        `json:"name"`
		Prefs           map[string]any `json:"prefs"`
		CurrentPassword string         `json:"currentPassword"`
		NewPassword     string         `json:"newPassword"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	ctx := r.Context()
	if in.Name != nil {
		name, err := cleanName(*in.Name, "Name", 60)
		if err != nil {
			respondErr(w, err)
			return
		}
		if _, err := a.db.ExecContext(ctx, `UPDATE users SET name = ? WHERE id = ?`, name, uid); err != nil {
			serverError(w, err)
			return
		}
	}
	if len(in.Prefs) > 0 {
		var raw string
		if err := a.db.QueryRowContext(ctx, `SELECT prefs FROM users WHERE id = ?`, uid).Scan(&raw); err != nil {
			serverError(w, err)
			return
		}
		prefs := map[string]any{}
		json.Unmarshal([]byte(raw), &prefs)
		for k, v := range in.Prefs {
			valid, ok := allowedPrefs[k]
			if !ok || !valid(v) {
				writeError(w, http.StatusBadRequest, "invalid setting: "+k)
				return
			}
			prefs[k] = v
		}
		b, _ := json.Marshal(prefs)
		if _, err := a.db.ExecContext(ctx, `UPDATE users SET prefs = ? WHERE id = ?`, string(b), uid); err != nil {
			serverError(w, err)
			return
		}
	}
	if in.NewPassword != "" {
		var hash string
		if err := a.db.QueryRowContext(ctx, `SELECT password_hash FROM users WHERE id = ?`, uid).Scan(&hash); err != nil {
			serverError(w, err)
			return
		}
		// Someone who signed up with Google sets their first password without one.
		if hash != "" && bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.CurrentPassword)) != nil {
			writeError(w, http.StatusBadRequest, "Current password is wrong")
			return
		}
		if utf8.RuneCountInString(in.NewPassword) < 8 || len(in.NewPassword) > 72 {
			writeError(w, http.StatusBadRequest, "New password needs at least 8 characters")
			return
		}
		newHash, err := bcrypt.GenerateFromPassword([]byte(in.NewPassword), 12)
		if err != nil {
			serverError(w, err)
			return
		}
		if _, err := a.db.ExecContext(ctx, `UPDATE users SET password_hash = ? WHERE id = ?`, string(newHash), uid); err != nil {
			serverError(w, err)
			return
		}
		// Sign out every other device.
		if c, err := r.Cookie(sessionCookie); err == nil {
			a.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`, uid, hashToken(c.Value))
		}
	}
	a.respondMe(w, r, uid)
}

func (a *api) respondMe(w http.ResponseWriter, r *http.Request, uid int64) {
	u, err := a.loadUser(r.Context(), uid)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// ---- Accounts ----

var accountKinds = map[string]bool{"bank": true, "cash": true, "wallet": true, "card": true, "savings": true, "investment": true}

type accountInput struct {
	Name           *string `json:"name"`
	Kind           *string `json:"kind"`
	Institution    *string `json:"institution"`
	Last4          *string `json:"last4"`
	Color          *string `json:"color"`
	Icon           *string `json:"icon"`
	OpeningBalance *int64  `json:"openingBalance"`
	IncludeInTotal *bool   `json:"includeInTotal"`
	Archived       *bool   `json:"archived"`
}

func (in accountInput) apply(x *account) error {
	if in.Name != nil {
		x.Name = *in.Name
	}
	if in.Kind != nil {
		x.Kind = *in.Kind
	}
	if in.Institution != nil {
		x.Institution = strings.TrimSpace(*in.Institution)
	}
	if in.Last4 != nil {
		x.Last4 = strings.TrimSpace(*in.Last4)
	}
	if in.Color != nil {
		x.Color = *in.Color
	}
	if in.Icon != nil {
		x.Icon = *in.Icon
	}
	if in.OpeningBalance != nil {
		x.OpeningBalance = *in.OpeningBalance
	}
	if in.IncludeInTotal != nil {
		x.IncludeInTotal = *in.IncludeInTotal
	}
	if in.Archived != nil {
		x.Archived = *in.Archived
	}
	var err error
	if x.Name, err = cleanName(x.Name, "Name", 40); err != nil {
		return err
	}
	if !accountKinds[x.Kind] {
		return errValidation("Pick an account type")
	}
	if len(x.Institution) > 60 {
		return errValidation("Bank name is too long")
	}
	if x.Last4 != "" && !last4Re.MatchString(x.Last4) {
		return errValidation("Last 4 digits should be 4 numbers")
	}
	if x.OpeningBalance > maxAmount || x.OpeningBalance < -maxAmount {
		return errValidation("Opening balance is too large")
	}
	if err := checkColor(x.Color); err != nil {
		return err
	}
	return checkIcon(x.Icon)
}

func (a *api) createAccount(w http.ResponseWriter, r *http.Request, uid int64) {
	var in accountInput
	if !readJSON(w, r, &in) {
		return
	}
	x := account{IncludeInTotal: true}
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	res, err := a.db.ExecContext(r.Context(), `INSERT INTO accounts (user_id, name, kind, institution, last4, color, icon, opening_balance, include_in_total, sort_order)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM accounts WHERE user_id = ?))`,
		uid, x.Name, x.Kind, x.Institution, x.Last4, x.Color, x.Icon, x.OpeningBalance, boolInt(x.IncludeInTotal), uid)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	a.respondAccount(w, r, uid, id, http.StatusCreated)
}

func (a *api) respondAccount(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	list, err := a.loadAccounts(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(list) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, status, list[0])
}

func (a *api) updateAccount(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in accountInput
	if !readJSON(w, r, &in) {
		return
	}
	list, err := a.loadAccounts(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(list) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	x := list[0]
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE accounts SET name = ?, kind = ?, institution = ?, last4 = ?, color = ?, icon = ?,
		opening_balance = ?, include_in_total = ?, archived = ? WHERE id = ? AND user_id = ?`,
		x.Name, x.Kind, x.Institution, x.Last4, x.Color, x.Icon, x.OpeningBalance, boolInt(x.IncludeInTotal), boolInt(x.Archived), id, uid); err != nil {
		serverError(w, err)
		return
	}
	a.respondAccount(w, r, uid, id, http.StatusOK)
}

func (a *api) deleteAccount(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var used int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM transactions WHERE user_id = ? AND (account_id = ? OR to_account_id = ?)`, uid, id, id).Scan(&used); err != nil {
		serverError(w, err)
		return
	}
	if used > 0 {
		writeError(w, http.StatusConflict, "This account has transactions. Archive it instead, or delete its transactions first.")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM accounts WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *api) reorderAccounts(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		IDs []int64 `json:"ids"`
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
	for i, id := range in.IDs {
		if _, err := tx.Exec(`UPDATE accounts SET sort_order = ? WHERE id = ? AND user_id = ?`, i, id, uid); err != nil {
			serverError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- Categories ----

type categoryInput struct {
	Kind     *string `json:"kind"`
	Name     *string `json:"name"`
	Icon     *string `json:"icon"`
	Color    *string `json:"color"`
	Archived *bool   `json:"archived"`
}

func (in categoryInput) apply(x *category) error {
	if in.Kind != nil {
		x.Kind = *in.Kind
	}
	if in.Name != nil {
		x.Name = *in.Name
	}
	if in.Icon != nil {
		x.Icon = *in.Icon
	}
	if in.Color != nil {
		x.Color = *in.Color
	}
	if in.Archived != nil {
		x.Archived = *in.Archived
	}
	var err error
	if x.Name, err = cleanName(x.Name, "Name", 32); err != nil {
		return err
	}
	if x.Kind != "expense" && x.Kind != "income" {
		return errValidation("Category must be for expenses or income")
	}
	if err := checkColor(x.Color); err != nil {
		return err
	}
	return checkIcon(x.Icon)
}

func (a *api) createCategory(w http.ResponseWriter, r *http.Request, uid int64) {
	var in categoryInput
	if !readJSON(w, r, &in) {
		return
	}
	var x category
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	res, err := a.db.ExecContext(r.Context(), `INSERT INTO categories (user_id, kind, name, icon, color, sort_order)
		VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM categories WHERE user_id = ? AND kind = ?))`,
		uid, x.Kind, x.Name, x.Icon, x.Color, uid, x.Kind)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	a.respondCategory(w, r, uid, id, http.StatusCreated)
}

func (a *api) respondCategory(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	list, err := a.loadCategories(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(list) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, status, list[0])
}

func (a *api) updateCategory(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in categoryInput
	if !readJSON(w, r, &in) {
		return
	}
	list, err := a.loadCategories(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(list) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	x := list[0]
	oldKind := x.Kind
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	if x.Kind != oldKind {
		writeError(w, http.StatusBadRequest, "A category can't switch between expense and income")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE categories SET name = ?, icon = ?, color = ?, archived = ? WHERE id = ? AND user_id = ?`,
		x.Name, x.Icon, x.Color, boolInt(x.Archived), id, uid); err != nil {
		serverError(w, err)
		return
	}
	a.respondCategory(w, r, uid, id, http.StatusOK)
}

func (a *api) deleteCategory(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var used int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM transactions WHERE user_id = ? AND category_id = ?`, uid, id).Scan(&used); err != nil {
		serverError(w, err)
		return
	}
	if used > 0 {
		writeError(w, http.StatusConflict, "This category has transactions. Archive it instead.")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM categories WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ---- People ----

type personInput struct {
	Name     *string `json:"name"`
	Phone    *string `json:"phone"`
	Note     *string `json:"note"`
	Color    *string `json:"color"`
	Archived *bool   `json:"archived"`
}

func (in personInput) apply(x *person) error {
	if in.Name != nil {
		x.Name = *in.Name
	}
	if in.Phone != nil {
		x.Phone = strings.TrimSpace(*in.Phone)
	}
	if in.Note != nil {
		x.Note = strings.TrimSpace(*in.Note)
	}
	if in.Color != nil {
		x.Color = *in.Color
	}
	if in.Archived != nil {
		x.Archived = *in.Archived
	}
	var err error
	if x.Name, err = cleanName(x.Name, "Name", 50); err != nil {
		return err
	}
	if len(x.Phone) > 20 {
		return errValidation("Phone number is too long")
	}
	if utf8.RuneCountInString(x.Note) > 200 {
		return errValidation("Note is too long")
	}
	return checkColor(x.Color)
}

func (a *api) createPerson(w http.ResponseWriter, r *http.Request, uid int64) {
	var in personInput
	if !readJSON(w, r, &in) {
		return
	}
	var x person
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	res, err := a.db.ExecContext(r.Context(), `INSERT INTO people (user_id, name, phone, note, color) VALUES (?, ?, ?, ?, ?)`,
		uid, x.Name, x.Phone, x.Note, x.Color)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	a.respondPerson(w, r, uid, id, http.StatusCreated)
}

func (a *api) respondPerson(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	list, err := a.loadPeople(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(list) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, status, list[0])
}

func (a *api) updatePerson(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in personInput
	if !readJSON(w, r, &in) {
		return
	}
	list, err := a.loadPeople(r.Context(), uid, id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(list) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	x := list[0]
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE people SET name = ?, phone = ?, note = ?, color = ?, archived = ? WHERE id = ? AND user_id = ?`,
		x.Name, x.Phone, x.Note, x.Color, boolInt(x.Archived), id, uid); err != nil {
		serverError(w, err)
		return
	}
	a.respondPerson(w, r, uid, id, http.StatusOK)
}

func (a *api) deletePerson(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var used int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM transactions WHERE user_id = ? AND person_id = ?`, uid, id).Scan(&used); err != nil {
		serverError(w, err)
		return
	}
	if used > 0 {
		writeError(w, http.StatusConflict, "This person has transactions. Archive them instead.")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM people WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
