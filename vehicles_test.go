package main

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type garage struct {
	Vehicles  []vehicle    `json:"vehicles"`
	Logs      []vehicleLog `json:"logs"`
	Documents []vehicleDoc `json:"documents"`
	Storage   bool         `json:"storage"`
}

type txWithVehicle struct {
	ID         int64        `json:"id"`
	Amount     int64        `json:"amount"`
	CategoryID *int64       `json:"categoryId"`
	Vehicle    *vehicleLink `json:"vehicle"`
}

func TestVehicles(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "password123"}, 201, nil)

	var boot struct {
		Accounts   []account  `json:"accounts"`
		Categories []category `json:"categories"`
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	cash := boot.Accounts[0].ID
	var fuelCat int64
	for _, c := range boot.Categories {
		if c.Name == "Fuel" {
			fuelCat = c.ID
		}
	}

	// Modules.
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"modules": []string{"finance", "vehicles"}}}, 200, nil)
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"modules": []string{}}}, 400, nil)
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"modules": []string{"vehicles", "vehicles"}}}, 400, nil)
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"modules": []string{"boats"}}}, 400, nil)

	// A vehicle, with today's odometer as its first reading.
	me.do("POST", "/api/vehicles", map[string]any{"kind": "bike", "name": "", "color": "#3B82F6"}, 400, nil)
	me.do("POST", "/api/vehicles", map[string]any{"kind": "bike", "name": "Pulsar", "color": "#3B82F6", "regNumber": "KA 01 / AB"}, 400, nil)
	var bike vehicle
	me.do("POST", "/api/vehicles", map[string]any{"kind": "bike", "name": "Pulsar", "color": "#3B82F6", "regNumber": "ka-01 ab 1234", "odometer": 12000}, 201, &bike)
	if bike.RegNumber != "KA01AB1234" || bike.Odometer == nil || *bike.Odometer != 12000 || bike.Fuel != "petrol" {
		t.Fatalf("vehicle = %+v", bike)
	}

	// Fuel from the add-transaction sheet, for the bike.
	var fill txWithVehicle
	me.do("POST", "/api/transactions", map[string]any{
		"kind": "expense", "amount": 500_00, "accountId": cash, "categoryId": fuelCat, "note": "HP pump", "occurredAt": "2026-11-10T09:30",
		"vehicle": map[string]any{"vehicleId": bike.ID, "kind": "fuel", "odometer": 12250, "litres": 4500, "fullTank": true},
	}, 201, &fill)
	if fill.Vehicle == nil || fill.Vehicle.VehicleID != bike.ID || fill.Vehicle.Litres == nil || *fill.Vehicle.Litres != 4500 || !fill.Vehicle.FullTank {
		t.Fatalf("transaction vehicle = %+v", fill.Vehicle)
	}
	var g garage
	fuelLog := func() vehicleLog {
		for _, l := range g.Logs {
			if l.Kind == "fuel" {
				return l
			}
		}
		t.Fatalf("no fuel log in %+v", g.Logs)
		return vehicleLog{}
	}
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if l := fuelLog(); len(g.Logs) != 2 || l.Amount != 500_00 || l.OccurredOn != "2026-11-10" || l.AccountID == nil || *l.AccountID != cash {
		t.Fatalf("logs = %+v", g.Logs)
	}

	// Someone else's vehicle can't be used.
	other := newClient(t, srv)
	other.do("POST", "/api/auth/signup", map[string]string{"name": "Sara", "username": "sara", "password": "password456"}, 201, nil)
	other.do("PATCH", fmt.Sprintf("/api/vehicles/%d", bike.ID), map[string]any{"name": "Mine"}, 404, nil)
	var otherBoot struct {
		Accounts []account `json:"accounts"`
	}
	other.do("GET", "/api/bootstrap", nil, 200, &otherBoot)
	other.do("POST", "/api/transactions", map[string]any{
		"kind": "expense", "amount": 100, "accountId": otherBoot.Accounts[0].ID, "occurredAt": "2026-11-10T09:30",
		"vehicle": map[string]any{"vehicleId": bike.ID, "kind": "fuel"},
	}, 400, nil)

	// Editing the amount without mentioning the vehicle keeps the link, in step.
	me.do("PATCH", fmt.Sprintf("/api/transactions/%d", fill.ID), map[string]any{"amount": 550_00, "categoryId": fuelCat}, 200, &fill)
	if fill.Vehicle == nil {
		t.Fatal("editing the amount dropped the vehicle")
	}
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if l := fuelLog(); l.Amount != 550_00 {
		t.Fatalf("log amount = %d, want 55000", l.Amount)
	}
	var latest vehicle
	me.do("PATCH", fmt.Sprintf("/api/vehicles/%d", bike.ID), map[string]any{}, 200, &latest)
	if *latest.Odometer != 12250 {
		t.Fatalf("odometer = %d, want 12250", *latest.Odometer)
	}

	// Filtering Money by vehicle.
	var page struct {
		Items []txWithVehicle `json:"items"`
	}
	me.do("GET", fmt.Sprintf("/api/transactions?vehicle=%d", bike.ID), nil, 200, &page)
	if len(page.Items) != 1 {
		t.Fatalf("vehicle filter = %d items", len(page.Items))
	}

	// Saying it's not for a vehicle removes the log.
	me.do("PATCH", fmt.Sprintf("/api/transactions/%d", fill.ID), map[string]any{"categoryId": fuelCat, "vehicle": nil}, 200, &fill)
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if len(g.Logs) != 1 {
		t.Fatalf("unlinking left %d logs", len(g.Logs))
	}

	// A service from the vehicle side, paid from cash: an expense under "Vehicle".
	var service vehicleLog
	me.do("POST", "/api/vehicle-logs", map[string]any{"vehicleId": bike.ID, "kind": "service", "occurredOn": "2026-11-12", "odometer": 12400,
		"title": "Oil change", "amount": 850_00, "accountId": cash}, 201, &service)
	if service.TransactionID == nil {
		t.Fatal("paid service has no expense")
	}
	var spent txWithVehicle
	me.do("GET", "/api/transactions?vehicle="+fmt.Sprint(bike.ID), nil, 200, &page)
	spent = page.Items[0]
	if spent.Amount != 850_00 || spent.Vehicle == nil || spent.Vehicle.Kind != "service" || spent.CategoryID == nil {
		t.Fatalf("service expense = %+v", spent)
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	found := false
	for _, c := range boot.Categories {
		found = found || (c.ID == *spent.CategoryID && c.Name == "Vehicle")
	}
	if !found {
		t.Fatal(`service wasn't filed under "Vehicle"`)
	}

	// No longer paid from an account: the expense goes, the log stays.
	me.do("PATCH", fmt.Sprintf("/api/vehicle-logs/%d", service.ID), map[string]any{"accountId": nil}, 200, &service)
	if service.TransactionID != nil {
		t.Fatal("expense still linked")
	}
	me.do("GET", "/api/transactions?vehicle="+fmt.Sprint(bike.ID), nil, 200, &page)
	if len(page.Items) != 0 {
		t.Fatal("expense wasn't removed")
	}
	// Paid again, then deleted: the expense goes with it.
	me.do("PATCH", fmt.Sprintf("/api/vehicle-logs/%d", service.ID), map[string]any{"accountId": cash}, 200, &service)
	me.do("DELETE", fmt.Sprintf("/api/vehicle-logs/%d", service.ID), nil, 204, nil)
	me.do("GET", "/api/transactions?vehicle="+fmt.Sprint(bike.ID), nil, 200, &page)
	if len(page.Items) != 0 {
		t.Fatal("deleting the log left its expense")
	}
	me.do("POST", "/api/vehicle-logs", map[string]any{"vehicleId": bike.ID, "kind": "odometer", "occurredOn": "2026-11-12"}, 400, nil)

	// Insurance, paid from cash: a document, an expense and the vehicle's spend.
	var ins vehicleDoc
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "insurance", "issuedOn": "2026-11-01", "expiresOn": "2026-10-01"}, 400, nil)
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "insurance", "issuer": "Acko", "number": "POL123",
		"issuedOn": "2026-11-01", "expiresOn": "2027-10-31", "amount": 1450_00, "accountId": cash}, 201, &ins)
	if ins.TransactionID == nil || ins.ExpiresOn == nil || *ins.ExpiresOn != "2027-10-31" {
		t.Fatalf("insurance = %+v", ins)
	}
	me.do("GET", "/api/transactions?vehicle="+fmt.Sprint(bike.ID), nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0].Amount != 1450_00 {
		t.Fatalf("insurance expense = %+v", page.Items)
	}
	// A new premium amount updates the expense.
	me.do("PATCH", fmt.Sprintf("/api/vehicle-documents/%d", ins.ID), map[string]any{"amount": 1500_00}, 200, &ins)
	me.do("GET", "/api/transactions?vehicle="+fmt.Sprint(bike.ID), nil, 200, &page)
	if page.Items[0].Amount != 1500_00 {
		t.Fatalf("premium = %d, want 150000", page.Items[0].Amount)
	}
	// A licence is yours, not the bike's; no expiry means lifetime.
	var dl vehicleDoc
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "licence", "expiresOn": "2040-05-12"}, 201, &dl)
	if dl.VehicleID != nil {
		t.Fatal("licence kept a vehicle")
	}
	var tax vehicleDoc
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "road_tax", "expiresOn": ""}, 201, &tax)
	if tax.ExpiresOn != nil {
		t.Fatal("lifetime tax got an expiry")
	}
	// Uploads need a bucket.
	me.do("PUT", fmt.Sprintf("/api/vehicle-documents/%d/file", ins.ID), nil, 503, nil)

	// Erasing Money keeps the garage and its history.
	me.do("POST", "/api/me/erase", map[string]any{"username": "abdullah"}, 200, nil)
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if len(g.Vehicles) != 1 || len(g.Documents) != 3 || len(g.Logs) == 0 {
		t.Fatalf("after erase: %d vehicles, %d docs, %d logs", len(g.Vehicles), len(g.Documents), len(g.Logs))
	}
	for _, l := range g.Logs {
		if l.TransactionID != nil {
			t.Fatal("a log still points at an erased expense")
		}
	}

	// Deleting the vehicle removes its logs and papers, not your licence.
	me.do("DELETE", fmt.Sprintf("/api/vehicles/%d", bike.ID), nil, 204, nil)
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if len(g.Vehicles) != 0 || len(g.Logs) != 0 || len(g.Documents) != 1 {
		t.Fatalf("after delete: %+v", g)
	}
}

func TestServiceRulesAndReminders(t *testing.T) {
	srv, db := newTestServerDB(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "password123"}, 201, nil)
	today := reminderToday()
	day := func(n int) string { return today.AddDate(0, 0, n).Format(dateLayout) }

	var bike vehicle
	me.do("POST", "/api/vehicles", map[string]any{"kind": "bike", "name": "Pulsar", "color": "#3B82F6"}, 201, &bike)
	// Readings 60 days apart, 1,200 km: 20 km a day.
	me.do("POST", "/api/vehicle-logs", map[string]any{"vehicleId": bike.ID, "kind": "odometer", "occurredOn": day(-60), "odometer": 10000}, 201, nil)
	me.do("POST", "/api/vehicle-logs", map[string]any{"vehicleId": bike.ID, "kind": "service", "occurredOn": day(-60), "odometer": 10000, "title": "General service, Oil change"}, 201, nil)
	me.do("POST", "/api/vehicle-logs", map[string]any{"vehicleId": bike.ID, "kind": "odometer", "occurredOn": day(0), "odometer": 12800}, 201, nil)

	var oil, chain serviceRule
	me.do("POST", "/api/service-rules", map[string]any{"vehicleId": bike.ID, "title": "Oil change"}, 400, nil)
	me.do("POST", "/api/service-rules", map[string]any{"vehicleId": bike.ID, "title": "Oil change", "everyKm": 3000, "everyMonths": 6}, 201, &oil)
	if oil.State != "soon" || oil.KmLeft == nil || *oil.KmLeft != 200 || oil.LastOn == nil || *oil.LastOn != day(-60) {
		t.Fatalf("oil = %+v", oil)
	}
	me.do("POST", "/api/service-rules", map[string]any{"vehicleId": bike.ID, "title": "Chain", "everyKm": 500}, 201, &chain)
	if chain.State != "unknown" {
		t.Fatalf("chain = %+v", chain)
	}
	var general serviceRule
	me.do("POST", "/api/service-rules", map[string]any{"vehicleId": bike.ID, "title": "General service", "everyMonths": 1}, 201, &general)
	if general.State != "overdue" {
		t.Fatalf("general = %+v", general)
	}

	// Papers: PUC in 5 days, insurance expired 3 days ago, tax for life.
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "puc", "expiresOn": day(5)}, 201, nil)
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "insurance", "expiresOn": day(-3)}, 201, nil)
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": bike.ID, "type": "road_tax"}, 201, nil)

	var uid int64 = 1
	a := &api{db: db}
	items, err := a.dueReminders(t.Context(), uid, today)
	if err != nil {
		t.Fatal(err)
	}
	var titles []string
	for _, it := range items {
		titles = append(titles, it.key+" | "+it.title)
	}
	got := strings.Join(titles, "\n")
	for _, want := range []string{"Pulsar Insurance expired 3 days ago", "Pulsar PUC expires in 5 days", "Pulsar: General service overdue", "Pulsar: Oil change due in 200 km"} {
		if !strings.Contains(got, want) {
			t.Errorf("reminders missing %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "Road tax") || strings.Contains(got, "Chain") || strings.Contains(got, "odometer") {
		t.Errorf("unexpected reminders:\n%s", got)
	}
	if !strings.HasPrefix(titles[0], "doc:") || !strings.Contains(titles[0], "expired") {
		t.Errorf("most urgent should come first:\n%s", got)
	}

	// Logging the oil change moves the next one on.
	me.do("POST", "/api/vehicle-logs", map[string]any{"vehicleId": bike.ID, "kind": "service", "occurredOn": day(0), "odometer": 12800, "title": "Oil change"}, 201, nil)
	me.do("PATCH", fmt.Sprintf("/api/service-rules/%d", oil.ID), map[string]any{}, 200, &oil)
	if oil.State != "ok" || *oil.NextKm != 15800 || oil.GuessOn == nil {
		t.Fatalf("after service: %+v", oil)
	}

	// Calendar feed: a link, then events with alarms; a reset link stops working.
	var cal struct {
		Path string `json:"path"`
	}
	me.do("POST", "/api/calendar", nil, 200, &cal)
	res, err := http.Get(srv.URL + cal.Path)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	res.Body.Close()
	ics := string(body)
	for _, want := range []string{"BEGIN:VCALENDAR", "SUMMARY:Pulsar PUC expires", "DTSTART;VALUE=DATE:" + strings.ReplaceAll(day(5), "-", ""), "SUMMARY:Pulsar: Oil change due", "TRIGGER:-PT15H"} {
		if !strings.Contains(ics, want) {
			t.Errorf("calendar missing %q:\n%s", want, ics)
		}
	}
	me.do("DELETE", "/api/calendar", nil, 204, nil)
	if res, _ := http.Get(srv.URL + cal.Path); res.StatusCode != 404 {
		t.Fatalf("old calendar link still works: %d", res.StatusCode)
	}

	// Push isn't configured in tests.
	var push map[string]any
	me.do("GET", "/api/push", nil, 200, &push)
	if push["available"] != false {
		t.Fatalf("push = %v", push)
	}
	me.do("POST", "/api/push/subscribe", map[string]any{"endpoint": "http://not-https", "keys": map[string]string{"p256dh": "x", "auth": "y"}}, 400, nil)
	if out, err := vehicleReminders(t.Context(), a.db); err != nil || !strings.Contains(out, "aren't set up") {
		t.Fatalf("job without keys: %q %v", out, err)
	}
}

func TestReminderJob(t *testing.T) {
	srv, db := newTestServerDB(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "password123"}, 201, nil)
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"modules": []string{"finance", "vehicles"}}}, 200, nil)

	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("VAPID_PUBLIC_KEY", pub)
	t.Setenv("VAPID_PRIVATE_KEY", priv)

	// A fake push service that counts deliveries.
	var got []string
	var mu sync.Mutex
	pushSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		got = append(got, r.URL.Path)
		mu.Unlock()
		if r.URL.Path == "/gone" {
			w.WriteHeader(http.StatusGone)
			return
		}
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(pushSrv.Close)
	old := pushClient
	pushClient = pushSrv.Client()
	t.Cleanup(func() { pushClient = old })

	// A phone's keys, as a browser makes them.
	key, _ := ecdh.P256().GenerateKey(rand.Reader)
	auth := make([]byte, 16)
	rand.Read(auth)
	sub := func(path string) map[string]any {
		return map[string]any{"endpoint": pushSrv.URL + path, "keys": map[string]string{
			"p256dh": base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()), "auth": base64.RawURLEncoding.EncodeToString(auth)}}
	}
	var status map[string]any
	me.do("POST", "/api/push/subscribe", sub("/phone"), 200, &status)
	me.do("POST", "/api/push/subscribe", sub("/gone"), 200, &status)
	if status["devices"] != float64(2) || status["publicKey"] != pub {
		t.Fatalf("push status = %v", status)
	}
	me.do("POST", "/api/push/test", nil, 200, nil)
	me.do("GET", "/api/push", nil, 200, &status)
	if status["devices"] != float64(1) {
		t.Fatalf("a gone phone wasn't forgotten: %v", status)
	}

	var v vehicle
	me.do("POST", "/api/vehicles", map[string]any{"kind": "car", "name": "Swift", "color": "#3B82F6"}, 201, &v)
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": v.ID, "type": "puc", "expiresOn": reminderToday().AddDate(0, 0, 6).Format(dateLayout)}, 201, nil)

	got = nil
	out, err := vehicleReminders(t.Context(), db)
	if err != nil || !strings.Contains(out, "sent 1 reminders to 1 people") || len(got) != 1 {
		t.Fatalf("first run: %q %v %v", out, err, got)
	}
	// A retry or catch-up run says nothing new.
	out, err = vehicleReminders(t.Context(), db)
	if err != nil || !strings.Contains(out, "sent 0 reminders") || len(got) != 1 {
		t.Fatalf("second run: %q %v %v", out, err, got)
	}
	// Someone who turned vehicles off hears nothing.
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"modules": []string{"finance"}}}, 200, nil)
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": v.ID, "type": "insurance", "expiresOn": reminderToday().Format(dateLayout)}, 201, nil)
	if out, _ := vehicleReminders(t.Context(), db); !strings.Contains(out, "sent 0") {
		t.Fatalf("vehicles off: %q", out)
	}
}
