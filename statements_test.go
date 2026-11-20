package main

import "testing"

func TestStatementLabel(t *testing.T) {
	cases := []struct {
		note string
		in   bool
		want string
	}{
		{"SBINT FOR THE PERIOD FROM28-SEP-25 TO 27-DEC-25", true, labelInterest},
		{"SB INT.PD 01-04-2026 TO 30-06-2026", true, labelInterest},
		{"Int.Pd:12345678:01-07-2026 to 30-09-2026", true, labelInterest},
		{"CREDIT INTEREST", true, labelInterest},
		{"INTEREST CREDIT", true, labelInterest},
		{"FD INT 0012345", true, labelInterest},
		{"TDS ON INTEREST", false, labelTDS},
		{"INT.COLL:LOAN 1234", false, labelInterestPaid},
		{"SMS CHARGES ON ACTUAL BASIS", false, labelCharges},
		{"DEBIT CARD ANNUAL CHARGES XXXXXXXXXXX1234", false, labelCharges},
		{"SMS CHARGE SHORT COLLECTION SEP- DEC2025DUE DT:03-JAN-26", false, labelCharges},
		{"MIN BAL CHGS INCL GST", false, labelCharges},
		// Payments between people are never the bank's own entries.
		{"UPI/CR/500000000001/INTEREST REFUND/OKSBI", true, ""},
		{"INET-IMPS-CR/ACME PAY/YBP /000000000000001/OPS INTERN/9000000000", true, ""},
		{"NEFT CR-ABCD00000000001-ACME TRADERS", true, ""},
		// INT as part of a word isn't interest.
		{"INTERNET BANKING FUND TRANSFER", true, ""},
		{"INTL TXN MARKUP", false, ""},
		{"CASH DEPOSIT", true, ""},
	}
	for _, c := range cases {
		if got := statementLabel(c.note, c.in); got != c.want {
			t.Errorf("statementLabel(%q, %v) = %q, want %q", c.note, c.in, got, c.want)
		}
	}
}

type checkResp struct {
	From, To    string
	Count       int
	Opening     *int64
	Closing     *int64
	Breaks      []int
	KoshClosing int64
	Interest    int64
	Charges     int64
	Matched     int
	Missing     int
	Rows        []struct {
		At     string
		Kind   string
		Amount int64
		Note   string
		Label  string
		Match  *struct{ ID int64 }
	}
	KoshOnly []struct {
		ID     int64
		Amount int64
	}
}

func TestStatementCheck(t *testing.T) {
	srv, db := newTestServerDB(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "meuser", "password": "password123"}, 201, nil)

	var bank idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "Canara Bank", "kind": "bank", "color": "#0072BC", "icon": "🏦", "openingBalance": 87}, 201, &bank)
	tx := func(kind string, amount int64, at string) int64 {
		var r idResp
		me.do("POST", "/api/transactions", map[string]any{"kind": kind, "amount": amount, "accountId": bank.ID, "occurredAt": at}, 201, &r)
		return r.ID
	}
	// What Kosh already has: the ₹100 a day late, the salary, a ₹50 the bank
	// doesn't show, and ₹14 of interest filed as plain income.
	tx("expense", 10000, "2025-11-22T09:00")
	tx("income", 1000000, "2025-11-21T18:00")
	extra := tx("expense", 5000, "2025-11-23T12:00")
	plainInterest := tx("income", 1400, "2025-12-28T10:00")
	// A UPI payment saved from the bank's SMS, with its reference, but dated
	// days off: the reference still matches it.
	res, err := db.Exec(`INSERT INTO transactions (user_id, kind, amount, account_id, occurred_at, source, ref)
		SELECT user_id, 'expense', 200000, id, '2025-11-28T23:25', 'sms', '500000000004' FROM accounts WHERE id = ?`, bank.ID)
	if err != nil {
		t.Fatal(err)
	}
	upiID, _ := res.LastInsertId()

	// What the phone makes of a Canara PDF.
	csv := "Date,Particulars,Deposits,Withdrawals,Balance\n" +
		`2025-11-21,"UPI/CR/500000000002/SELF /FDRL/**0001@OKSBI",1.00,,1.87` + "\n" +
		`2025-11-21,"UPI/DR/500000000003/SHOP ONE/YESB/**0002@YBL",,100.00,-98.13` + "\n" +
		`2025-11-21,"NEFT CR-ABCD00000000001-ACME TRADERS",10000.00,,9901.87` + "\n" +
		`2025-11-21,"UPI/DR/500000000004/FRIEND B/CNRB/**0003@OKICICI",,2000.00,7901.87` + "\n" +
		`2025-12-25,"SMS CHARGES ON ACTUAL BASIS",,27.00,7874.87` + "\n" +
		`2025-12-28,"SBINT FOR THE PERIOD FROM28-SEP-25 TO 27-DEC-25",9.00,,7883.87` + "\n" +
		`2025-12-28,"SBINT FOR THE PERIOD FROM28-SEP-25 TO 27-DEC-25 (2)",14.00,,7897.87` + "\n"
	body := map[string]any{"csv": csv, "timezone": "Asia/Kolkata", "accountId": bank.ID}

	var c checkResp
	me.do("POST", "/api/statements/check", body, 200, &c)
	if c.Count != 7 || c.From != "2025-11-21" || c.To != "2025-12-28" {
		t.Fatalf("period = %+v", c)
	}
	if c.Opening == nil || *c.Opening != 87 || c.Closing == nil || *c.Closing != 789787 || len(c.Breaks) != 0 {
		t.Fatalf("balances: opening %v closing %v breaks %v", c.Opening, c.Closing, c.Breaks)
	}
	if c.Interest != 2300 || c.Charges != 2700 {
		t.Fatalf("interest %d, charges %d", c.Interest, c.Charges)
	}
	// Matched: the ₹100, the salary, the UPI by reference, the ₹14.
	if c.Matched != 4 || c.Missing != 3 {
		t.Fatalf("matched %d missing %d", c.Matched, c.Missing)
	}
	if m := c.Rows[3].Match; m == nil || m.ID != upiID {
		t.Fatalf("UPI row matched %+v, want %d", m, upiID)
	}
	if m := c.Rows[6].Match; m == nil || m.ID != plainInterest {
		t.Fatalf("₹14 interest matched %+v", m)
	}
	if len(c.KoshOnly) != 1 || c.KoshOnly[0].ID != extra {
		t.Fatalf("kosh only = %+v", c.KoshOnly)
	}
	// Kosh: 0.87 - 100 + 10,000 - 50 + 14 - 2,000
	if c.KoshClosing != 87-10000+1000000-5000+1400-200000 {
		t.Fatalf("kosh closing = %d", c.KoshClosing)
	}

	// Add what's missing without moving the balance.
	var missing []map[string]any
	for _, r := range c.Rows {
		if r.Match == nil {
			missing = append(missing, map[string]any{"at": r.At, "kind": r.Kind, "amount": r.Amount, "note": r.Note, "label": r.Label})
		}
	}
	add := map[string]any{"accountId": bank.ID, "rows": missing, "keepBalance": true}
	var added map[string]int
	me.do("POST", "/api/statements/add", add, 200, &added)
	if added["added"] != 3 {
		t.Fatalf("added = %v", added)
	}
	me.do("POST", "/api/statements/add", add, 200, &added)
	if added["added"] != 0 || added["skipped"] != 3 {
		t.Fatalf("second add = %v", added)
	}
	var after checkResp
	me.do("POST", "/api/statements/check", body, 200, &after)
	if after.Missing != 0 || after.KoshClosing != c.KoshClosing {
		t.Fatalf("after adding: missing %d, kosh closing %d (was %d)", after.Missing, after.KoshClosing, c.KoshClosing)
	}

	// The added ₹9 went into Interest; the ₹14 was plain income until marked.
	var sum interestSummary
	me.do("GET", "/api/interest", nil, 200, &sum)
	if sum.Earned != 900 || sum.ToGive != 900 {
		t.Fatalf("interest before marking = %+v", sum)
	}
	me.do("POST", "/api/statements/mark-interest", map[string]any{"ids": []int64{plainInterest, extra}}, 200, nil)
	me.do("GET", "/api/interest", nil, 200, &sum)
	if sum.Earned != 2300 || len(sum.Years) != 1 || sum.Years[0].Year != "2025" {
		t.Fatalf("interest after marking = %+v", sum)
	}

	me.do("POST", "/api/interest/give", map[string]any{"amount": 2000, "accountId": bank.ID, "occurredAt": "2026-01-05T10:00"}, 200, &sum)
	if sum.Given != 2000 || sum.ToGive != 300 || len(sum.Years) != 2 {
		t.Fatalf("after giving = %+v", sum)
	}

	// Someone else's account is refused.
	other := newClient(t, srv)
	other.do("POST", "/api/auth/signup", map[string]string{"name": "Other", "username": "other", "password": "password123"}, 201, nil)
	other.do("POST", "/api/statements/check", body, 400, nil)
}

func TestStatementBreaks(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Me", "username": "meuser", "password": "password123"}, 201, nil)
	var bank idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "SBI", "kind": "bank", "color": "#1E63D6", "icon": "🏦"}, 201, &bank)
	// Banks list entries as posted: interest dated the 28th before a payment
	// of the 27th. The balance follows that order, so it isn't a break.
	posted := "Date,Particulars,Deposits,Withdrawals,Balance\n" +
		"2026-06-27,UPI/DR/1/X,,40.00,122.88\n" +
		"2026-06-28,SBINT FOR THE PERIOD,14.00,,136.88\n" +
		"2026-06-27,UPI/CR/2/Y,440.00,,576.88\n"
	var pc checkResp
	me.do("POST", "/api/statements/check", map[string]any{"csv": posted, "accountId": bank.ID}, 200, &pc)
	if len(pc.Breaks) != 0 || pc.From != "2026-06-27" || pc.To != "2026-06-28" || pc.Rows[1].Label != labelInterest {
		t.Fatalf("posted order: breaks %v, %s to %s", pc.Breaks, pc.From, pc.To)
	}

	// The middle row's ₹500 is missing from the file: its balance jumps.
	csv := "Txn Date,Description,Debit,Credit,Balance\n" +
		"01/04/2026,OPENING CASH DEPOSIT,,1000.00,1000.00\n" +
		"03/04/2026,ATM WDL,200.00,,800.00\n" +
		"05/04/2026,ATM WDL,100.00,,200.00\n"
	var c checkResp
	me.do("POST", "/api/statements/check", map[string]any{"csv": csv, "accountId": bank.ID}, 200, &c)
	if len(c.Breaks) != 1 || c.Breaks[0] != 2 || c.Opening == nil || *c.Opening != 0 {
		t.Fatalf("breaks %v opening %v", c.Breaks, c.Opening)
	}
}
