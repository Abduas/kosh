package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

type client struct {
	t   *testing.T
	srv *httptest.Server
	hc  *http.Client
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	db, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	srv := httptest.NewServer(newServer(db))
	t.Cleanup(srv.Close)
	return srv
}

func newClient(t *testing.T, srv *httptest.Server) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, srv: srv, hc: &http.Client{Jar: jar}}
}

// do sends a JSON request, checks the status and decodes the response into out.
func (c *client) do(method, path string, body any, want int, out any) {
	c.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.srv.URL+path, r)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != want {
		c.t.Fatalf("%s %s: got %d, want %d: %s", method, path, resp.StatusCode, want, data)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s: decode: %v: %s", method, path, err, data)
		}
	}
}

type idResp struct {
	ID int64 `json:"id"`
}

func TestFinanceFlow(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)

	var status map[string]bool
	me.do("GET", "/api/auth/status", nil, 200, &status)
	if !status["needsSetup"] || status["signedIn"] {
		t.Fatalf("fresh app status = %v", status)
	}
	me.do("GET", "/api/bootstrap", nil, 401, nil)
	me.do("POST", "/api/auth/setup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "short"}, 400, nil)
	me.do("POST", "/api/auth/setup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "correct horse"}, 201, nil)

	// A second setup must fail once someone owns the app.
	other := newClient(t, srv)
	other.do("POST", "/api/auth/setup", map[string]string{"name": "X", "username": "intruder", "password": "password123"}, 403, nil)
	other.do("POST", "/api/auth/login", map[string]string{"username": "abdullah", "password": "wrong password"}, 401, nil)

	var boot struct {
		Accounts   []account  `json:"accounts"`
		Categories []category `json:"categories"`
		People     []person   `json:"people"`
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	if len(boot.Accounts) != 1 || boot.Accounts[0].Kind != "cash" {
		t.Fatalf("expected a seeded Cash account, got %+v", boot.Accounts)
	}
	cash := boot.Accounts[0].ID
	var food, salary int64
	for _, c := range boot.Categories {
		if c.Name == "Food & Dining" {
			food = c.ID
		}
		if c.Name == "Salary" {
			salary = c.ID
		}
	}

	var bank, rahul idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "HDFC", "kind": "bank", "color": "#3B82F6", "icon": "🏦", "openingBalance": 50_000_00, "last4": "1234"}, 201, &bank)
	me.do("POST", "/api/accounts", map[string]any{"name": "Bad", "kind": "bank", "color": "#3B82F6", "icon": "🏦", "last4": "12a4"}, 400, nil)
	me.do("POST", "/api/people", map[string]any{"name": "Rahul", "color": "#F97316"}, 201, &rahul)

	tx := func(body map[string]any, want int) {
		t.Helper()
		if _, ok := body["occurredAt"]; !ok {
			body["occurredAt"] = "2026-10-20T10:30"
		}
		me.do("POST", "/api/transactions", body, want, nil)
	}
	tx(map[string]any{"kind": "income", "amount": 80_000_00, "accountId": bank.ID, "categoryId": salary}, 201)
	tx(map[string]any{"kind": "expense", "amount": 450_50, "accountId": bank.ID, "categoryId": food, "note": "Biryani"}, 201)
	tx(map[string]any{"kind": "transfer", "amount": 5_000_00, "accountId": bank.ID, "toAccountId": cash}, 201)
	tx(map[string]any{"kind": "lend", "amount": 2_000_00, "accountId": cash, "personId": rahul.ID}, 201)
	tx(map[string]any{"kind": "collect", "amount": 500_00, "accountId": bank.ID, "personId": rahul.ID}, 201)
	tx(map[string]any{"kind": "borrow", "amount": 300_00, "accountId": cash, "personId": rahul.ID}, 201)

	// Invalid shapes
	tx(map[string]any{"kind": "expense", "amount": 100, "accountId": bank.ID, "categoryId": salary}, 400) // income category on expense
	tx(map[string]any{"kind": "transfer", "amount": 100, "accountId": bank.ID, "toAccountId": bank.ID}, 400)
	tx(map[string]any{"kind": "lend", "amount": 100, "accountId": cash}, 400)
	tx(map[string]any{"kind": "expense", "amount": 0, "accountId": cash}, 400)
	tx(map[string]any{"kind": "expense", "amount": 100, "accountId": cash, "occurredAt": "yesterday"}, 400)

	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	balances := map[int64]int64{}
	for _, a := range boot.Accounts {
		balances[a.ID] = a.Balance
	}
	// HDFC: 50,000 + 80,000 - 450.50 - 5,000 + 500 = 1,25,049.50
	if got := balances[bank.ID]; got != 125_049_50 {
		t.Errorf("bank balance = %d, want 12504950", got)
	}
	// Cash: 5,000 - 2,000 + 300 = 3,300
	if got := balances[cash]; got != 3_300_00 {
		t.Errorf("cash balance = %d, want 330000", got)
	}
	// Rahul: lent 2,000, paid back 500, then lent me 300 → owes 1,200
	if got := boot.People[0].Balance; got != 1_200_00 {
		t.Errorf("Rahul owes = %d, want 120000", got)
	}

	// Search by note and by amount, filter by person.
	var page struct {
		Items      []transaction `json:"items"`
		NextCursor *string       `json:"nextCursor"`
	}
	me.do("GET", "/api/transactions?q=biryani", nil, 200, &page)
	if len(page.Items) != 1 || page.Items[0].Amount != 450_50 {
		t.Errorf("search by note: %+v", page.Items)
	}
	me.do("GET", "/api/transactions?q=450.50", nil, 200, &page)
	if len(page.Items) != 1 {
		t.Errorf("search by amount: %+v", page.Items)
	}
	me.do("GET", fmt.Sprintf("/api/transactions?person=%d", rahul.ID), nil, 200, &page)
	if len(page.Items) != 3 {
		t.Errorf("person filter: got %d", len(page.Items))
	}

	// Paging walks every transaction exactly once.
	seen := map[int64]bool{}
	path := "/api/transactions?limit=2"
	for {
		me.do("GET", path, nil, 200, &page)
		for _, it := range page.Items {
			if seen[it.ID] {
				t.Fatalf("transaction %d returned twice", it.ID)
			}
			seen[it.ID] = true
		}
		if page.NextCursor == nil {
			break
		}
		path = "/api/transactions?limit=2&cursor=" + strings.ReplaceAll(*page.NextCursor, "|", "%7C")
	}
	if len(seen) != 6 {
		t.Errorf("paged through %d transactions, want 6", len(seen))
	}

	// Editing a transaction changes its kind cleanly.
	first := page.Items[0].ID
	me.do("PATCH", fmt.Sprintf("/api/transactions/%d", first), map[string]any{"kind": "expense", "amount": 100_00, "accountId": cash, "categoryId": food, "toAccountId": nil, "personId": nil}, 200, nil)

	var ins struct {
		Totals     map[string]int64 `json:"totals"`
		Categories []categoryTotal  `json:"categories"`
		Series     []seriesPoint    `json:"series"`
	}
	me.do("GET", "/api/insights?from=2026-10-01&to=2026-10-31", nil, 200, &ins)
	if ins.Totals["income"] != 80_000_00 || len(ins.Series) != 31 {
		t.Errorf("insights totals=%v series=%d", ins.Totals, len(ins.Series))
	}

	var history []struct {
		Date    string `json:"date"`
		Balance int64  `json:"balance"`
	}
	me.do("GET", "/api/insights/balance?days=10&today=2026-10-25", nil, 200, &history)
	if len(history) != 10 || history[9].Date != "2026-10-25" {
		t.Fatalf("history = %+v", history)
	}
	if history[0].Balance != 50_000_00 {
		t.Errorf("balance before any transaction = %d, want opening 5000000", history[0].Balance)
	}

	me.do("PUT", "/api/budgets", map[string]any{"categoryId": food, "amount": 6_000_00}, 204, nil)
	me.do("PUT", "/api/budgets", map[string]any{"categoryId": food, "amount": 7_000_00}, 204, nil)
	me.do("PUT", "/api/budgets", map[string]any{"categoryId": salary, "amount": 7_000_00}, 400, nil)
	var budgets []budget
	me.do("GET", "/api/budgets?month=2026-10", nil, 200, &budgets)
	if len(budgets) != 1 || budgets[0].Amount != 7_000_00 || budgets[0].Spent == 0 {
		t.Errorf("budgets = %+v", budgets)
	}

	// Accounts and people with history can't be deleted.
	me.do("DELETE", fmt.Sprintf("/api/accounts/%d", bank.ID), nil, 409, nil)
	me.do("DELETE", fmt.Sprintf("/api/people/%d", rahul.ID), nil, 409, nil)

	// Cross-site writes are refused.
	req, _ := http.NewRequest("POST", srv.URL+"/api/people", strings.NewReader(`{"name":"X","color":"#000000"}`))
	req.Header.Set("Origin", "https://evil.example")
	resp, err := me.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Errorf("cross-origin write: got %d, want 403", resp.StatusCode)
	}

	me.do("POST", "/api/auth/logout", nil, 204, nil)
	me.do("GET", "/api/bootstrap", nil, 401, nil)
}

func TestUsersCannotTouchEachOthersData(t *testing.T) {
	db, err := openDB(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	srv := httptest.NewServer(newServer(db))
	defer srv.Close()

	owner := newClient(t, srv)
	owner.do("POST", "/api/auth/setup", map[string]string{"name": "Owner", "username": "owner", "password": "password123"}, 201, nil)
	var acc, per idResp
	owner.do("POST", "/api/accounts", map[string]any{"name": "SBI", "kind": "bank", "color": "#3B82F6", "icon": "🏦"}, 201, &acc)
	owner.do("POST", "/api/people", map[string]any{"name": "Rahul", "color": "#F97316"}, 201, &per)

	// A second user, inserted directly since sign-up is owner-only for now.
	hash, _ := bcrypt.GenerateFromPassword([]byte("password456"), 4)
	res, err := db.Exec(`INSERT INTO users (username, name, password_hash) VALUES ('guest', 'Guest', ?)`, string(hash))
	if err != nil {
		t.Fatal(err)
	}
	guestID, _ := res.LastInsertId()
	if _, err := db.Exec(`INSERT INTO accounts (user_id, name, kind, color, icon) VALUES (?, 'Wallet', 'cash', '#22C55E', '💵')`, guestID); err != nil {
		t.Fatal(err)
	}

	guest := newClient(t, srv)
	guest.do("POST", "/api/auth/login", map[string]string{"username": "guest", "password": "password456"}, 200, nil)

	var boot struct {
		Accounts []account `json:"accounts"`
		People   []person  `json:"people"`
	}
	guest.do("GET", "/api/bootstrap", nil, 200, &boot)
	if len(boot.Accounts) != 1 || boot.Accounts[0].Name != "Wallet" || len(boot.People) != 0 {
		t.Fatalf("guest sees someone else's data: %+v", boot)
	}
	guestAcc := boot.Accounts[0].ID

	guest.do("PATCH", fmt.Sprintf("/api/accounts/%d", acc.ID), map[string]any{"name": "pwned"}, 404, nil)
	guest.do("DELETE", fmt.Sprintf("/api/people/%d", per.ID), nil, 204, nil) // a no-op for a row they don't own
	guest.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 100, "accountId": acc.ID, "occurredAt": "2026-10-01T10:00"}, 400, nil)
	guest.do("POST", "/api/transactions", map[string]any{"kind": "lend", "amount": 100, "accountId": guestAcc, "personId": per.ID, "occurredAt": "2026-10-01T10:00"}, 400, nil)
	guest.do("POST", "/api/transactions", map[string]any{"kind": "transfer", "amount": 100, "accountId": guestAcc, "toAccountId": acc.ID, "occurredAt": "2026-10-01T10:00"}, 400, nil)

	var ownerBoot struct {
		Accounts []account `json:"accounts"`
		People   []person  `json:"people"`
	}
	owner.do("GET", "/api/bootstrap", nil, 200, &ownerBoot)
	if len(ownerBoot.People) != 1 {
		t.Fatalf("guest deleted the owner's person")
	}
	for _, a := range ownerBoot.Accounts {
		if a.Name == "pwned" {
			t.Fatalf("guest renamed the owner's account")
		}
	}
}

func TestPayeeMemory(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/setup", map[string]string{"name": "A", "username": "payer", "password": "password123"}, 201, nil)
	var boot struct {
		Accounts   []idResp `json:"accounts"`
		Categories []struct {
			ID   int64  `json:"id"`
			Kind string `json:"kind"`
		} `json:"categories"`
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	cash := boot.Accounts[0].ID
	food := boot.Categories[0].ID

	var mem payeeMemory
	me.do("GET", "/api/payees?vpa=shop@okaxis", nil, 200, &mem)
	if mem.Known {
		t.Fatalf("unknown payee reported as known: %+v", mem)
	}
	me.do("GET", "/api/payees", nil, 400, nil)

	tx := map[string]any{"kind": "expense", "amount": 4500, "accountId": cash, "categoryId": food, "occurredAt": "2026-10-27T10:00", "source": "upi-scan", "payee": " Shop@OKAXIS "}
	var created transaction
	me.do("POST", "/api/transactions", tx, 201, &created)
	if created.Source != "upi-scan" || created.Payee != "shop@okaxis" {
		t.Fatalf("source/payee not stored: %+v", created)
	}

	me.do("GET", "/api/payees?vpa=SHOP@okaxis", nil, 200, &mem)
	if !mem.Known || mem.Kind != "expense" || mem.AccountID != cash || mem.CategoryID == nil || *mem.CategoryID != food || mem.Count != 1 || mem.LastAmount != 4500 {
		t.Fatalf("payee memory = %+v", mem)
	}

	// Editing without source/payee keeps them.
	var edited transaction
	me.do("PATCH", fmt.Sprintf("/api/transactions/%d", created.ID), map[string]any{"amount": 5000, "categoryId": food}, 200, &edited)
	if edited.Source != "upi-scan" || edited.Payee != "shop@okaxis" {
		t.Fatalf("edit dropped source/payee: %+v", edited)
	}

	// Search finds it by UPI ID.
	var page struct {
		Items []transaction `json:"items"`
	}
	me.do("GET", "/api/transactions?q=okaxis", nil, 200, &page)
	if len(page.Items) != 1 {
		t.Fatalf("search by payee found %d", len(page.Items))
	}

	bad := map[string]any{"kind": "expense", "amount": 100, "accountId": cash, "occurredAt": "2026-10-27T10:00"}
	bad["source"] = "sms"
	me.do("POST", "/api/transactions", bad, 400, nil)
	bad["source"] = "upi-scan"
	bad["payee"] = "not-a-vpa"
	me.do("POST", "/api/transactions", bad, 400, nil)

	// Payee memory needs a session.
	other := newClient(t, srv)
	other.do("GET", "/api/payees?vpa=shop@okaxis", nil, 401, nil)
}
