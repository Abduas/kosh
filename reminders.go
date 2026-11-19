package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Reminders before papers expire and services fall due, two ways:
//
//   - Web Push to each phone that turned notifications on (an installed app
//     on iPhone, iOS 16.4 or later). The daily vehicle-reminders job sends
//     them; reminders_sent keeps it from saying the same thing twice, so a
//     retried or catch-up run is harmless.
//   - A private calendar feed (.ics) to subscribe to in the phone's
//     calendar, which then alerts on its own.
//
// Push needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (and optionally
// VAPID_SUBJECT, a URL or email for push services to contact) set in the
// Sideyard dashboard.

type vapidKeys struct{ public, private, subject string }

func vapid() (vapidKeys, bool) {
	k := vapidKeys{os.Getenv("VAPID_PUBLIC_KEY"), os.Getenv("VAPID_PRIVATE_KEY"), os.Getenv("VAPID_SUBJECT")}
	if k.subject == "" {
		k.subject = "https://github.com/Abduas/kosh"
	}
	return k, k.public != "" && k.private != ""
}

// reminderZone is where "today" is for reminders: India, where Kosh's users are.
var reminderZone = func() *time.Location {
	if l, err := time.LoadLocation("Asia/Kolkata"); err == nil {
		return l
	}
	return time.FixedZone("IST", 5*3600+1800)
}()

func reminderToday() time.Time {
	n := time.Now().In(reminderZone)
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

// ---- Phones ----

func (a *api) pushStatus(w http.ResponseWriter, r *http.Request, uid int64) {
	k, ok := vapid()
	var n int
	if err := a.db.QueryRowContext(r.Context(), `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`, uid).Scan(&n); err != nil {
		serverError(w, err)
		return
	}
	out := map[string]any{"available": ok, "devices": n}
	if ok {
		out["publicKey"] = k.public
	}
	writeJSON(w, http.StatusOK, out)
}

type pushSub struct {
	Endpoint string `json:"endpoint"`
	Keys     struct {
		P256dh string `json:"p256dh"`
		Auth   string `json:"auth"`
	} `json:"keys"`
}

func (a *api) subscribePush(w http.ResponseWriter, r *http.Request, uid int64) {
	var in pushSub
	if !readJSON(w, r, &in) {
		return
	}
	if !strings.HasPrefix(in.Endpoint, "https://") || len(in.Endpoint) > 1000 || in.Keys.P256dh == "" || in.Keys.Auth == "" || len(in.Keys.P256dh) > 200 || len(in.Keys.Auth) > 100 {
		writeError(w, http.StatusBadRequest, "That subscription doesn't look right")
		return
	}
	// The same phone signing in as someone else moves to them.
	if _, err := a.db.ExecContext(r.Context(), `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
		ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
		uid, in.Endpoint, in.Keys.P256dh, in.Keys.Auth); err != nil {
		serverError(w, err)
		return
	}
	a.pushStatus(w, r, uid)
}

func (a *api) unsubscribePush(w http.ResponseWriter, r *http.Request, uid int64) {
	var in struct {
		Endpoint string `json:"endpoint"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`, uid, in.Endpoint); err != nil {
		serverError(w, err)
		return
	}
	a.pushStatus(w, r, uid)
}

func (a *api) testPush(w http.ResponseWriter, r *http.Request, uid int64) {
	n, err := sendPush(r.Context(), a.db, uid, notice{Title: "Reminders are on", Body: "Kosh will tell you here before a paper expires or a service is due.", URL: "/due", Tag: "test"})
	if err != nil {
		respondErr(w, err)
		return
	}
	if n == 0 {
		writeError(w, http.StatusBadRequest, "No phone is set up for notifications")
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"sent": n})
}

// pushClient sends to push services; tests swap in their own.
var pushClient webpush.HTTPClient = &http.Client{Timeout: 20 * time.Second}

type notice struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

// sendPush delivers n to each of uid's phones and returns how many took it.
// Phones whose subscription has gone (app removed, permission revoked) are
// forgotten.
func sendPush(ctx context.Context, db *sql.DB, uid int64, n notice) (int, error) {
	k, ok := vapid()
	if !ok {
		return 0, errValidation("Notifications aren't set up on this Kosh")
	}
	rows, err := db.QueryContext(ctx, `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`, uid)
	if err != nil {
		return 0, err
	}
	type sub struct {
		id int64
		s  webpush.Subscription
	}
	var subs []sub
	for rows.Next() {
		var x sub
		if err := rows.Scan(&x.id, &x.s.Endpoint, &x.s.Keys.P256dh, &x.s.Keys.Auth); err != nil {
			rows.Close()
			return 0, err
		}
		subs = append(subs, x)
	}
	rows.Close()
	payload, _ := json.Marshal(n)
	sent := 0
	var lastErr error
	for _, x := range subs {
		res, err := webpush.SendNotificationWithContext(ctx, payload, &x.s, &webpush.Options{
			Subscriber:      k.subject,
			VAPIDPublicKey:  k.public,
			VAPIDPrivateKey: k.private,
			TTL:             24 * 3600,
			Urgency:         webpush.UrgencyNormal,
			Topic:           n.Tag,
			HTTPClient:      pushClient,
		})
		if err != nil {
			lastErr = err
			continue
		}
		res.Body.Close()
		switch {
		case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusGone:
			db.ExecContext(ctx, `DELETE FROM push_subscriptions WHERE id = ?`, x.id)
		case res.StatusCode >= 200 && res.StatusCode < 300:
			sent++
		default:
			lastErr = fmt.Errorf("push service answered %d", res.StatusCode)
		}
	}
	if sent == 0 && lastErr != nil {
		return 0, lastErr
	}
	return sent, nil
}

// ---- What's due ----

type reminder struct {
	key   string // what was said, so it's said once
	title string
	body  string
	url   string
	on    string // the day it's about, for the calendar
}

// currentDocsGo keeps the paper in force for each vehicle and type: the one
// that runs latest. (The frontend does the same in currentDocs.)
func currentDocsGo(docs []vehicleDoc) []vehicleDoc {
	best := map[string]vehicleDoc{}
	var order []string
	rank := func(d vehicleDoc) string {
		if d.ExpiresOn == nil {
			return "9999-12-31"
		}
		return *d.ExpiresOn
	}
	for _, d := range docs {
		v := int64(0)
		if d.VehicleID != nil {
			v = *d.VehicleID
		}
		k := fmt.Sprintf("%d:%s", v, d.Type)
		if d.Type == "other" || d.Type == "warranty" {
			k += fmt.Sprintf(":%d", d.ID)
		}
		cur, ok := best[k]
		if !ok {
			order = append(order, k)
		}
		if !ok || rank(d) > rank(cur) || (rank(d) == rank(cur) && d.ID > cur.ID) {
			best[k] = d
		}
	}
	out := make([]vehicleDoc, 0, len(order))
	for _, k := range order {
		out = append(out, best[k])
	}
	return out
}

func shortDate(date string) string {
	t, err := time.Parse(dateLayout, date)
	if err != nil {
		return date
	}
	return t.Format("2 Jan")
}

func plural(n int64, one, many string) string {
	if n == 1 || n == -1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

func formatKm(n int64) string {
	s := fmt.Sprint(n)
	if len(s) <= 3 {
		return s + " km"
	}
	// Indian grouping: 1,23,456
	head, tail := s[:len(s)-3], s[len(s)-3:]
	var parts []string
	for len(head) > 2 {
		parts = append([]string{head[len(head)-2:]}, parts...)
		head = head[:len(head)-2]
	}
	parts = append([]string{head}, parts...)
	return strings.Join(parts, ",") + "," + tail + " km"
}

// dueReminders lists what uid should hear about today, most urgent first.
func (a *api) dueReminders(ctx context.Context, uid int64, today time.Time) ([]reminder, error) {
	vehicles, err := a.loadVehicles(ctx, uid, 0)
	if err != nil {
		return nil, err
	}
	names := map[int64]vehicle{}
	for _, v := range vehicles {
		names[v.ID] = v
	}
	docs, err := a.loadVehicleDocs(ctx, uid, 0)
	if err != nil {
		return nil, err
	}
	type ranked struct {
		reminder
		days int
	}
	var out []ranked
	todayStr := today.Format(dateLayout)
	for _, d := range currentDocsGo(docs) {
		if d.ExpiresOn == nil {
			continue
		}
		var v vehicle
		if d.VehicleID != nil {
			var ok bool
			if v, ok = names[*d.VehicleID]; !ok || v.Archived {
				continue
			}
		}
		exp, err := time.Parse(dateLayout, *d.ExpiresOn)
		if err != nil {
			continue
		}
		days := int(exp.Sub(today).Hours() / 24)
		var bucket, when string
		switch {
		case days < 0 && -days/7 <= 4: // then weekly for a month
			bucket = fmt.Sprintf("expired-%d", -days/7)
			when = fmt.Sprintf("expired %s ago", plural(int64(-days), "day", "days"))
		case days < 0:
			continue
		case days == 0:
			bucket, when = "0", "expires today"
		case days == 1:
			bucket, when = "1", "expires tomorrow"
		case days <= 7:
			bucket, when = "7", fmt.Sprintf("expires in %d days, on %s", days, shortDate(*d.ExpiresOn))
		case days <= 30:
			bucket, when = "30", fmt.Sprintf("expires in %d days, on %s", days, shortDate(*d.ExpiresOn))
		default:
			continue
		}
		label := d.label()
		if d.Type == "puc" {
			label = "PUC"
		}
		subject := label
		if v.ID != 0 {
			subject = v.Name + " " + label
		}
		out = append(out, ranked{reminder{
			key:   fmt.Sprintf("doc:%d:%s:%s", d.ID, *d.ExpiresOn, bucket),
			title: fmt.Sprintf("%s %s", subject, when),
			body:  "Renew it, then add the new one in Kosh.",
			url:   "/due",
			on:    *d.ExpiresOn,
		}, days})
	}

	rules, err := a.loadServiceRules(ctx, uid, today)
	if err != nil {
		return nil, err
	}
	kmRules := map[int64]bool{}
	for _, r := range rules {
		v, ok := names[r.VehicleID]
		if !ok || v.Archived {
			continue
		}
		if r.EveryKm != nil {
			kmRules[r.VehicleID] = true
		}
		if r.State != "overdue" && r.State != "soon" {
			continue
		}
		var when string
		switch {
		case r.KmLeft != nil && *r.KmLeft < 0:
			when = "overdue by " + formatKm(-*r.KmLeft)
		case r.NextOn != nil && *r.NextOn < todayStr:
			when = "overdue since " + shortDate(*r.NextOn)
		case r.KmLeft != nil && r.EveryKm != nil && *r.KmLeft <= soonKm(*r.EveryKm):
			when = "due in " + formatKm(*r.KmLeft)
		case r.dueOn() != "":
			when = "due by " + shortDate(r.dueOn())
		default:
			when = "due soon"
		}
		days := 0
		if r.State == "soon" {
			days = 10
		}
		out = append(out, ranked{reminder{
			key:   fmt.Sprintf("svc:%d:%s:%s", r.ID, *r.LastOn, r.State),
			title: fmt.Sprintf("%s: %s %s", v.Name, r.Title, when),
			body:  "Log it in Kosh once it's done, and the next one is worked out from there.",
			url:   fmt.Sprintf("/garage/%d", v.ID),
		}, days})
	}

	// Due-by-km needs fresh readings: ask now and then.
	year, week := today.ISOWeek()
	for id := range kmRules {
		v := names[id]
		if v.OdometerOn != nil && *v.OdometerOn >= today.AddDate(0, 0, -21).Format(dateLayout) {
			continue
		}
		out = append(out, ranked{reminder{
			key:   fmt.Sprintf("odo:%d:%d-%d", id, year, week),
			title: fmt.Sprintf("What's the odometer on %s?", v.Name),
			body:  "A quick reading keeps service reminders on time.",
			url:   fmt.Sprintf("/garage/%d", id),
		}, 60})
	}

	slices.SortStableFunc(out, func(x, y ranked) int { return x.days - y.days })
	res := make([]reminder, len(out))
	for i, x := range out {
		res[i] = x.reminder
	}
	return res, nil
}

// vehicleReminders is the daily job: suggested schedule 9:00 in India,
// "CRON_TZ=Asia/Kolkata 0 9 * * *".
func vehicleReminders(ctx context.Context, db *sql.DB) (string, error) {
	if _, ok := vapid(); !ok {
		return "notifications aren't set up (no VAPID keys)", nil
	}
	a := &api{db: db}
	rows, err := db.QueryContext(ctx, `SELECT DISTINCT u.id, u.prefs FROM users u JOIN push_subscriptions p ON p.user_id = u.id`)
	if err != nil {
		return "", err
	}
	type person struct {
		id    int64
		prefs string
	}
	var people []person
	for rows.Next() {
		var p person
		if err := rows.Scan(&p.id, &p.prefs); err != nil {
			rows.Close()
			return "", err
		}
		people = append(people, p)
	}
	rows.Close()

	today := reminderToday()
	var sentPeople, sentItems int
	var failures []string
	for _, p := range people {
		var prefs struct {
			Modules []string `json:"modules"`
		}
		json.Unmarshal([]byte(p.prefs), &prefs)
		if !slices.Contains(prefs.Modules, "vehicles") {
			continue
		}
		items, err := a.dueReminders(ctx, p.id, today)
		if err != nil {
			return "", err
		}
		var fresh []reminder
		for _, it := range items {
			var seen int
			if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM reminders_sent WHERE user_id = ? AND key = ?`, p.id, it.key).Scan(&seen); err != nil {
				return "", err
			}
			if seen == 0 {
				fresh = append(fresh, it)
			}
		}
		if len(fresh) == 0 {
			continue
		}
		n := notice{Title: fresh[0].title, Body: fresh[0].body, URL: fresh[0].url, Tag: "vehicles"}
		if len(fresh) > 1 {
			titles := make([]string, 0, 3)
			for _, it := range fresh[:min(3, len(fresh))] {
				titles = append(titles, it.title)
			}
			n = notice{Title: fmt.Sprintf("%d things for your vehicles", len(fresh)), Body: strings.Join(titles, " · "), URL: "/due", Tag: "vehicles"}
		}
		got, err := sendPush(ctx, db, p.id, n)
		if err != nil || got == 0 {
			failures = append(failures, fmt.Sprintf("user %d: %v", p.id, err))
			continue
		}
		for _, it := range fresh {
			if _, err := db.ExecContext(ctx, `INSERT OR IGNORE INTO reminders_sent (user_id, key) VALUES (?, ?)`, p.id, it.key); err != nil {
				return "", err
			}
		}
		sentPeople++
		sentItems += len(fresh)
	}
	// Old records are only needed while their bucket can still come up.
	db.ExecContext(ctx, `DELETE FROM reminders_sent WHERE sent_at < ?`, time.Now().AddDate(0, -6, 0).UTC().Format(timeLayout))
	out := fmt.Sprintf("sent %d reminders to %d people", sentItems, sentPeople)
	if len(failures) > 0 {
		out += "; failed: " + strings.Join(failures, "; ")
		if sentPeople == 0 {
			return "", errors.New(out)
		}
	}
	return out, nil
}

// ---- Calendar feed ----

func (a *api) calendarLink(w http.ResponseWriter, r *http.Request, uid int64) {
	var token string
	err := a.db.QueryRowContext(r.Context(), `SELECT token FROM calendar_keys WHERE user_id = ?`, uid).Scan(&token)
	if errors.Is(err, sql.ErrNoRows) {
		token = randomKey() + randomKey()[:8]
		_, err = a.db.ExecContext(r.Context(), `INSERT INTO calendar_keys (user_id, token) VALUES (?, ?)`, uid, token)
	}
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": "/api/calendar/" + token + ".ics"})
}

// resetCalendar stops the old link working; the next one is new.
func (a *api) resetCalendar(w http.ResponseWriter, r *http.Request, uid int64) {
	if _, err := a.db.ExecContext(r.Context(), `DELETE FROM calendar_keys WHERE user_id = ?`, uid); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func icsText(s string) string {
	return strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\n", `\n`, "\r", "").Replace(s)
}

// icsLine folds a content line at 75 octets, as calendars expect.
func icsLine(b *strings.Builder, line string) {
	for len(line) > 75 {
		cut := 75
		for cut > 0 && line[cut]&0xC0 == 0x80 { // don't split a UTF-8 character
			cut--
		}
		b.WriteString(line[:cut] + "\r\n ")
		line = line[cut:]
	}
	b.WriteString(line + "\r\n")
}

// calendarFeed serves the .ics: each paper's expiry and each service's due
// date, with alerts a week and a day before. The token in the link is the
// only key, as calendar apps can't sign in.
func (a *api) calendarFeed(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSuffix(r.PathValue("token"), ".ics")
	var uid int64
	if err := a.db.QueryRowContext(r.Context(), `SELECT user_id FROM calendar_keys WHERE token = ?`, token).Scan(&uid); err != nil {
		http.NotFound(w, r)
		return
	}
	ctx := r.Context()
	vehicles, err := a.loadVehicles(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	names := map[int64]vehicle{}
	for _, v := range vehicles {
		names[v.ID] = v
	}
	docs, err := a.loadVehicleDocs(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	rules, err := a.loadServiceRules(ctx, uid, reminderToday())
	if err != nil {
		serverError(w, err)
		return
	}

	var b strings.Builder
	stamp := time.Now().UTC().Format("20060102T150405Z")
	for _, l := range []string{"BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kosh//Vehicles//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
		"X-WR-CALNAME:Kosh · Vehicles", "X-PUBLISHED-TTL:PT12H", "REFRESH-INTERVAL;VALUE=DURATION:PT12H"} {
		icsLine(&b, l)
	}
	event := func(uidKey, date, summary, desc string) {
		t, err := time.Parse(dateLayout, date)
		if err != nil {
			return
		}
		icsLine(&b, "BEGIN:VEVENT")
		icsLine(&b, "UID:"+uidKey+"@kosh")
		icsLine(&b, "DTSTAMP:"+stamp)
		icsLine(&b, "DTSTART;VALUE=DATE:"+t.Format("20060102"))
		icsLine(&b, "DTEND;VALUE=DATE:"+t.AddDate(0, 0, 1).Format("20060102"))
		icsLine(&b, "SUMMARY:"+icsText(summary))
		if desc != "" {
			icsLine(&b, "DESCRIPTION:"+icsText(desc))
		}
		icsLine(&b, "TRANSP:TRANSPARENT")
		// 9 am a week before, and 9 am the day before.
		for _, trig := range []string{"-P6DT15H", "-PT15H"} {
			icsLine(&b, "BEGIN:VALARM")
			icsLine(&b, "ACTION:DISPLAY")
			icsLine(&b, "DESCRIPTION:"+icsText(summary))
			icsLine(&b, "TRIGGER:"+trig)
			icsLine(&b, "END:VALARM")
		}
		icsLine(&b, "END:VEVENT")
	}
	for _, d := range currentDocsGo(docs) {
		if d.ExpiresOn == nil {
			continue
		}
		subject := d.label()
		if d.VehicleID != nil {
			v, ok := names[*d.VehicleID]
			if !ok || v.Archived {
				continue
			}
			subject = v.Name + " " + subject
		}
		desc := strings.Trim(strings.Join([]string{d.Issuer, d.Number}, " "), " ")
		event(fmt.Sprintf("doc-%d-%s", d.ID, *d.ExpiresOn), *d.ExpiresOn, subject+" expires", desc)
	}
	for _, rl := range rules {
		v, ok := names[rl.VehicleID]
		due := rl.dueOn()
		if !ok || v.Archived || due == "" {
			continue
		}
		desc := ""
		if rl.NextKm != nil {
			desc = "At " + formatKm(*rl.NextKm)
			if rl.GuessOn != nil && (rl.NextOn == nil || *rl.GuessOn < *rl.NextOn) {
				desc += " (date guessed from how much you drive)"
			}
		}
		event(fmt.Sprintf("svc-%d", rl.ID), due, v.Name+": "+rl.Title+" due", desc)
	}
	icsLine(&b, "END:VCALENDAR")
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write([]byte(b.String()))
}
