package main

import "testing"

func TestEraseMe(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "eraser", "password": "password123"}, 201, nil)
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"onboarded": true, "theme": "dark"}}, 200, nil)
	var acct idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "HDFC", "kind": "bank", "color": "#3B82F6", "icon": "🏦"}, 201, &acct)
	var person idResp
	me.do("POST", "/api/people", map[string]any{"name": "Sam", "color": "#3B82F6"}, 201, &person)
	me.do("POST", "/api/transactions", map[string]any{"kind": "lend", "amount": 500, "accountId": acct.ID, "personId": person.ID, "occurredAt": "2026-11-01T10:00"}, 201, nil)

	me.do("POST", "/api/me/erase", map[string]string{"username": "someone"}, 400, nil)
	me.do("POST", "/api/me/erase", map[string]string{"username": "@Eraser"}, 200, nil)

	var boot struct {
		User struct {
			Prefs map[string]any `json:"prefs"`
		} `json:"user"`
		Accounts   []struct{ Name string } `json:"accounts"`
		Categories []struct{ Name string } `json:"categories"`
		People     []struct{ Name string } `json:"people"`
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	if len(boot.Accounts) != 1 || boot.Accounts[0].Name != "Cash" || len(boot.People) != 0 || len(boot.Categories) != len(defaultExpenseCategories)+len(defaultIncomeCategories) {
		t.Fatalf("after erase: %+v", boot)
	}
	if boot.User.Prefs["onboarded"] != nil || boot.User.Prefs["theme"] != "dark" {
		t.Fatalf("prefs after erase: %v", boot.User.Prefs)
	}
	var page struct {
		Items []any `json:"items"`
	}
	me.do("GET", "/api/transactions", nil, 200, &page)
	if len(page.Items) != 0 {
		t.Fatalf("transactions left: %d", len(page.Items))
	}
}
