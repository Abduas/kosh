package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Vehicles: the garage. Each vehicle has logs (fuel, service, other costs and
// odometer readings) and papers with expiry dates (insurance, PUC, road tax…).
// A cost paid from an account is also an expense in Money, linked through
// vehicle_logs.transaction_id, so the two never disagree.

type vehicle struct {
	ID         int64   `json:"id"`
	Kind       string  `json:"kind"`
	Name       string  `json:"name"`
	Make       string  `json:"make"`
	Model      string  `json:"model"`
	Year       *int64  `json:"year"`
	RegNumber  string  `json:"regNumber"`
	Fuel       string  `json:"fuel"`
	Color      string  `json:"color"`
	Archived   bool    `json:"archived"`
	SortOrder  int64   `json:"sortOrder"`
	Odometer   *int64  `json:"odometer"`   // the highest reading, km (odometers only go up)
	OdometerOn *string `json:"odometerOn"` // when it was read
	CreatedAt  string  `json:"createdAt"`
}

type vehicleLog struct {
	ID            int64  `json:"id"`
	VehicleID     int64  `json:"vehicleId"`
	Kind          string `json:"kind"`
	OccurredOn    string `json:"occurredOn"`
	Odometer      *int64 `json:"odometer"`
	Litres        *int64 `json:"litres"` // millilitres
	FullTank      bool   `json:"fullTank"`
	Title         string `json:"title"`
	Amount        int64  `json:"amount"`
	Note          string `json:"note"`
	TransactionID *int64 `json:"transactionId"`
	AccountID     *int64 `json:"accountId"` // the account it was paid from
}

type vehicleDoc struct {
	ID            int64   `json:"id"`
	VehicleID     *int64  `json:"vehicleId"`
	Type          string  `json:"type"`
	Title         string  `json:"title"`
	Number        string  `json:"number"`
	Issuer        string  `json:"issuer"`
	IssuedOn      *string `json:"issuedOn"`
	ExpiresOn     *string `json:"expiresOn"`
	Amount        int64   `json:"amount"`
	Note          string  `json:"note"`
	FileName      string  `json:"fileName"`
	FileType      string  `json:"fileType"`
	FileSize      int64   `json:"fileSize"`
	TransactionID *int64  `json:"transactionId"`
	AccountID     *int64  `json:"accountId"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
	fileKey       string
}

var (
	vehicleKinds = map[string]bool{"car": true, "bike": true, "scooter": true, "other": true}
	fuelKinds    = map[string]bool{"petrol": true, "diesel": true, "cng": true, "ev": true, "hybrid": true}
	logKinds     = map[string]bool{"fuel": true, "service": true, "expense": true, "odometer": true}
	docTypes     = map[string]string{
		"rc": "RC", "insurance": "Insurance", "puc": "PUC", "road_tax": "Road tax", "fitness": "Fitness",
		"permit": "Permit", "licence": "Driving licence", "warranty": "Warranty", "other": "Document",
	}
	regRe = regexp.MustCompile(`^[A-Z0-9]{4,12}$`)
)

func cleanDate(s string, field string) (string, error) {
	tm, err := time.Parse(dateLayout, strings.TrimSpace(s))
	if err != nil || tm.Year() < 1950 || tm.Year() > 2200 {
		return "", errValidation("Pick a valid " + field)
	}
	return tm.Format(dateLayout), nil
}

func optDate(s *string, field string) (*string, error) {
	if s == nil || strings.TrimSpace(*s) == "" {
		return nil, nil
	}
	d, err := cleanDate(*s, field)
	return &d, err
}

func cleanText(s string, field string, max int) (string, error) {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > max {
		return "", errValidation(field + " is too long")
	}
	return s, nil
}

// normalizeReg turns "ka 01 ab-1234" into "KA01AB1234".
func normalizeReg(s string) string {
	return strings.Map(func(r rune) rune {
		if r == ' ' || r == '-' || r == '.' {
			return -1
		}
		return r
	}, strings.ToUpper(strings.TrimSpace(s)))
}

// ---- Loading ----

func (a *api) loadVehicles(ctx context.Context, uid, onlyID int64) ([]vehicle, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT v.id, v.kind, v.name, v.make, v.model, v.year, v.reg_number, v.fuel, v.color, v.archived, v.sort_order, v.created_at,
		r.odometer, r.occurred_on
		FROM vehicles v
		LEFT JOIN vehicle_logs r ON r.id = (SELECT l.id FROM vehicle_logs l WHERE l.vehicle_id = v.id AND l.odometer IS NOT NULL
			ORDER BY l.odometer DESC, l.occurred_on DESC LIMIT 1)
		WHERE v.user_id = ? AND (? = 0 OR v.id = ?)
		ORDER BY v.archived, v.sort_order, v.id`, uid, onlyID, onlyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []vehicle{}
	for rows.Next() {
		var v vehicle
		if err := rows.Scan(&v.ID, &v.Kind, &v.Name, &v.Make, &v.Model, &v.Year, &v.RegNumber, &v.Fuel, &v.Color, &v.Archived, &v.SortOrder, &v.CreatedAt,
			&v.Odometer, &v.OdometerOn); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (a *api) loadVehicleLogs(ctx context.Context, uid, onlyID int64) ([]vehicleLog, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT l.id, l.vehicle_id, l.kind, l.occurred_on, l.odometer, l.litres, l.full_tank, l.title, l.amount, l.note, l.transaction_id, t.account_id
		FROM vehicle_logs l LEFT JOIN transactions t ON t.id = l.transaction_id
		WHERE l.user_id = ? AND (? = 0 OR l.id = ?)
		ORDER BY l.occurred_on DESC, l.id DESC`, uid, onlyID, onlyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []vehicleLog{}
	for rows.Next() {
		var l vehicleLog
		if err := rows.Scan(&l.ID, &l.VehicleID, &l.Kind, &l.OccurredOn, &l.Odometer, &l.Litres, &l.FullTank, &l.Title, &l.Amount, &l.Note, &l.TransactionID, &l.AccountID); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

func (a *api) loadVehicleDocs(ctx context.Context, uid, onlyID int64) ([]vehicleDoc, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT d.id, d.vehicle_id, d.type, d.title, d.number, d.issuer, d.issued_on, d.expires_on, d.amount, d.note,
		d.file_key, d.file_name, d.file_type, d.file_size, d.transaction_id, t.account_id, d.created_at, d.updated_at
		FROM vehicle_documents d LEFT JOIN transactions t ON t.id = d.transaction_id
		WHERE d.user_id = ? AND (? = 0 OR d.id = ?)
		ORDER BY d.expires_on IS NULL, d.expires_on, d.id`, uid, onlyID, onlyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []vehicleDoc{}
	for rows.Next() {
		var d vehicleDoc
		if err := rows.Scan(&d.ID, &d.VehicleID, &d.Type, &d.Title, &d.Number, &d.Issuer, &d.IssuedOn, &d.ExpiresOn, &d.Amount, &d.Note,
			&d.fileKey, &d.FileName, &d.FileType, &d.FileSize, &d.TransactionID, &d.AccountID, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// listVehicles returns the whole garage in one go: it's small, and the
// screens (due dates, mileage, spend) work it out from everything.
func (a *api) listVehicles(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	vehicles, err := a.loadVehicles(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	logs, err := a.loadVehicleLogs(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	docs, err := a.loadVehicleDocs(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vehicles": vehicles, "logs": logs, "documents": docs, "storage": fileBucket() != nil})
}

// ---- Vehicles ----

type vehicleInput struct {
	Kind      *string `json:"kind"`
	Name      *string `json:"name"`
	Make      *string `json:"make"`
	Model     *string `json:"model"`
	Year      *int64  `json:"year"`
	RegNumber *string `json:"regNumber"`
	Fuel      *string `json:"fuel"`
	Color     *string `json:"color"`
	Archived  *bool   `json:"archived"`
	// On create: today's odometer, saved as the first reading.
	Odometer *int64 `json:"odometer"`
}

func (in vehicleInput) apply(v *vehicle) error {
	var err error
	if in.Kind != nil {
		v.Kind = *in.Kind
	}
	if !vehicleKinds[v.Kind] {
		return errValidation("Pick a vehicle type")
	}
	if in.Name != nil {
		v.Name = *in.Name
	}
	if v.Name, err = cleanName(v.Name, "Name", 40); err != nil {
		return err
	}
	if in.Make != nil {
		if v.Make, err = cleanText(*in.Make, "Make", 40); err != nil {
			return err
		}
	}
	if in.Model != nil {
		if v.Model, err = cleanText(*in.Model, "Model", 40); err != nil {
			return err
		}
	}
	if in.Year != nil {
		if *in.Year == 0 {
			v.Year = nil
		} else if *in.Year < 1950 || *in.Year > int64(time.Now().Year()+1) {
			return errValidation("Pick a valid year")
		} else {
			v.Year = in.Year
		}
	}
	if in.RegNumber != nil {
		v.RegNumber = normalizeReg(*in.RegNumber)
		if v.RegNumber != "" && !regRe.MatchString(v.RegNumber) {
			return errValidation("That registration number doesn't look right")
		}
	}
	if in.Fuel != nil {
		v.Fuel = *in.Fuel
	}
	if v.Fuel == "" {
		v.Fuel = "petrol"
	}
	if !fuelKinds[v.Fuel] {
		return errValidation("Pick a fuel")
	}
	if in.Color != nil {
		v.Color = *in.Color
	}
	if err := checkColor(v.Color); err != nil {
		return err
	}
	if in.Archived != nil {
		v.Archived = *in.Archived
	}
	return nil
}

func checkOdometer(km *int64) error {
	if km != nil && (*km < 0 || *km > 10_000_000) {
		return errValidation("That odometer reading doesn't look right")
	}
	return nil
}

func (a *api) createVehicle(w http.ResponseWriter, r *http.Request, uid int64) {
	var in vehicleInput
	if !readJSON(w, r, &in) {
		return
	}
	var v vehicle
	if err := in.apply(&v); err != nil {
		respondErr(w, err)
		return
	}
	if err := checkOdometer(in.Odometer); err != nil {
		respondErr(w, err)
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT INTO vehicles (user_id, kind, name, make, model, year, reg_number, fuel, color, sort_order)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM vehicles WHERE user_id = ?))`,
		uid, v.Kind, v.Name, v.Make, v.Model, v.Year, v.RegNumber, v.Fuel, v.Color, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	if in.Odometer != nil {
		if _, err := tx.ExecContext(ctx, `INSERT INTO vehicle_logs (user_id, vehicle_id, kind, occurred_on, odometer) VALUES (?, ?, 'odometer', ?, ?)`,
			uid, id, time.Now().Format(dateLayout), *in.Odometer); err != nil {
			serverError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	a.respondVehicle(w, r, uid, id, http.StatusCreated)
}

func (a *api) respondVehicle(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	list, err := a.loadVehicles(r.Context(), uid, id)
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

func (a *api) updateVehicle(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in vehicleInput
	if !readJSON(w, r, &in) {
		return
	}
	list, err := a.loadVehicles(r.Context(), uid, id)
	if err != nil || len(list) == 0 {
		respondErr(w, cmpErr(err, sql.ErrNoRows))
		return
	}
	v := list[0]
	if err := in.apply(&v); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE vehicles SET kind = ?, name = ?, make = ?, model = ?, year = ?, reg_number = ?, fuel = ?, color = ?, archived = ?
		WHERE id = ? AND user_id = ?`, v.Kind, v.Name, v.Make, v.Model, v.Year, v.RegNumber, v.Fuel, v.Color, v.Archived, id, uid); err != nil {
		serverError(w, err)
		return
	}
	a.respondVehicle(w, r, uid, id, http.StatusOK)
}

// deleteVehicle removes it with its logs and papers. Expenses it was paid
// with stay in Money, no longer tied to a vehicle.
func (a *api) deleteVehicle(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ctx := r.Context()
	keys, err := a.fileKeys(ctx, `SELECT file_key FROM vehicle_documents WHERE vehicle_id = ? AND user_id = ? AND file_key != ''`, id, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	if _, err := a.db.ExecContext(ctx, `DELETE FROM vehicles WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	removeFiles(keys)
	w.WriteHeader(http.StatusNoContent)
}

func cmpErr(err, fallback error) error {
	if err != nil {
		return err
	}
	return fallback
}

// ---- Paying for things ----

type queryExecer interface {
	execer
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// ensureCategory finds your expense category with this name, or adds it.
func ensureCategory(ctx context.Context, tx queryExecer, uid int64, name, icon, color string) (int64, error) {
	var id int64
	err := tx.QueryRowContext(ctx, `SELECT id FROM categories WHERE user_id = ? AND kind = 'expense' AND name = ? COLLATE NOCASE ORDER BY archived, id LIMIT 1`, uid, name).Scan(&id)
	if err == nil || !errors.Is(err, sql.ErrNoRows) {
		return id, err
	}
	res, err := tx.ExecContext(ctx, `INSERT INTO categories (user_id, kind, name, icon, color, sort_order)
		VALUES (?, 'expense', ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories WHERE user_id = ? AND kind = 'expense'))`, uid, name, icon, color, uid)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// categoryFor is where a vehicle cost is filed in Money.
func categoryFor(ctx context.Context, tx queryExecer, uid int64, logKind string) (int64, error) {
	if logKind == "fuel" {
		return ensureCategory(ctx, tx, uid, "Fuel", "⛽", "#EF4444")
	}
	return ensureCategory(ctx, tx, uid, "Vehicle", "🚗", "#0EA5E9")
}

type payment struct {
	accountID int64
	amount    int64
	date      string // YYYY-MM-DD
	note      string
	logKind   string // picks the category for a new expense
}

// pay records or updates the expense a vehicle cost was paid with and
// returns its id. existing is the expense already linked, if any.
func (a *api) pay(ctx context.Context, tx *sql.Tx, uid int64, existing *int64, p payment) (int64, error) {
	if ok, err := a.owned(ctx, "accounts", p.accountID, uid); err != nil {
		return 0, err
	} else if !ok {
		return 0, errValidation("Pick an account")
	}
	if p.amount <= 0 {
		return 0, errValidation("Enter what you paid")
	}
	if p.amount > maxAmount {
		return 0, errValidation("Amount is too large")
	}
	note := p.note
	if utf8.RuneCountInString(note) > 280 {
		note = string([]rune(note)[:280])
	}
	if existing != nil {
		// Keep the time of day unless the date moved.
		var at string
		if err := tx.QueryRowContext(ctx, `SELECT occurred_at FROM transactions WHERE id = ? AND user_id = ?`, *existing, uid).Scan(&at); err != nil {
			return 0, err
		}
		if !strings.HasPrefix(at, p.date) {
			at = p.date + "T12:00"
		}
		_, err := tx.ExecContext(ctx, `UPDATE transactions SET amount = ?, account_id = ?, occurred_at = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
			WHERE id = ? AND user_id = ?`, p.amount, p.accountID, at, note, *existing, uid)
		return *existing, err
	}
	cat, err := categoryFor(ctx, tx, uid, p.logKind)
	if err != nil {
		return 0, err
	}
	at := p.date + "T12:00"
	if p.date == time.Now().Format(dateLayout) {
		at = p.date + "T" + time.Now().Format("15:04")
	}
	res, err := insertTx(ctx, tx, uid, transaction{Kind: "expense", Amount: p.amount, AccountID: p.accountID, CategoryID: &cat, Note: note, OccurredAt: at, Source: "manual"})
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// optID is a JSON field that can be left out (no change), null (clear it) or
// a number.
type optID struct {
	Set bool
	V   *int64
}

func (o *optID) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.V = nil
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

// ---- Logs ----

type logInput struct {
	VehicleID  *int64  `json:"vehicleId"`
	Kind       *string `json:"kind"`
	OccurredOn *string `json:"occurredOn"`
	Odometer   optID   `json:"odometer"`
	Litres     optID   `json:"litres"`
	FullTank   *bool   `json:"fullTank"`
	Title      *string `json:"title"`
	Amount     *int64  `json:"amount"`
	Note       *string `json:"note"`
	// The account it was paid from: also records it as an expense in Money.
	// null means it wasn't paid from an account Kosh tracks.
	AccountID optID `json:"accountId"`
}

func (in logInput) apply(l *vehicleLog) error {
	var err error
	if in.VehicleID != nil {
		l.VehicleID = *in.VehicleID
	}
	if in.Kind != nil {
		l.Kind = *in.Kind
	}
	if !logKinds[l.Kind] {
		return errValidation("Pick what this is")
	}
	if in.OccurredOn != nil {
		l.OccurredOn = *in.OccurredOn
	}
	if l.OccurredOn, err = cleanDate(l.OccurredOn, "date"); err != nil {
		return err
	}
	if in.Odometer.Set {
		l.Odometer = in.Odometer.V
	}
	if err := checkOdometer(l.Odometer); err != nil {
		return err
	}
	if in.Litres.Set {
		l.Litres = in.Litres.V
	}
	if l.Litres != nil && (*l.Litres <= 0 || *l.Litres > 1_000_000) {
		return errValidation("That fuel amount doesn't look right")
	}
	if in.FullTank != nil {
		l.FullTank = *in.FullTank
	}
	if in.Title != nil {
		if l.Title, err = cleanText(*in.Title, "Title", 80); err != nil {
			return err
		}
	}
	if in.Amount != nil {
		l.Amount = *in.Amount
	}
	if l.Amount < 0 || l.Amount > maxAmount {
		return errValidation("That amount doesn't look right")
	}
	if in.Note != nil {
		if l.Note, err = cleanText(*in.Note, "Note", 280); err != nil {
			return err
		}
	}
	if l.Kind == "odometer" {
		if l.Odometer == nil {
			return errValidation("Enter the odometer reading")
		}
		l.Amount, l.Litres, l.FullTank = 0, nil, false
	}
	if l.Kind != "fuel" {
		l.Litres, l.FullTank = nil, false
	}
	return nil
}

func (l vehicleLog) label() string {
	if l.Title != "" {
		return l.Title
	}
	switch l.Kind {
	case "fuel":
		return "Fuel"
	case "service":
		return "Service"
	}
	return "Vehicle"
}

// saveLog writes l and, when accountID is given, the expense it was paid with.
func (a *api) saveLog(ctx context.Context, uid int64, l vehicleLog, accountID optID) (int64, error) {
	if ok, err := a.owned(ctx, "vehicles", l.VehicleID, uid); err != nil {
		return 0, err
	} else if !ok {
		return 0, errValidation("Pick a vehicle")
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	paid := l.TransactionID
	if accountID.Set {
		paid = nil
		if accountID.V != nil && l.Kind != "odometer" {
			note := l.label()
			if v := strings.TrimSpace(l.Note); v != "" {
				note += " · " + v
			}
			id, err := a.pay(ctx, tx, uid, l.TransactionID, payment{accountID: *accountID.V, amount: l.Amount, date: l.OccurredOn, note: note, logKind: l.Kind})
			if err != nil {
				return 0, err
			}
			paid = &id
		} else if l.TransactionID != nil {
			// No longer paid from an account: the expense goes.
			if _, err := tx.ExecContext(ctx, `DELETE FROM transactions WHERE id = ? AND user_id = ?`, *l.TransactionID, uid); err != nil {
				return 0, err
			}
		}
	} else if paid != nil {
		// Same account; keep the expense's amount and date in step.
		if _, err := a.pay(ctx, tx, uid, paid, payment{accountID: *l.AccountID, amount: l.Amount, date: l.OccurredOn, note: l.label(), logKind: l.Kind}); err != nil {
			return 0, err
		}
	}

	id := l.ID
	if id == 0 {
		res, err := tx.ExecContext(ctx, `INSERT INTO vehicle_logs (user_id, vehicle_id, kind, occurred_on, odometer, litres, full_tank, title, amount, note, transaction_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uid, l.VehicleID, l.Kind, l.OccurredOn, l.Odometer, l.Litres, l.FullTank, l.Title, l.Amount, l.Note, paid)
		if err != nil {
			return 0, err
		}
		id, _ = res.LastInsertId()
	} else if _, err := tx.ExecContext(ctx, `UPDATE vehicle_logs SET vehicle_id = ?, kind = ?, occurred_on = ?, odometer = ?, litres = ?, full_tank = ?, title = ?, amount = ?, note = ?, transaction_id = ?
		WHERE id = ? AND user_id = ?`,
		l.VehicleID, l.Kind, l.OccurredOn, l.Odometer, l.Litres, l.FullTank, l.Title, l.Amount, l.Note, paid, id, uid); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func (a *api) respondLog(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	list, err := a.loadVehicleLogs(r.Context(), uid, id)
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

func (a *api) createVehicleLog(w http.ResponseWriter, r *http.Request, uid int64) {
	var in logInput
	if !readJSON(w, r, &in) {
		return
	}
	var l vehicleLog
	if err := in.apply(&l); err != nil {
		respondErr(w, err)
		return
	}
	id, err := a.saveLog(r.Context(), uid, l, in.AccountID)
	if err != nil {
		respondErr(w, err)
		return
	}
	a.respondLog(w, r, uid, id, http.StatusCreated)
}

func (a *api) updateVehicleLog(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in logInput
	if !readJSON(w, r, &in) {
		return
	}
	list, err := a.loadVehicleLogs(r.Context(), uid, id)
	if err != nil || len(list) == 0 {
		respondErr(w, cmpErr(err, sql.ErrNoRows))
		return
	}
	l := list[0]
	if err := in.apply(&l); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.saveLog(r.Context(), uid, l, in.AccountID); err != nil {
		respondErr(w, err)
		return
	}
	a.respondLog(w, r, uid, id, http.StatusOK)
}

// deleteVehicleLog removes the log and the expense it was paid with.
func (a *api) deleteVehicleLog(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ctx := r.Context()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	var paid *int64
	err = tx.QueryRowContext(ctx, `SELECT transaction_id FROM vehicle_logs WHERE id = ? AND user_id = ?`, id, uid).Scan(&paid)
	if errors.Is(err, sql.ErrNoRows) {
		w.WriteHeader(http.StatusNoContent)
		return
	} else if err != nil {
		serverError(w, err)
		return
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM vehicle_logs WHERE id = ?`, id); err != nil {
		serverError(w, err)
		return
	}
	if paid != nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM transactions WHERE id = ? AND user_id = ?`, *paid, uid); err != nil {
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

// ---- A transaction that belongs to a vehicle ----

// vehicleLink is what an expense in Money says about its vehicle: sent by
// the add-transaction sheet and returned with each transaction.
type vehicleLink struct {
	VehicleID int64  `json:"vehicleId"`
	Kind      string `json:"kind"` // fuel, service or expense
	Odometer  *int64 `json:"odometer"`
	Litres    *int64 `json:"litres"`
	FullTank  bool   `json:"fullTank"`
	Title     string `json:"title"`
}

// optVehicle is left out (no change), null (not for a vehicle) or a link.
type optVehicle struct {
	Set bool
	V   *vehicleLink
}

func (o *optVehicle) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.V = nil
		return nil
	}
	return json.Unmarshal(b, &o.V)
}

// txVehicleColumn returns each transaction's vehicle link as JSON, or NULL.
const txVehicleColumn = `(SELECT json_object('vehicleId', l.vehicle_id, 'kind', l.kind, 'odometer', l.odometer, 'litres', l.litres,
	'fullTank', json(CASE WHEN l.full_tank THEN 'true' ELSE 'false' END), 'title', l.title)
	FROM vehicle_logs l WHERE l.transaction_id = t.id)`

func (a *api) validateVehicleLink(ctx context.Context, uid int64, t *transaction, v *vehicleLink) error {
	if v == nil || t.Kind != "expense" {
		return nil
	}
	if v.Kind == "" {
		v.Kind = "expense"
	}
	if v.Kind != "fuel" && v.Kind != "service" && v.Kind != "expense" {
		return errValidation("Pick what this is for the vehicle")
	}
	if ok, err := a.owned(ctx, "vehicles", v.VehicleID, uid); err != nil {
		return err
	} else if !ok {
		return errValidation("Pick a vehicle")
	}
	if err := checkOdometer(v.Odometer); err != nil {
		return err
	}
	if v.Kind != "fuel" {
		v.Litres, v.FullTank = nil, false
	}
	if v.Litres != nil && (*v.Litres <= 0 || *v.Litres > 1_000_000) {
		return errValidation("That fuel amount doesn't look right")
	}
	var err error
	if v.Title, err = cleanText(v.Title, "Title", 80); err != nil {
		return err
	}
	return nil
}

// linkTxVehicle makes the vehicle log for expense id match t and v. With v
// nil (or t no longer an expense) the expense isn't for a vehicle any more.
func linkTxVehicle(ctx context.Context, db execer, uid, id int64, t transaction, v *vehicleLink) error {
	if v == nil || t.Kind != "expense" {
		_, err := db.ExecContext(ctx, `DELETE FROM vehicle_logs WHERE transaction_id = ? AND user_id = ?`, id, uid)
		return err
	}
	_, err := db.ExecContext(ctx, `INSERT INTO vehicle_logs (user_id, vehicle_id, kind, occurred_on, odometer, litres, full_tank, title, amount, note, transaction_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (transaction_id) DO UPDATE SET vehicle_id = excluded.vehicle_id, kind = excluded.kind, occurred_on = excluded.occurred_on,
			odometer = excluded.odometer, litres = excluded.litres, full_tank = excluded.full_tank, title = excluded.title,
			amount = excluded.amount, note = excluded.note`,
		uid, v.VehicleID, v.Kind, t.OccurredAt[:10], v.Odometer, v.Litres, v.FullTank, v.Title, t.Amount, t.Note, id)
	return err
}

// syncTxVehicle keeps an edited expense's vehicle log (if it has one) in step.
func syncTxVehicle(ctx context.Context, db execer, uid, id int64, t transaction) error {
	if t.Kind != "expense" {
		_, err := db.ExecContext(ctx, `DELETE FROM vehicle_logs WHERE transaction_id = ? AND user_id = ?`, id, uid)
		return err
	}
	_, err := db.ExecContext(ctx, `UPDATE vehicle_logs SET amount = ?, occurred_on = ?, note = ? WHERE transaction_id = ? AND user_id = ?`,
		t.Amount, t.OccurredAt[:10], t.Note, id, uid)
	return err
}

// ---- Documents ----

type docInput struct {
	VehicleID optID   `json:"vehicleId"`
	Type      *string `json:"type"`
	Title     *string `json:"title"`
	Number    *string `json:"number"`
	Issuer    *string `json:"issuer"`
	IssuedOn  *string `json:"issuedOn"`
	ExpiresOn *string `json:"expiresOn"` // "" means it doesn't expire
	Amount    *int64  `json:"amount"`
	Note      *string `json:"note"`
	// The account it was paid from: records the fee or premium in Money.
	AccountID optID `json:"accountId"`
}

func (in docInput) apply(d *vehicleDoc) error {
	var err error
	if in.VehicleID.Set {
		d.VehicleID = in.VehicleID.V
	}
	if in.Type != nil {
		d.Type = *in.Type
	}
	if _, ok := docTypes[d.Type]; !ok {
		return errValidation("Pick a document type")
	}
	if d.Type == "licence" {
		d.VehicleID = nil
	}
	if in.Title != nil {
		if d.Title, err = cleanText(*in.Title, "Name", 60); err != nil {
			return err
		}
	}
	if in.Number != nil {
		if d.Number, err = cleanText(*in.Number, "Number", 60); err != nil {
			return err
		}
	}
	if in.Issuer != nil {
		if d.Issuer, err = cleanText(*in.Issuer, "Issued by", 60); err != nil {
			return err
		}
	}
	if in.IssuedOn != nil {
		if d.IssuedOn, err = optDate(in.IssuedOn, "issue date"); err != nil {
			return err
		}
	}
	if in.ExpiresOn != nil {
		if d.ExpiresOn, err = optDate(in.ExpiresOn, "expiry date"); err != nil {
			return err
		}
	}
	if d.IssuedOn != nil && d.ExpiresOn != nil && *d.ExpiresOn < *d.IssuedOn {
		return errValidation("It can't expire before it was issued")
	}
	if in.Amount != nil {
		d.Amount = *in.Amount
	}
	if d.Amount < 0 || d.Amount > maxAmount {
		return errValidation("That amount doesn't look right")
	}
	if in.Note != nil {
		if d.Note, err = cleanText(*in.Note, "Note", 280); err != nil {
			return err
		}
	}
	return nil
}

func (d vehicleDoc) label() string {
	if d.Title != "" {
		return d.Title
	}
	return docTypes[d.Type]
}

func (a *api) saveDoc(ctx context.Context, uid int64, d vehicleDoc, accountID optID) (int64, error) {
	if d.VehicleID != nil {
		if ok, err := a.owned(ctx, "vehicles", *d.VehicleID, uid); err != nil {
			return 0, err
		} else if !ok {
			return 0, errValidation("Pick a vehicle")
		}
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	paid := d.TransactionID
	account := d.AccountID
	if accountID.Set {
		account = accountID.V
		if account == nil {
			// Not paid from an account any more. The expense stays in Money
			// (the money was spent), it's just not tied to this document.
			paid = nil
		}
	}
	if account != nil && (d.Amount > 0 || paid != nil) {
		date := time.Now().Format(dateLayout)
		if d.IssuedOn != nil && *d.IssuedOn <= date {
			date = *d.IssuedOn
		}
		id, err := a.pay(ctx, tx, uid, paid, payment{accountID: *account, amount: d.Amount, date: date, note: d.label(), logKind: "expense"})
		if err != nil {
			return 0, err
		}
		paid = &id
		var t transaction
		if t, err = scanTx(tx.QueryRowContext(ctx, `SELECT `+txColumns+` FROM transactions t WHERE t.id = ?`, id)); err != nil {
			return 0, err
		}
		// The premium counts as the vehicle's spending too.
		var link *vehicleLink
		if d.VehicleID != nil {
			link = &vehicleLink{VehicleID: *d.VehicleID, Kind: "expense", Title: d.label()}
		}
		if err := linkTxVehicle(ctx, tx, uid, id, t, link); err != nil {
			return 0, err
		}
	}

	id := d.ID
	if id == 0 {
		res, err := tx.ExecContext(ctx, `INSERT INTO vehicle_documents (user_id, vehicle_id, type, title, number, issuer, issued_on, expires_on, amount, note, transaction_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			uid, d.VehicleID, d.Type, d.Title, d.Number, d.Issuer, d.IssuedOn, d.ExpiresOn, d.Amount, d.Note, paid)
		if err != nil {
			return 0, err
		}
		id, _ = res.LastInsertId()
	} else if _, err := tx.ExecContext(ctx, `UPDATE vehicle_documents SET vehicle_id = ?, type = ?, title = ?, number = ?, issuer = ?, issued_on = ?, expires_on = ?,
		amount = ?, note = ?, transaction_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?`,
		d.VehicleID, d.Type, d.Title, d.Number, d.Issuer, d.IssuedOn, d.ExpiresOn, d.Amount, d.Note, paid, id, uid); err != nil {
		return 0, err
	}
	return id, tx.Commit()
}

func (a *api) respondDoc(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	list, err := a.loadVehicleDocs(r.Context(), uid, id)
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

func (a *api) createVehicleDoc(w http.ResponseWriter, r *http.Request, uid int64) {
	var in docInput
	if !readJSON(w, r, &in) {
		return
	}
	var d vehicleDoc
	if err := in.apply(&d); err != nil {
		respondErr(w, err)
		return
	}
	id, err := a.saveDoc(r.Context(), uid, d, in.AccountID)
	if err != nil {
		respondErr(w, err)
		return
	}
	a.respondDoc(w, r, uid, id, http.StatusCreated)
}

func (a *api) updateVehicleDoc(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in docInput
	if !readJSON(w, r, &in) {
		return
	}
	list, err := a.loadVehicleDocs(r.Context(), uid, id)
	if err != nil || len(list) == 0 {
		respondErr(w, cmpErr(err, sql.ErrNoRows))
		return
	}
	d := list[0]
	if err := in.apply(&d); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.saveDoc(r.Context(), uid, d, in.AccountID); err != nil {
		respondErr(w, err)
		return
	}
	a.respondDoc(w, r, uid, id, http.StatusOK)
}

// deleteVehicleDoc removes the document and its file. What was paid for it
// stays in Money.
func (a *api) deleteVehicleDoc(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ctx := r.Context()
	keys, err := a.fileKeys(ctx, `SELECT file_key FROM vehicle_documents WHERE id = ? AND user_id = ? AND file_key != ''`, id, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	if _, err := a.db.ExecContext(ctx, `DELETE FROM vehicle_documents WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	removeFiles(keys)
	w.WriteHeader(http.StatusNoContent)
}

// ---- Document files ----

const maxDocFile = 15 << 20

var docFileTypes = map[string]string{
	"application/pdf": ".pdf",
	"image/jpeg":      ".jpg",
	"image/png":       ".png",
	"image/webp":      ".webp",
	"image/heic":      ".heic",
	"image/heif":      ".heif",
}

func (a *api) fileKeys(ctx context.Context, q string, args ...any) ([]string, error) {
	rows, err := a.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// removeFiles deletes files from the bucket after their rows are gone. A
// failure only leaves an unreachable file behind, so it's logged, not shown.
func removeFiles(keys []string) {
	b := fileBucket()
	if b == nil || len(keys) == 0 {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, k := range keys {
			if err := b.remove(ctx, k); err != nil {
				log.Printf("storage: remove %s: %v", k, err)
			}
		}
	}()
}

// uploadDocFile streams the file in the "file" form field to the bucket,
// replacing the document's previous file.
func (a *api) uploadDocFile(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	b := fileBucket()
	if b == nil {
		writeError(w, http.StatusServiceUnavailable, "File storage isn't set up on this Kosh yet")
		return
	}
	ctx := r.Context()
	var old string
	if err := a.db.QueryRowContext(ctx, `SELECT file_key FROM vehicle_documents WHERE id = ? AND user_id = ?`, id, uid).Scan(&old); err != nil {
		respondErr(w, err)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxDocFile+64<<10)
	mr, err := r.MultipartReader()
	if err != nil {
		writeError(w, http.StatusBadRequest, "Send the file as a form upload")
		return
	}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			writeError(w, http.StatusBadRequest, "No file was sent")
			return
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, "The upload didn't finish. Try again.")
			return
		}
		if part.FormName() != "file" {
			part.Close()
			continue
		}
		contentType, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
		ext, ok := docFileTypes[contentType]
		if !ok {
			writeError(w, http.StatusBadRequest, "Add a photo or a PDF")
			return
		}
		name := strings.TrimSpace(filepath.Base(part.FileName()))
		if name == "" || name == "." || utf8.RuneCountInString(name) > 120 {
			name = "document" + ext
		}
		key := "documents/" + randomKey() + ext
		counted := &countingReader{r: part}
		if err := b.put(ctx, key, contentType, counted); err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) || counted.n > maxDocFile {
				writeError(w, http.StatusRequestEntityTooLarge, "That file is over 15 MB")
				return
			}
			serverError(w, err)
			return
		}
		if _, err := a.db.ExecContext(ctx, `UPDATE vehicle_documents SET file_key = ?, file_name = ?, file_type = ?, file_size = ?,
			updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?`, key, name, contentType, counted.n, id, uid); err != nil {
			removeFiles([]string{key})
			serverError(w, err)
			return
		}
		if old != "" {
			removeFiles([]string{old})
		}
		a.respondDoc(w, r, uid, id, http.StatusOK)
		return
	}
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

func randomKey() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// openDocFile sends the browser to a short-lived link to the file.
func (a *api) openDocFile(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var key, name, contentType string
	if err := a.db.QueryRowContext(r.Context(), `SELECT file_key, file_name, file_type FROM vehicle_documents WHERE id = ? AND user_id = ?`, id, uid).
		Scan(&key, &name, &contentType); err != nil {
		respondErr(w, err)
		return
	}
	b := fileBucket()
	if key == "" || b == nil {
		writeError(w, http.StatusNotFound, "This document has no file")
		return
	}
	url, err := b.link(r.Context(), key, name, contentType)
	if err != nil {
		serverError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, url, http.StatusFound)
}

func (a *api) deleteDocFile(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	ctx := r.Context()
	keys, err := a.fileKeys(ctx, `SELECT file_key FROM vehicle_documents WHERE id = ? AND user_id = ? AND file_key != ''`, id, uid)
	if err != nil {
		serverError(w, err)
		return
	}
	if _, err := a.db.ExecContext(ctx, `UPDATE vehicle_documents SET file_key = '', file_name = '', file_type = '', file_size = 0,
		updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	removeFiles(keys)
	a.respondDoc(w, r, uid, id, http.StatusOK)
}
