package main

import (
	"fmt"
	"testing"
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
