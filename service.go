package main

import (
	"context"
	"math"
	"net/http"
	"strings"
	"time"
)

// Service schedules: "oil change every 3,000 km or 6 months, whichever comes
// first". A rule is done by the newest service log whose title mentions it
// ("General service, Oil change" does both). From there the next one is due
// at last km + every_km, or last date + every_months; with enough odometer
// readings Kosh also guesses the date you'll reach that km.
//
// What's due is worked out here, so the screens and the reminders (push and
// calendar) always agree.

type serviceRule struct {
	ID          int64  `json:"id"`
	VehicleID   int64  `json:"vehicleId"`
	Title       string `json:"title"`
	EveryKm     *int64 `json:"everyKm"`
	EveryMonths *int64 `json:"everyMonths"`
	// Worked out:
	LastOn  *string `json:"lastOn"`  // when it was last done
	LastKm  *int64  `json:"lastKm"`  // at what reading
	NextKm  *int64  `json:"nextKm"`  // due at this reading
	KmLeft  *int64  `json:"kmLeft"`  // to go; negative means past it
	NextOn  *string `json:"nextOn"`  // due by this date (from every_months)
	GuessOn *string `json:"guessOn"` // when you'll likely reach nextKm
	State   string  `json:"state"`   // overdue, soon, ok or unknown (never logged)
}

type ruleVehicle struct {
	odometer *int64
	perDay   float64 // average km a day, 0 when unknown
}

// soonKm is how close to the km mark counts as due soon.
func soonKm(every int64) int64 {
	return max(300, every/10)
}

const soonDays = 30

func addMonths(date string, months int64) string {
	t, err := time.Parse(dateLayout, date)
	if err != nil {
		return date
	}
	return t.AddDate(0, int(months), 0).Format(dateLayout)
}

// loadServiceRules returns uid's rules with what's due, as of today.
func (a *api) loadServiceRules(ctx context.Context, uid int64, today time.Time) ([]serviceRule, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT id, vehicle_id, title, every_km, every_months FROM service_rules WHERE user_id = ? ORDER BY vehicle_id, id`, uid)
	if err != nil {
		return nil, err
	}
	var rules []serviceRule
	for rows.Next() {
		var r serviceRule
		if err := rows.Scan(&r.ID, &r.VehicleID, &r.Title, &r.EveryKm, &r.EveryMonths); err != nil {
			rows.Close()
			return nil, err
		}
		rules = append(rules, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(rules) == 0 {
		return []serviceRule{}, err
	}

	// Each vehicle's reading and pace, and its service history.
	logs, err := a.loadVehicleLogs(ctx, uid, 0)
	if err != nil {
		return nil, err
	}
	vehicles := map[int64]*ruleVehicle{}
	type reading struct {
		on string
		km int64
	}
	readings := map[int64][]reading{}
	for _, l := range logs {
		if l.Odometer != nil {
			readings[l.VehicleID] = append(readings[l.VehicleID], reading{l.OccurredOn, *l.Odometer})
		}
	}
	for id, rs := range readings {
		v := &ruleVehicle{}
		first, last := rs[len(rs)-1], rs[0] // logs come newest first
		hi := rs[0].km
		for _, x := range rs {
			hi = max(hi, x.km)
		}
		v.odometer = &hi
		t1, _ := time.Parse(dateLayout, first.on)
		t2, _ := time.Parse(dateLayout, last.on)
		if days := t2.Sub(t1).Hours() / 24; days >= 14 && last.km > first.km {
			v.perDay = float64(last.km-first.km) / days
		}
		vehicles[id] = v
	}

	todayStr := today.Format(dateLayout)
	for i := range rules {
		r := &rules[i]
		want := strings.ToLower(r.Title)
		for _, l := range logs { // newest first
			if l.VehicleID != r.VehicleID || l.Kind != "service" {
				continue
			}
			title := strings.ToLower(l.Title)
			if strings.Contains(title, want) || (title == "" && want == "general service") {
				on := l.OccurredOn
				r.LastOn = &on
				r.LastKm = l.Odometer
				break
			}
		}
		if r.LastOn == nil {
			r.State = "unknown"
			continue
		}
		v := vehicles[r.VehicleID]
		r.State = "ok"
		if r.EveryKm != nil && r.LastKm != nil {
			next := *r.LastKm + *r.EveryKm
			r.NextKm = &next
			if v != nil && v.odometer != nil {
				left := next - *v.odometer
				r.KmLeft = &left
				if left < 0 {
					r.State = "overdue"
				} else if left <= soonKm(*r.EveryKm) {
					r.State = "soon"
				}
				if v.perDay > 0 && left > 0 {
					g := today.AddDate(0, 0, int(math.Ceil(float64(left)/v.perDay))).Format(dateLayout)
					r.GuessOn = &g
				}
			}
		}
		if r.EveryMonths != nil {
			next := addMonths(*r.LastOn, *r.EveryMonths)
			r.NextOn = &next
			if next < todayStr {
				r.State = "overdue"
			} else if next <= today.AddDate(0, 0, soonDays).Format(dateLayout) && r.State == "ok" {
				r.State = "soon"
			}
		}
		if r.State == "ok" && r.GuessOn != nil && *r.GuessOn <= today.AddDate(0, 0, 14).Format(dateLayout) {
			r.State = "soon"
		}
	}
	return rules, nil
}

// dueOn is the date a rule is next due: the earlier of its date and the
// day you're likely to reach its km. Empty when there's no telling.
func (r serviceRule) dueOn() string {
	d := ""
	for _, x := range []*string{r.NextOn, r.GuessOn} {
		if x != nil && (d == "" || *x < d) {
			d = *x
		}
	}
	return d
}

type ruleInput struct {
	VehicleID   *int64  `json:"vehicleId"`
	Title       *string `json:"title"`
	EveryKm     optID   `json:"everyKm"`
	EveryMonths optID   `json:"everyMonths"`
}

func (in ruleInput) apply(r *serviceRule) error {
	if in.VehicleID != nil {
		r.VehicleID = *in.VehicleID
	}
	if in.Title != nil {
		r.Title = *in.Title
	}
	var err error
	if r.Title, err = cleanName(r.Title, "What to do", 40); err != nil {
		return err
	}
	if strings.Contains(r.Title, ",") {
		return errValidation("Make one schedule for each job")
	}
	if in.EveryKm.Set {
		r.EveryKm = in.EveryKm.V
	}
	if in.EveryMonths.Set {
		r.EveryMonths = in.EveryMonths.V
	}
	if r.EveryKm != nil && (*r.EveryKm <= 0 || *r.EveryKm > 1_000_000) {
		return errValidation("Enter how many km between them")
	}
	if r.EveryMonths != nil && (*r.EveryMonths <= 0 || *r.EveryMonths > 240) {
		return errValidation("Enter how many months between them")
	}
	if r.EveryKm == nil && r.EveryMonths == nil {
		return errValidation("Set km, months or both")
	}
	return nil
}

func (a *api) createServiceRule(w http.ResponseWriter, r *http.Request, uid int64) {
	var in ruleInput
	if !readJSON(w, r, &in) {
		return
	}
	var x serviceRule
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	if ok, err := a.owned(r.Context(), "vehicles", x.VehicleID, uid); err != nil {
		serverError(w, err)
		return
	} else if !ok {
		respondErr(w, errValidation("Pick a vehicle"))
		return
	}
	res, err := a.db.ExecContext(r.Context(), `INSERT INTO service_rules (user_id, vehicle_id, title, every_km, every_months) VALUES (?, ?, ?, ?, ?)`,
		uid, x.VehicleID, x.Title, x.EveryKm, x.EveryMonths)
	if err != nil {
		serverError(w, err)
		return
	}
	id, _ := res.LastInsertId()
	a.respondRule(w, r, uid, id, http.StatusCreated)
}

func (a *api) respondRule(w http.ResponseWriter, r *http.Request, uid, id int64, status int) {
	rules, err := a.loadServiceRules(r.Context(), uid, time.Now())
	if err != nil {
		serverError(w, err)
		return
	}
	for _, x := range rules {
		if x.ID == id {
			writeJSON(w, status, x)
			return
		}
	}
	writeError(w, http.StatusNotFound, "not found")
}

func (a *api) updateServiceRule(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in ruleInput
	if !readJSON(w, r, &in) {
		return
	}
	var x serviceRule
	err := a.db.QueryRowContext(r.Context(), `SELECT vehicle_id, title, every_km, every_months FROM service_rules WHERE id = ? AND user_id = ?`, id, uid).
		Scan(&x.VehicleID, &x.Title, &x.EveryKm, &x.EveryMonths)
	if err != nil {
		respondErr(w, err)
		return
	}
	in.VehicleID = nil // a schedule stays with its vehicle
	if err := in.apply(&x); err != nil {
		respondErr(w, err)
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `UPDATE service_rules SET title = ?, every_km = ?, every_months = ? WHERE id = ? AND user_id = ?`,
		x.Title, x.EveryKm, x.EveryMonths, id, uid); err != nil {
		serverError(w, err)
		return
	}
	a.respondRule(w, r, uid, id, http.StatusOK)
}

func (a *api) deleteServiceRule(w http.ResponseWriter, r *http.Request, uid int64) {
	id, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM service_rules WHERE id = ? AND user_id = ?`, id, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
