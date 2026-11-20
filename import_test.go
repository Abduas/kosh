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

// parseFor parses a file and fails the test unless it's read as format.
func parseFor(t *testing.T, format, csv string) parsedImport {
	t.Helper()
	p, err := parseImportCSV(csv, kolkata(t))
	if err != nil {
		t.Fatal(err)
	}
	if p.Format != format {
		t.Fatalf("format = %q, want %q", p.Format, format)
	}
	return p
}

func TestParseCashew(t *testing.T) {
	csv := "account,amount,currency,title,note,date,income,type,category name,subcategory name,color,icon,emoji,budget,objective\n" +
		"HDFC,-250.0,INR,Lunch,,2026-11-18 13:05:00.000,false,null,Dining,,0xff1565c0,cutlery.png,,,\n" +
		"HDFC,50000.0,INR,Salary,Nov,2026-11-01 09:00:00.000,true,null,Salary,,,,,,\n" +
		"HDFC,-100.0,INR,Lent,,2026-11-02 10:00:00.000,false,TransactionSpecialType.credit,Groceries,,,,,,\n"
	p := parseFor(t, "Cashew", csv)
	if len(p.Rows) != 3 || len(p.Problems) != 0 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "income" || r.Amount != 5000000 || r.Note != "Salary · Nov" || r.Category != "Salary" || r.Account != "HDFC" || r.At != "2026-11-01T09:00" {
		t.Errorf("income = %+v", r)
	}
	if r := p.Rows[2]; r.Kind != "expense" || r.Amount != 25000 || r.Category != "Dining" {
		t.Errorf("expense = %+v", r)
	}
}

func TestParseCashewOnlyIncome(t *testing.T) {
	// No minus anywhere: the income flag still decides.
	csv := "account,amount,currency,title,note,date,income,type,category name,subcategory name,color,icon,emoji,budget,objective\n" +
		"SBI,1200.0,INR,Refund,,2026-11-18 13:05:00.000,true,null,Refunds,,,,,,\n"
	p := parseFor(t, "Cashew", csv)
	if len(p.Rows) != 1 || p.Rows[0].Kind != "income" {
		t.Fatalf("got %+v", p.Rows)
	}
}

func TestParseMoneyManager(t *testing.T) {
	// The Excel export as the app turns it into CSV.
	csv := "Period,Accounts,Category,Subcategory,Note,INR,Income/Expense,Description,Amount,Currency,Accounts\n" +
		"2026-11-18 21:15,Cash,Food,Dinner,Biryani,350,Exp.,,350,INR,350\n" +
		"2026-11-17 10:00,HDFC,Salary,,,60000,Income,,60000,INR,60000\n" +
		"2026-11-16 09:00,HDFC,Cash,,ATM,2000,Transfer-Out,,2000,INR,2000\n" +
		"2026-11-16 09:00,Cash,HDFC,,ATM,2000,Transfer-In,,2000,INR,2000\n"
	p := parseFor(t, "Money Manager", csv)
	if len(p.Rows) != 3 || len(p.Problems) != 1 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "transfer" || r.Account != "HDFC" || r.ToAccount != "Cash" || r.Amount != 200000 || r.Category != "" {
		t.Errorf("transfer = %+v", r)
	}
	if r := p.Rows[2]; r.Kind != "expense" || r.Account != "Cash" || r.Category != "Food" || r.Note != "Biryani" {
		t.Errorf("expense = %+v", r)
	}
}

func TestParseWalletTransfers(t *testing.T) {
	csv := "account;category;currency;amount;ref_currency_amount;type;payment_type;payment_type_local;note;date;gps_latitude;gps_longitude;gps_accuracy_in_meters;warranty_in_month;transfer;payee;labels;envelope_id;custom_category\n" +
		"HDFC;Transfer, withdraw;INR;-5000.00;-5000.00;Expenses;TRANSFER;Transfer;;2026-11-10T08:00:00.000Z;;;;0;true;;;20001;false\n" +
		"Savings;Transfer, withdraw;INR;5000.00;5000.00;Income;TRANSFER;Transfer;;2026-11-10T08:00:00.000Z;;;;0;true;;;20001;false\n" +
		"HDFC;Groceries;INR;-820.50;-820.50;Expenses;DEBIT_CARD;Debit card;Weekly;2026-11-11T12:30:00.000Z;;;;0;false;DMart;;1000;false\n" +
		"HDFC;Transfer, withdraw;INR;-300.00;-300.00;Expenses;TRANSFER;Transfer;;2026-11-12T08:00:00.000Z;;;;0;true;;;20001;false\n"
	p := parseFor(t, "Wallet", csv)
	if len(p.Rows) != 2 || len(p.Problems) != 1 || p.Problems[0].Line != 5 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "transfer" || r.Account != "HDFC" || r.ToAccount != "Savings" || r.Amount != 500000 || r.At != "2026-11-10T13:30" {
		t.Errorf("transfer = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "expense" || r.Amount != 82050 || r.Category != "Groceries" || r.Note != "Weekly · DMart" {
		t.Errorf("expense = %+v", r)
	}
}

func TestParseYNAB(t *testing.T) {
	csv := "\"Account\",\"Flag\",\"Date\",\"Payee\",\"Category Group/Category\",\"Category Group\",\"Category\",\"Memo\",\"Outflow\",\"Inflow\",\"Cleared\"\n" +
		"\"HDFC\",\"\",\"01/11/2026\",\"Starting Balance\",\"Inflow: Ready to Assign\",\"Inflow\",\"Ready to Assign\",\"\",₹0.00,₹12000.00,\"Reconciled\"\n" +
		"\"HDFC\",\"\",\"02/11/2026\",\"Swiggy\",\"Everyday: Food\",\"Everyday\",\"Food\",\"Dinner\",₹450.00,₹0.00,\"Cleared\"\n" +
		"\"HDFC\",\"\",\"03/11/2026\",\"Transfer : Cash\",\"\",\"\",\"\",\"\",₹1000.00,₹0.00,\"Cleared\"\n" +
		"\"Cash\",\"\",\"03/11/2026\",\"Transfer : HDFC\",\"\",\"\",\"\",\"\",₹0.00,₹1000.00,\"Cleared\"\n" +
		"\"HDFC\",\"\",\"05/11/2026\",\"Employer\",\"Inflow: Ready to Assign\",\"Inflow\",\"Ready to Assign\",\"\",₹0.00,₹50000.00,\"Cleared\"\n"
	p := parseFor(t, "YNAB", csv)
	if len(p.Rows) != 3 || len(p.Problems) != 1 || p.Openings["HDFC"] != 1200000 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "expense" || r.Amount != 45000 || r.Category != "Food" || r.Note != "Swiggy · Dinner" {
		t.Errorf("expense = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "transfer" || r.Account != "HDFC" || r.ToAccount != "Cash" || r.Amount != 100000 {
		t.Errorf("transfer = %+v", r)
	}
	if r := p.Rows[2]; r.Kind != "income" || r.Category != "" {
		t.Errorf("income = %+v", r)
	}
}

func TestParseOneMoney(t *testing.T) {
	csv := "DATE,TYPE,FROM ACCOUNT,TO ACCOUNT / TO CATEGORY,AMOUNT,CURRENCY,AMOUNT 2,CURRENCY 2,TAGS,NOTES\n" +
		"18/11/2026,Expense,Cash,Food,120,INR,120,INR,,Tea\n" +
		"17/11/2026,Income,Salary,Bank,50000,INR,50000,INR,,\n" +
		"16/11/2026,Transfer,Bank,Cash,1000,INR,1000,INR,,\n"
	p := parseFor(t, "1Money", csv)
	if len(p.Rows) != 3 || len(p.Problems) != 0 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "transfer" || r.Account != "Bank" || r.ToAccount != "Cash" {
		t.Errorf("transfer = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "income" || r.Account != "Bank" || r.Category != "Salary" {
		t.Errorf("income = %+v", r)
	}
	if r := p.Rows[2]; r.Kind != "expense" || r.Account != "Cash" || r.Category != "Food" || r.Note != "Tea" {
		t.Errorf("expense = %+v", r)
	}
}

func TestParseBluecoins(t *testing.T) {
	csv := "(1)Type,(2)Date,(3)Item or Payee,(4)Amount,(5)Parent Category,(6)Category,(7)Account Type,(8)Account,(9)Notes,(10) Label,(11) Status,(12) Split\n" +
		"New Account,11/01/2026,,25000,,,Bank,ICICI,,,,\n" +
		"Expense,11/18/2026 20:15,Zomato,-320,Food,Delivery,Bank,ICICI,,,,\n" +
		"Transfer,11/19/2026 09:00,Card bill,-5000,(Transfer),(Transfer),Bank,ICICI,,,,\n" +
		"Transfer,11/19/2026 09:00,Card bill,5000,(Transfer),(Transfer),Credit Card,Amazon Pay ICICI,,,,\n"
	p := parseFor(t, "Bluecoins", csv)
	if len(p.Rows) != 2 || len(p.Problems) != 0 || p.Openings["ICICI"] != 2500000 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "expense" || r.Amount != 32000 || r.Category != "Delivery" || r.Note != "Zomato" || r.At != "2026-11-18T20:15" {
		t.Errorf("expense = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "transfer" || r.Account != "ICICI" || r.ToAccount != "Amazon Pay ICICI" || r.Note != "Card bill" {
		t.Errorf("transfer = %+v", r)
	}
}

func TestParseMoneyPro(t *testing.T) {
	csv := "Date,Amount,Account,Amount received,Account (to),Balance,Category,Description,Transaction Type,Agent,Check #,Class\n" +
		"\"Nov 1, 2026\",0,Axis,,,8000,,,Opening Balance,,,\n" +
		"\"Nov 18, 2026\",-560,Axis,,,7440,Fuel,Petrol,Expense,HP,,\n" +
		"\"Nov 19, 2026\",-1000,Axis,1000,Wallet,6440,,,Money Transfer,,,\n"
	p := parseFor(t, "Money Pro", csv)
	if len(p.Rows) != 2 || len(p.Problems) != 0 || p.Openings["Axis"] != 800000 {
		t.Fatalf("got %+v", p)
	}
	if r := p.Rows[0]; r.Kind != "expense" || r.Amount != 56000 || r.Note != "Petrol · HP" {
		t.Errorf("expense = %+v", r)
	}
	if r := p.Rows[1]; r.Kind != "transfer" || r.ToAccount != "Wallet" {
		t.Errorf("transfer = %+v", r)
	}
}

func TestParseOtherApps(t *testing.T) {
	// Goodbudget: envelopes are categories, amounts are signed.
	p := parseFor(t, "Goodbudget", "Date,Envelope,Account,Name,Notes,Amount,Status,Details\n"+
		"11/18/2026,Groceries,Checking,More,,-1250.00,,\n11/19/2026,,Checking,Salary,,40000.00,,\n")
	if len(p.Rows) != 2 || p.Rows[0].Kind != "expense" || p.Rows[0].Category != "Groceries" || p.Rows[1].Kind != "income" {
		t.Errorf("Goodbudget = %+v", p.Rows)
	}
	// Toshl: separate expense and income columns.
	p = parseFor(t, "Toshl", "Date,Account,Category,Tags,Expense amount,Income amount,Currency,In main currency,Main currency,Description\n"+
		"11/18/26,Cash,Food,,180.00,0,INR,180.00,INR,Chai\n11/19/26,Bank,Salary,,0,52000.00,INR,52000.00,INR,\n")
	if len(p.Rows) != 2 || p.Rows[0].Kind != "expense" || p.Rows[0].Amount != 18000 || p.Rows[1].Kind != "income" {
		t.Errorf("Toshl = %+v", p.Rows)
	}
	// Ivy Wallet: planned payments have no date yet.
	p = parseFor(t, "Ivy Wallet", "Date,Title,Category,Account,Amount,Currency,Type,Transfer Amount,Transfer Currency,To Account,Receive Amount,Receive Currency,Description,Due Date,ID\n"+
		"2026-11-18 10:00:00,Tea,Food,Cash,20,INR,EXPENSE,,,,,,,,a\n"+
		"2026-11-18 11:00:00,,,Bank,500,INR,TRANSFER,500,INR,Cash,500,INR,,,b\n"+
		",Rent,Home,Bank,15000,INR,EXPENSE,,,,,,,2026-12-01 00:00:00,c\n")
	if len(p.Rows) != 2 || p.Rows[1].Kind != "transfer" || p.Rows[1].ToAccount != "Cash" || len(p.Problems) != 1 || p.Problems[0].Reason != "Planned for later, not yet paid" {
		t.Errorf("Ivy = %+v %+v", p.Rows, p.Problems)
	}
	// Money Lover: transfers are a pair of categories.
	p = parseFor(t, "Money Lover", "Id,Date,Category,Amount,Currency,Note,Wallet\n"+
		"1,18/11/2026,Outgoing Transfer,-2000,INR,,Bank\n2,18/11/2026,Incoming Transfer,2000,INR,,Cash\n3,19/11/2026,Food & Beverage,-150,INR,Snacks,Cash\n")
	if len(p.Rows) != 2 || p.Rows[0].Kind != "transfer" || p.Rows[0].Account != "Bank" || p.Rows[0].ToAccount != "Cash" || p.Rows[1].Category != "Food & Beverage" {
		t.Errorf("Money Lover = %+v %+v", p.Rows, p.Problems)
	}
	// Spendee: a transfer is two rows in two wallets.
	p = parseFor(t, "Spendee", "Date,Wallet,Type,Category name,Amount,Currency,Note,Labels,Author\n"+
		"2026-11-18T10:00:00+05:30,Bank,Transfer,Transfer,-3000,INR,,,Me\n2026-11-18T10:00:00+05:30,Cash,Transfer,Transfer,3000,INR,,,Me\n"+
		"2026-11-18T12:00:00+05:30,Cash,Expense,Food,-90,INR,Samosa,,Me\n")
	if len(p.Rows) != 2 || p.Rows[0].Kind != "transfer" || p.Rows[0].ToAccount != "Cash" || p.Rows[1].Note != "Samosa" {
		t.Errorf("Spendee = %+v %+v", p.Rows, p.Problems)
	}
	// Monefy: signed amounts, day first.
	p = parseFor(t, "Monefy", "date,account,category,amount,currency,converted amount,currency,description\n"+
		"18/11/2026,Cash,Food,-75,INR,-75,INR,Vada pav\n19/11/2026,Cash,Salary,30000,INR,30000,INR,\n")
	if len(p.Rows) != 2 || p.Rows[0].Kind != "expense" || p.Rows[1].Kind != "income" || p.Rows[0].At != "2026-11-18T12:00" {
		t.Errorf("Monefy = %+v", p.Rows)
	}
}

func TestImportOpeningBalances(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "meuser", "password": "password123"}, 201, nil)

	// YNAB: a new account that starts with ₹12,000, then a transfer and a
	// purchase. The transfer's other account only appears in a transfer.
	csv := "\"Account\",\"Flag\",\"Date\",\"Payee\",\"Category Group/Category\",\"Category Group\",\"Category\",\"Memo\",\"Outflow\",\"Inflow\",\"Cleared\"\n" +
		"\"Axis\",\"\",\"01/11/2026\",\"Starting Balance\",\"Inflow: Ready to Assign\",\"Inflow\",\"Ready to Assign\",\"\",₹0.00,₹12000.00,\"Reconciled\"\n" +
		"\"Axis\",\"\",\"02/11/2026\",\"Swiggy\",\"Everyday: Food\",\"Everyday\",\"Food\",\"\",₹450.00,₹0.00,\"Cleared\"\n" +
		"\"Axis\",\"\",\"03/11/2026\",\"Transfer : Pocket\",\"\",\"\",\"\",\"\",₹1000.00,₹0.00,\"Cleared\"\n"
	body := map[string]any{"csv": csv, "timezone": "Asia/Kolkata"}
	var res importResult
	me.do("POST", "/api/import", body, 200, &res)
	if res.Imported != 2 || res.CreatedAccounts != 2 {
		t.Fatalf("result = %+v", res)
	}
	var boot struct {
		Accounts []struct {
			Name    string `json:"name"`
			Balance int64  `json:"balance"`
		} `json:"accounts"`
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	want := map[string]int64{"Axis": 1200000 - 45000 - 100000, "Pocket": 100000}
	for _, a := range boot.Accounts {
		if w, ok := want[a.Name]; ok && a.Balance != w {
			t.Errorf("%s balance = %d, want %d", a.Name, a.Balance, w)
		}
	}
	// Again: nothing new, and the opening balance isn't added twice.
	me.do("POST", "/api/import", body, 200, &res)
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	for _, a := range boot.Accounts {
		if a.Name == "Axis" && a.Balance != want["Axis"] {
			t.Errorf("after second import, Axis = %d", a.Balance)
		}
	}
}
