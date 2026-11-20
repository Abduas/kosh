package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestAgentManage(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "meuser", "password": "password123"}, 201, nil)
	me.do("POST", "/api/accounts", map[string]any{"name": "Canara", "kind": "bank", "color": "#3B82F6", "icon": "🏦"}, 201, nil)
	var made struct{ Key string }
	me.do("POST", "/api/agents", map[string]any{"name": "Instinct", "scope": "write"}, 201, &made)
	base := srv.URL + "/agent/" + made.Key
	hc := &http.Client{}
	call := func(tool string, args map[string]any, want int) map[string]any {
		t.Helper()
		code, out, _ := postJSON(t, hc, base+"/"+tool, args, nil)
		if code != want {
			t.Fatalf("%s %v: %d %v", tool, args, code, out)
		}
		return out
	}
	saved := func(out map[string]any) map[string]any { return out["saved"].(map[string]any) }

	// A new bike, then its papers and fuel by registration number.
	v := saved(call("add_vehicle", map[string]any{"name": "Passion Pro", "type": "bike", "registration": "kl 60 d 5941", "make": "Hero", "odometer": 41200}, 200))
	if v["registration"] != "KL60D5941" || v["odometerKm"] != float64(41200) {
		t.Fatalf("vehicle %v", v)
	}
	call("add_vehicle", map[string]any{"name": "Again", "type": "bike", "registration": "KL60D5941"}, 400)
	call("add_vehicle_paper", map[string]any{"vehicle": "KL60D5941", "type": "insurance", "expires_on": "2027-03-01"}, 200)
	call("update_vehicle", map[string]any{"vehicle": "Passion", "model": "Passion Pro i3S", "year": 2019}, 200)
	rule := saved(call("save_service_rule", map[string]any{"title": "General service", "every_km": 3000, "every_months": 6}, 200))
	call("save_service_rule", map[string]any{"rule": "general", "every_km": 2500}, 200)

	// Accounts, categories and people.
	call("save_account", map[string]any{"name": "Cash", "type": "cash", "opening_balance": 1500}, 200)
	acc := saved(call("save_account", map[string]any{"account": "Canara", "opening_balance": -550.5}, 200))
	if acc["openingBalance"] != -550.5 {
		t.Fatalf("account %v", acc)
	}
	call("save_category", map[string]any{"kind": "expense", "name": "Gym", "icon": "🏋️"}, 200)
	call("save_person", map[string]any{"name": "Rahul", "phone": "9000000000"}, 200)

	// Fix an entry the person added.
	var tx struct{ ID int64 }
	me.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 20000, "accountId": 2, "occurredAt": "2026-11-10T10:00"}, 201, &tx)
	fixed := saved(call("update_transaction", map[string]any{"id": tx.ID, "amount": 250, "category": "Gym", "note": "Monthly fee"}, 200))
	if fixed["amount"] != 250.0 || fixed["category"] != "Gym" || fixed["account"] != "Canara" || fixed["date"] != "2026-11-10T10:00" {
		t.Fatalf("updated %v", fixed)
	}
	// Turned into a loan to Rahul, then written off.
	call("update_transaction", map[string]any{"id": tx.ID, "type": "lend", "person": "Rahul"}, 200)
	off := call("write_off_loan", map[string]any{"person": "Rahul"}, 200)
	if off["countedAsSpent"] != 250.0 || off["stillOwesYou"] != 0.0 {
		t.Fatalf("write off %v", off)
	}
	call("set_budget", map[string]any{"category": "Gym", "amount": 1500}, 200)

	// The app's own API, in paise and ids.
	out := call("kosh_api", map[string]any{"method": "GET", "path": "/api/vehicles"}, 200)
	if !strings.Contains(stringify(out), "KL60D5941") {
		t.Fatalf("kosh_api vehicles %v", out)
	}
	call("kosh_api", map[string]any{"method": "POST", "path": "/api/interest/give", "body": map[string]any{"amount": 100, "accountId": 2, "occurredAt": "2026-11-11T10:00"}}, 200)
	call("kosh_api", map[string]any{"method": "POST", "path": "/api/me/erase", "body": map[string]any{}}, 400)
	call("kosh_api", map[string]any{"method": "GET", "path": "/api/agents"}, 400)

	// Deleting, by kind and id.
	call("delete", map[string]any{"what": "service_rule", "id": rule["id"]}, 200)
	call("delete", map[string]any{"what": "service_rule", "id": rule["id"]}, 400)
	call("delete", map[string]any{"what": "transaction", "id": tx.ID}, 200)

	// A read-only connection can read through kosh_api but not change.
	var conns struct{ Connections []agentConn }
	me.do("GET", "/api/agents", nil, 200, &conns)
	me.do("PATCH", "/api/agents/"+itoa(conns.Connections[0].ID), map[string]any{"scope": "read"}, 204, nil)
	call("kosh_api", map[string]any{"method": "GET", "path": "/api/budgets"}, 200)
	out = call("kosh_api", map[string]any{"method": "DELETE", "path": "/api/vehicles/1"}, 400)
	if !strings.Contains(out["error"].(string), "only read") {
		t.Fatalf("read-only %v", out)
	}
	call("add_vehicle", map[string]any{"name": "X", "type": "car"}, 400)
}

func stringify(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
