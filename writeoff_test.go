package main

import "testing"

func TestINR(t *testing.T) {
	for in, want := range map[int64]string{50000: "₹500", 12345650: "₹1,23,456.50", 100000000: "₹10,00,000", 99: "₹0.99", -150000: "-₹1,500"} {
		if got := inr(in); got != want {
			t.Errorf("inr(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestWriteOffLoan(t *testing.T) {
	srv, db := newTestServerDB(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "meuser", "password": "password123"}, 201, nil)
	var bank, rahul idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "Bank", "kind": "bank", "color": "#0072BC", "icon": "🏦", "openingBalance": 1000000}, 201, &bank)
	me.do("POST", "/api/people", map[string]any{"name": "Rahul", "color": "#0072BC"}, 201, &rahul)
	tx := func(kind string, amount int64, at string) {
		me.do("POST", "/api/transactions", map[string]any{"kind": kind, "amount": amount, "accountId": bank.ID, "personId": rahul.ID, "occurredAt": at, "note": "trip"}, 201, nil)
	}
	// Lent ₹1,000 then ₹3,000; got ₹500 back: he owes ₹3,500.
	tx("lend", 100000, "2026-01-05T10:00")
	tx("lend", 300000, "2026-03-01T10:00")
	tx("collect", 50000, "2026-04-01T10:00")
	bankBalance := func() (b int64) {
		if err := db.QueryRow(`SELECT opening_balance + COALESCE((SELECT SUM(CASE WHEN kind IN ('income','borrow','collect') THEN amount ELSE -amount END) FROM transactions WHERE account_id = accounts.id), 0) FROM accounts WHERE id = ?`, bank.ID).Scan(&b); err != nil {
			t.Fatal(err)
		}
		return
	}
	before := bankBalance()

	var res struct {
		Person     person
		CategoryID int64
		Loans      int
	}
	me.do("POST", "/api/people/"+itoa(rahul.ID)+"/write-off", map[string]any{"amount": 400000}, 400, nil)
	// ₹3,200 won't come back: all of the ₹3,000 and ₹200 of the ₹1,000.
	me.do("POST", "/api/people/"+itoa(rahul.ID)+"/write-off", map[string]any{"amount": 320000}, 200, &res)
	if res.Person.Balance != 30000 || res.Loans != 2 {
		t.Fatalf("after write-off: %+v", res)
	}
	if got := bankBalance(); got != before {
		t.Fatalf("bank balance moved: %d -> %d", before, got)
	}
	var lost int64
	var n int
	db.QueryRow(`SELECT COALESCE(SUM(amount), 0), COUNT(*) FROM transactions WHERE kind = 'expense' AND category_id = ?`, res.CategoryID).Scan(&lost, &n)
	if lost != 320000 || n != 2 {
		t.Fatalf("expenses %d in %d", lost, n)
	}
	var lend int64
	var note string
	db.QueryRow(`SELECT amount, note FROM transactions WHERE kind = 'lend'`).Scan(&lend, &note)
	if lend != 80000 || note != "trip" {
		t.Fatalf("remaining loan %d %q", lend, note)
	}
	db.QueryRow(`SELECT note FROM transactions WHERE kind = 'expense' AND occurred_at = '2026-01-05T10:00'`).Scan(&note)
	if note != "Lent to Rahul, not paid back · trip" {
		t.Fatalf("note %q", note)
	}
	// Rahul's history still shows both written-off parts.
	var hist struct{ Items []transaction }
	me.do("GET", "/api/transactions?person="+itoa(rahul.ID), nil, 200, &hist)
	kinds := map[string]int{}
	for _, x := range hist.Items {
		kinds[x.Kind]++
	}
	if kinds["expense"] != 2 || kinds["lend"] != 1 || kinds["collect"] != 1 {
		t.Fatalf("history kinds %v", kinds)
	}
	// Edited into income, it's no longer Rahul's.
	var exp transaction
	for _, x := range hist.Items {
		if x.Kind == "expense" {
			exp = x
		}
	}
	me.do("PATCH", "/api/transactions/"+itoa(exp.ID), map[string]any{"kind": "income", "categoryId": nil, "toAccountId": nil, "personId": nil}, 200, nil)
	me.do("GET", "/api/transactions?person="+itoa(rahul.ID), nil, 200, &hist)
	if len(hist.Items) != 3 {
		t.Fatalf("after editing: %d items", len(hist.Items))
	}
	me.do("PATCH", "/api/transactions/"+itoa(exp.ID), map[string]any{"kind": "expense", "categoryId": res.CategoryID, "toAccountId": nil, "personId": nil}, 200, nil)

	// The rest goes too, and then there's nothing left to write off.
	me.do("POST", "/api/people/"+itoa(rahul.ID)+"/write-off", map[string]any{"amount": 30000}, 200, &res)
	if res.Person.Balance != 0 {
		t.Fatalf("balance %d", res.Person.Balance)
	}
	me.do("POST", "/api/people/"+itoa(rahul.ID)+"/write-off", map[string]any{"amount": 100}, 400, nil)

	other := newClient(t, srv)
	other.do("POST", "/api/auth/signup", map[string]string{"name": "Other", "username": "other", "password": "password123"}, 201, nil)
	other.do("POST", "/api/people/"+itoa(rahul.ID)+"/write-off", map[string]any{"amount": 100}, 404, nil)
}
