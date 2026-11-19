package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"
)

func kolkata(t *testing.T) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Fatal(err)
	}
	return loc
}

func TestParseDime(t *testing.T) {
	csv := "\uFEFFDate,Note,Amount,Category,Type\n" +
		"2026-11-19 08:04:10 +0000,Junkbot,25000.00,Salary,Income\n" +
		"2026-11-18 20:10:00 +0000,\"Chinmaya rice, curd\",70.00,Food,Expense\n" +
		"2026-11-18 04:40:00 +0000,Fuel,116.00,Fuel,Expense\n"
	p, err := parseImportCSV(csv, kolkata(t))
	if err != nil {
		t.Fatal(err)
	}
	if p.Format != "Dime" || len(p.Rows) != 3 || len(p.Problems) != 0 {
		t.Fatalf("got %+v", p)
	}
	// Oldest first, and in Indian time.
	want := []importRow{
		{Line: 4, Kind: "expense", Amount: 11600, At: "2026-11-18T10:10", Note: "Fuel", Category: "Fuel"},
		{Line: 3, Kind: "expense", Amount: 7000, At: "2026-11-19T01:40", Note: "Chinmaya rice, curd", Category: "Food"},
		{Line: 2, Kind: "income", Amount: 2500000, At: "2026-11-19T13:34", Note: "Junkbot", Category: "Salary"},
	}
	for i, w := range want {
		if p.Rows[i] != w {
			t.Errorf("row %d = %+v, want %+v", i, p.Rows[i], w)
		}
	}
}

func TestParseBankStatement(t *testing.T) {
	csv := "Account statement for XXXX2742\n\n" +
		"Txn Date;Narration;Chq./Ref.No.;Withdrawal Amt.;Deposit Amt.;Closing Balance\n" +
		"03/11/26;UPI-POVVAL FUELS;123;750.00;;9,250.00\n" +
		"13/11/26;NEFT SALARY;456;;1,25,000.00;1,34,250.00\n" +
		"14/11/26;Nothing;789;;;1,34,250.00\n"
	p, err := parseImportCSV(csv, kolkata(t))
	if err != nil {
		t.Fatal(err)
	}
	if p.Format != "a bank statement" || len(p.Rows) != 2 || len(p.Problems) != 1 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "expense" || r.Amount != 75000 || r.At != "2026-11-03T12:00" || r.Note != "UPI-POVVAL FUELS" {
		t.Errorf("row 0 = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "income" || r.Amount != 12500000 || r.At != "2026-11-13T12:00" {
		t.Errorf("row 1 = %+v", r)
	}
}

func TestParseSignedAndMonthFirst(t *testing.T) {
	// Wallet-style: signed amounts, US dates, an account column.
	csv := "date,account,category,amount,currency,description\n" +
		"11/20/2026 9:15 PM,HDFC,Food,-250.50,INR,Dinner\n" +
		"11/21/2026 10:00 AM,HDFC,Salary,\"50,000\",INR,Pay\n"
	p, err := parseImportCSV(csv, kolkata(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Rows) != 2 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "expense" || r.Amount != 25050 || r.At != "2026-11-20T21:15" || r.Account != "HDFC" {
		t.Errorf("row 0 = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "income" || r.Amount != 5000000 {
		t.Errorf("row 1 = %+v", r)
	}
}

func TestParseKoshExport(t *testing.T) {
	csv := "Date,Time,Type,Amount,Account,To account,Category,Person,Note\n" +
		"2026-11-01,09:30,expense,120.00,Cash,,Food & Dining,,Tea\n" +
		"2026-11-02,10:00,transfer,500.00,Canara Bank,Cash,,,ATM\n" +
		"2026-11-03,11:00,lend,100.00,Canara Bank,,,Muzammil,\n"
	p, err := parseImportCSV(csv, kolkata(t))
	if err != nil {
		t.Fatal(err)
	}
	if p.Format != "Kosh" || len(p.Rows) != 3 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[1]; r.Kind != "transfer" || r.Account != "Canara Bank" || r.ToAccount != "Cash" {
		t.Errorf("transfer = %+v", r)
	}
	if r := p.Rows[2]; r.Kind != "lend" || r.Person != "Muzammil" {
		t.Errorf("lend = %+v", r)
	}
}

func TestParseAmount(t *testing.T) {
	for in, want := range map[string]int64{
		"1,234.50": 123450, "₹ 1,23,456": 12345600, "Rs.500": 50000, "1.234,50": 123450, "12,5": 1250, "(75.25)": 7525, "500.00 Dr": 50000,
	} {
		got, _, _, ok := parseAmount(in)
		if !ok || got != want {
			t.Errorf("parseAmount(%q) = %d, %v; want %d", in, got, ok, want)
		}
	}
}

type importPreviewResp struct {
	Format       string `json:"format"`
	Count        int    `json:"count"`
	New          int    `json:"new"`
	Imported     int    `json:"imported"`
	Similar      int    `json:"similar"`
	NeedsAccount bool   `json:"needsAccount"`
	Categories   []struct {
		Key   string `json:"key"`
		Match *int64 `json:"match"`
	} `json:"categories"`
}

func TestImportFlow(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "meuser", "password": "password123"}, 201, nil)

	var cash idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "Wallet cash", "kind": "cash", "color": "#22C55E", "icon": "💵", "openingBalance": 100000}, 201, &cash)
	// Already recorded in Kosh: the import's ₹750 fuel on the same day looks like it.
	me.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 75000, "accountId": cash.ID, "occurredAt": "2026-11-13T22:13"}, 201, nil)

	csv := "Date,Note,Amount,Category,Type\n" +
		"2026-11-13 06:11:00 +0000,Car,750.00,Fuel,Expense\n" +
		"2026-11-12 08:09:00 +0000,Fish Nd rice,120.00,Food,Expense\n" +
		"2026-11-12 08:09:00 +0000,Fish Nd rice,120.00,Food,Expense\n" +
		"2026-11-10 10:00:00 +0000,Gift,500.00,Charity,Expense\n" +
		"2026-11-01 08:04:10 +0000,Junkbot,2000.00,Salary,Income\n"
	body := map[string]any{"csv": csv, "timezone": "Asia/Kolkata"}

	var pv importPreviewResp
	me.do("POST", "/api/import/preview", body, 200, &pv)
	if pv.Format != "Dime" || pv.Count != 5 || pv.New != 4 || pv.Similar != 1 || !pv.NeedsAccount {
		t.Fatalf("preview = %+v", pv)
	}
	matched := map[string]bool{}
	for _, c := range pv.Categories {
		matched[c.Key] = c.Match != nil
	}
	// Food → Food & Dining, Fuel, Salary match; Charity is new.
	if !matched["expense:Food"] || !matched["expense:Fuel"] || !matched["income:Salary"] || matched["expense:Charity"] {
		t.Errorf("category matches = %v", matched)
	}

	body["accountId"] = cash.ID
	body["keepBalances"] = true
	body["categories"] = map[string]any{"expense:Charity": map[string]any{"id": 0, "icon": "🤲"}}
	var res importResult
	me.do("POST", "/api/import", body, 200, &res)
	if res.Imported != 4 || res.SkippedSimilar != 1 || res.CreatedCategories != 1 {
		t.Fatalf("result = %+v", res)
	}

	// The balance is what it was: ₹1000 − ₹750.
	var accts []struct {
		ID      int64 `json:"id"`
		Balance int64 `json:"balance"`
	}
	var boot struct {
		Accounts *[]struct {
			ID      int64 `json:"id"`
			Balance int64 `json:"balance"`
		} `json:"accounts"`
	}
	boot.Accounts = &accts
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	for _, a := range accts {
		if a.ID == cash.ID && a.Balance != 25000 {
			t.Errorf("balance = %d, want 25000", a.Balance)
		}
	}

	// The same file again adds nothing.
	me.do("POST", "/api/import/preview", body, 200, &pv)
	if pv.Imported != 4 || pv.New != 0 {
		t.Fatalf("second preview = %+v", pv)
	}
	me.do("POST", "/api/import", body, 200, &res)
	if res.Imported != 0 || res.SkippedImported != 4 {
		t.Fatalf("second import = %+v", res)
	}
}

func TestMergeUsers(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "merge.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	newUser := func(username string) int64 {
		tx, _ := db.Begin()
		uid, err := createUser(tx, credentials{Name: username, Username: username}, "x")
		if err != nil {
			t.Fatal(err)
		}
		tx.Commit()
		return uid
	}
	dst, src := newUser("owner"), newUser("google")
	one := func(q string, args ...any) int64 {
		var n int64
		if err := db.QueryRow(q, args...).Scan(&n); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		return n
	}
	run := func(q string, args ...any) int64 {
		res, err := db.Exec(q, args...)
		if err != nil {
			t.Fatalf("%s: %v", q, err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	srcCash := one(`SELECT id FROM accounts WHERE user_id = ?`, src)
	dstCash := one(`SELECT id FROM accounts WHERE user_id = ?`, dst)
	srcBank := run(`INSERT INTO accounts (user_id, name, kind, color, icon) VALUES (?, 'HDFC', 'bank', '#000', '🏦')`, src)
	srcFood := one(`SELECT id FROM categories WHERE user_id = ? AND name = 'Groceries'`, src)
	dstFood := one(`SELECT id FROM categories WHERE user_id = ? AND name = 'Groceries'`, dst)
	srcCustom := run(`INSERT INTO categories (user_id, kind, name, icon, color) VALUES (?, 'expense', 'Jamaath', '🕌', '#000')`, src)
	run(`INSERT INTO transactions (user_id, kind, amount, account_id, category_id, occurred_at) VALUES (?, 'expense', 100, ?, ?, '2026-11-01T10:00')`, src, srcCash, srcFood)
	run(`INSERT INTO transactions (user_id, kind, amount, account_id, category_id, occurred_at) VALUES (?, 'expense', 200, ?, ?, '2026-11-01T10:00')`, src, srcBank, srcCustom)
	srcTx := run(`INSERT INTO transactions (user_id, kind, amount, account_id, occurred_at, source) VALUES (?, 'income', 300, ?, '2026-11-01T10:00', 'sms')`, src, srcBank)
	// The same bank message reached both: src saved it, dst hasn't yet.
	run(`INSERT INTO captures (user_id, text, text_hash, direction, amount, ref, occurred_at, status, transaction_id) VALUES (?, 'm', 'h1', 'credit', 300, 'R1', '2026-11-01T10:00', 'saved', ?)`, src, srcTx)
	run(`INSERT INTO captures (user_id, text, text_hash, direction, amount, ref, occurred_at) VALUES (?, 'm', 'h1', 'credit', 300, 'R1', '2026-11-01T10:00')`, dst)
	run(`INSERT INTO capture_keys (user_id, token, last_used_at) VALUES (?, 'old', '2026-11-01T00:00:00Z')`, dst)
	run(`INSERT INTO capture_keys (user_id, token, last_used_at) VALUES (?, 'new', '2026-11-19T00:00:00Z')`, src)
	run(`INSERT INTO identities (provider, provider_id, user_id, email) VALUES ('google', 'g1', ?, 'me@example.com')`, src)
	run(`INSERT INTO budgets (user_id, category_id, amount) VALUES (?, ?, 500)`, src, srcFood)

	tx, _ := db.BeginTx(ctx, nil)
	if err := mergeUsers(ctx, tx, src, dst); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	checks := []struct {
		q    string
		args []any
		want int64
	}{
		{`SELECT COUNT(*) FROM users WHERE id = ?`, []any{src}, 0},
		{`SELECT COUNT(*) FROM transactions WHERE user_id = ?`, []any{dst}, 3},
		{`SELECT COUNT(*) FROM transactions WHERE account_id = ?`, []any{dstCash}, 1},
		{`SELECT COUNT(*) FROM transactions WHERE category_id = ?`, []any{dstFood}, 1},
		{`SELECT COUNT(*) FROM accounts WHERE user_id = ?`, []any{dst}, 2},
		{`SELECT COUNT(*) FROM categories WHERE user_id = ? AND name = 'Jamaath'`, []any{dst}, 1},
		{`SELECT COUNT(*) FROM captures WHERE user_id = ?`, []any{dst}, 1},
		{`SELECT COUNT(*) FROM captures WHERE user_id = ? AND status = 'saved'`, []any{dst}, 1},
		{`SELECT COUNT(*) FROM capture_keys WHERE user_id = ? AND token = 'new'`, []any{dst}, 1},
		{`SELECT COUNT(*) FROM identities WHERE user_id = ?`, []any{dst}, 1},
		{`SELECT COUNT(*) FROM budgets WHERE user_id = ? AND category_id = ?`, []any{dst, dstFood}, 1},
		{`SELECT is_owner FROM users WHERE id = ?`, []any{dst}, 1},
	}
	for _, c := range checks {
		if got := one(c.q, c.args...); got != c.want {
			t.Errorf("%s %v = %d, want %d", c.q, c.args, got, c.want)
		}
	}
	var fk sql.NullString
	db.QueryRow(`PRAGMA foreign_key_check`).Scan(&fk)
	if fk.Valid {
		t.Errorf("foreign key problem in %s", fk.String)
	}
}
