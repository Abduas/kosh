package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AI agents use Kosh through a small set of tools. The same tools are served
// over MCP (Grok, ChatGPT, Claude: mcp.go) and over a plain HTTP API for
// agents with their own computer (Instinct, OpenClaw: agentapi.go).
//
// Tools run the app's own API handlers, so an agent's entry is checked and
// linked (vehicle costs, Money) exactly like one typed in the app. Amounts
// go in and out in rupees, and names work wherever an id does.
//
// What an agent can't do: move money (Kosh only records), change settings,
// or delete anything it didn't add itself.

type agentCaller struct {
	uid    int64
	connID int64
	name   string
	scope  string // "read" or "write"
}

type agentTool struct {
	name        string
	description string
	write       bool
	params      []toolParam
	run         func(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error)
}

type toolParam struct {
	name, kind, about string // kind: string, number, boolean
	required          bool
	enum              []string
}

// schema is the tool's JSON Schema for MCP.
func (t agentTool) schema() map[string]any {
	props := map[string]any{}
	req := []string{}
	for _, p := range t.params {
		x := map[string]any{"type": p.kind, "description": p.about}
		if len(p.enum) > 0 {
			x["enum"] = p.enum
		}
		props[p.name] = x
		if p.required {
			req = append(req, p.name)
		}
	}
	return map[string]any{"type": "object", "properties": props, "required": req, "additionalProperties": false}
}

// errTool is a mistake the agent can fix; its message goes back to it.
type errTool string

func (e errTool) Error() string { return string(e) }

// ---- Calling the app's own handlers ----

// call runs one of the app's handlers as uid and decodes its JSON answer.
func (a *api) call(ctx context.Context, h authedHandler, method, target string, uid int64, body any, pathID int64, out any) error {
	var r *http.Request
	if body != nil {
		b, _ := json.Marshal(body)
		r = httptest.NewRequestWithContext(ctx, method, target, bytes.NewReader(b))
	} else {
		r = httptest.NewRequestWithContext(ctx, method, target, nil)
	}
	r.Header.Set("Content-Type", "application/json")
	if pathID != 0 {
		r.SetPathValue("id", strconv.FormatInt(pathID, 10))
	}
	w := httptest.NewRecorder()
	h(w, r, uid)
	if w.Code >= 400 {
		var e struct {
			Error string `json:"error"`
		}
		json.Unmarshal(w.Body.Bytes(), &e)
		if w.Code >= 500 {
			return fmt.Errorf("kosh: %s", e.Error)
		}
		return errTool(e.Error)
	}
	if out != nil && w.Body.Len() > 0 {
		return json.Unmarshal(w.Body.Bytes(), out)
	}
	return nil
}

// ---- Arguments ----

func argString(args map[string]any, k string) string {
	switch v := args[k].(type) {
	case string:
		return strings.TrimSpace(v)
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	}
	return ""
}

func argNumber(args map[string]any, k string) (float64, bool) {
	switch v := args[k].(type) {
	case float64:
		return v, true
	case string:
		f, err := strconv.ParseFloat(strings.NewReplacer(",", "", "₹", "", "Rs", "", "rs", "", " ", "").Replace(v), 64)
		return f, err == nil
	}
	return 0, false
}

func argBool(args map[string]any, k string) bool {
	switch v := args[k].(type) {
	case bool:
		return v
	case string:
		return v == "true" || v == "yes"
	}
	return false
}

// paise turns rupees (as an agent writes them) into minor units.
func paise(args map[string]any, k string) (int64, error) {
	f, ok := argNumber(args, k)
	if !ok {
		return 0, nil
	}
	if f < 0 || f > 1e13 || math.IsNaN(f) {
		return 0, errTool(k + " must be a positive number of rupees")
	}
	return int64(math.Round(f * 100)), nil
}

func rupees(minor int64) float64 { return float64(minor) / 100 }

var dateRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}`)

// localTime is a date or date-time for a transaction, defaulting to now in India.
func agentTime(s string) (string, error) {
	if s == "" {
		return time.Now().In(reminderZone).Format(localTimeLayout), nil
	}
	if !dateRe.MatchString(s) {
		return "", errTool("dates are YYYY-MM-DD or YYYY-MM-DDTHH:MM")
	}
	if len(s) == 10 {
		if s == time.Now().In(reminderZone).Format(dateLayout) {
			return time.Now().In(reminderZone).Format(localTimeLayout), nil
		}
		return s + "T12:00", nil
	}
	return s, nil
}

// ---- Looking things up by name or id ----

type lookup struct {
	accounts   []account
	categories []category
	people     []person
	vehicles   []vehicle
}

func (a *api) lookups(ctx context.Context, uid int64) (*lookup, error) {
	var l lookup
	var err error
	if l.accounts, err = a.loadAccounts(ctx, uid, 0); err != nil {
		return nil, err
	}
	if l.categories, err = a.loadCategories(ctx, uid, 0); err != nil {
		return nil, err
	}
	if l.people, err = a.loadPeople(ctx, uid, 0); err != nil {
		return nil, err
	}
	if l.vehicles, err = a.loadVehicles(ctx, uid, 0); err != nil {
		return nil, err
	}
	return &l, nil
}

func norm(s string) string { return strings.ToLower(strings.Join(strings.Fields(s), " ")) }

// pick finds by id, exact name, then a unique name that starts with or
// contains what was asked.
func pick[T any](items []T, what, kind string, id func(T) int64, name func(T) string, ok func(T) bool) (T, error) {
	var zero T
	if what == "" {
		return zero, errTool("say which " + kind)
	}
	if n, err := strconv.ParseInt(what, 10, 64); err == nil {
		for _, x := range items {
			if id(x) == n && ok(x) {
				return x, nil
			}
		}
	}
	w := norm(what)
	var starts, contains []T
	for _, x := range items {
		if !ok(x) {
			continue
		}
		n := norm(name(x))
		if n == w {
			return x, nil
		}
		if strings.HasPrefix(n, w) {
			starts = append(starts, x)
		} else if strings.Contains(n, w) || strings.Contains(w, n) {
			contains = append(contains, x)
		}
	}
	for _, list := range [][]T{starts, contains} {
		if len(list) == 1 {
			return list[0], nil
		}
		if len(list) > 1 {
			names := make([]string, len(list))
			for i, x := range list {
				names[i] = name(x)
			}
			return zero, errTool(fmt.Sprintf("%q matches more than one %s: %s. Be more specific.", what, kind, strings.Join(names, ", ")))
		}
	}
	all := []string{}
	for _, x := range items {
		if ok(x) {
			all = append(all, name(x))
		}
	}
	return zero, errTool(fmt.Sprintf("no %s called %q. Yours: %s", kind, what, strings.Join(all, ", ")))
}

func (l *lookup) account(what string) (account, error) {
	if what == "" {
		// The only one, or cash.
		var active []account
		for _, x := range l.accounts {
			if !x.Archived {
				active = append(active, x)
			}
		}
		if len(active) == 1 {
			return active[0], nil
		}
		return account{}, errTool("say which account it was paid from (or to)")
	}
	return pick(l.accounts, what, "account", func(x account) int64 { return x.ID }, func(x account) string { return x.Name }, func(x account) bool { return !x.Archived })
}

func (l *lookup) category(kind, what string) (*int64, error) {
	if what == "" {
		return nil, nil
	}
	c, err := pick(l.categories, what, kind+" category", func(x category) int64 { return x.ID }, func(x category) string { return x.Name },
		func(x category) bool { return x.Kind == kind && !x.Archived })
	if err != nil {
		return nil, err
	}
	return &c.ID, nil
}

func (l *lookup) vehicle(what string) (vehicle, error) {
	if what == "" {
		var active []vehicle
		for _, v := range l.vehicles {
			if !v.Archived {
				active = append(active, v)
			}
		}
		if len(active) == 1 {
			return active[0], nil
		}
		return vehicle{}, errTool("say which vehicle")
	}
	reg := normalizeReg(what)
	for _, v := range l.vehicles {
		if v.RegNumber != "" && v.RegNumber == reg {
			return v, nil
		}
	}
	return pick(l.vehicles, what, "vehicle", func(x vehicle) int64 { return x.ID }, func(x vehicle) string { return x.Name }, func(x vehicle) bool { return !x.Archived })
}

// agentAccount is the account asked for or, when none was named, their
// usual one: the Scan & pay default, else the one they used last.
func (a *api) agentAccount(ctx context.Context, uid int64, l *lookup, what string) (account, bool, error) {
	if what != "" {
		x, err := l.account(what)
		return x, false, err
	}
	if x, err := l.account(""); err == nil {
		return x, false, nil
	}
	var prefs struct {
		UpiAccountID int64 `json:"upiAccountId"`
	}
	if u, err := a.loadUser(ctx, uid); err == nil {
		json.Unmarshal(u.Prefs, &prefs)
	}
	var last int64
	a.db.QueryRowContext(ctx, `SELECT account_id FROM transactions WHERE user_id = ? AND kind = 'expense' ORDER BY created_at DESC, id DESC LIMIT 1`, uid).Scan(&last)
	for _, id := range []int64{prefs.UpiAccountID, last} {
		for _, x := range l.accounts {
			if id != 0 && x.ID == id && !x.Archived {
				return x, true, nil
			}
		}
	}
	_, err := l.account("")
	return account{}, false, err
}

// person finds someone, or adds them when create is set (lending to a new friend).
func (a *api) agentPerson(ctx context.Context, uid int64, l *lookup, what string, create bool) (int64, error) {
	p, err := pick(l.people, what, "person", func(x person) int64 { return x.ID }, func(x person) string { return x.Name }, func(x person) bool { return !x.Archived })
	if err == nil {
		return p.ID, nil
	}
	if !create || what == "" || strings.Contains(err.Error(), "more than one") {
		return 0, err
	}
	var made person
	colors := []string{"#F97316", "#3B82F6", "#22C55E", "#EC4899", "#8B5CF6", "#14B8A6"}
	if err := a.call(ctx, a.createPerson, "POST", "/api/people", uid, map[string]any{"name": what, "color": colors[len(l.people)%len(colors)]}, 0, &made); err != nil {
		return 0, err
	}
	return made.ID, nil
}

// ---- What the agent sees ----

type txView struct {
	ID       int64   `json:"id"`
	Date     string  `json:"date"`
	Type     string  `json:"type"`
	Amount   float64 `json:"amount"`
	Account  string  `json:"account"`
	To       string  `json:"toAccount,omitempty"`
	Category string  `json:"category,omitempty"`
	Person   string  `json:"person,omitempty"`
	Note     string  `json:"note,omitempty"`
	Vehicle  string  `json:"vehicle,omitempty"`
	AddedBy  string  `json:"addedBy,omitempty"`
}

func (l *lookup) view(t transaction) txView {
	v := txView{ID: t.ID, Date: t.OccurredAt, Type: t.Kind, Amount: rupees(t.Amount), Note: t.Note}
	for _, x := range l.accounts {
		if x.ID == t.AccountID {
			v.Account = x.Name
		}
		if t.ToAccountID != nil && x.ID == *t.ToAccountID {
			v.To = x.Name
		}
	}
	for _, x := range l.categories {
		if t.CategoryID != nil && x.ID == *t.CategoryID {
			v.Category = x.Name
		}
	}
	for _, x := range l.people {
		if t.PersonID != nil && x.ID == *t.PersonID {
			v.Person = x.Name
		}
	}
	if len(t.Vehicle) > 0 {
		var link vehicleLink
		json.Unmarshal(t.Vehicle, &link)
		for _, x := range l.vehicles {
			if x.ID == link.VehicleID {
				v.Vehicle = x.Name
			}
		}
	}
	switch {
	case t.Source == "agent":
		v.AddedBy = "an agent"
	case t.Source == "sms":
		v.AddedBy = "bank message"
	}
	return v
}

// ---- The tools ----

var agentTools = []agentTool{
	{
		name:        "get_overview",
		description: "Start here. Today's date, balances by account, this month's spending and income, who owes whom, which payment apps the person uses, vehicles, and anything due soon (insurance, PUC, tax, services).",
		run:         toolOverview,
	},
	{
		name:        "list_transactions",
		description: "Transactions, newest first. All filters are optional; account, category, person and vehicle take a name or id.",
		params: []toolParam{
			{name: "from", kind: "string", about: "First day, YYYY-MM-DD"},
			{name: "to", kind: "string", about: "Last day, YYYY-MM-DD"},
			{name: "search", kind: "string", about: "Text in the note, category, person or account, or an exact amount"},
			{name: "type", kind: "string", about: "Comma-separated: expense, income, transfer, lend, borrow, collect, repay"},
			{name: "account", kind: "string", about: "Account name or id"},
			{name: "category", kind: "string", about: "Category name or id"},
			{name: "person", kind: "string", about: "Person name or id"},
			{name: "vehicle", kind: "string", about: "Vehicle name, registration number or id"},
			{name: "limit", kind: "number", about: "How many, 1-200 (default 50)"},
		},
		run: toolListTransactions,
	},
	{
		name:        "spending_summary",
		description: "Totals for a period: spent, income, money lent and borrowed, and spending by category.",
		params: []toolParam{
			{name: "from", kind: "string", about: "First day, YYYY-MM-DD", required: true},
			{name: "to", kind: "string", about: "Last day, YYYY-MM-DD", required: true},
		},
		run: toolSummary,
	},
	{
		name:        "get_lists",
		description: "The person's accounts, categories, people and vehicles, with ids. Use the names in other tools.",
		run:         toolLists,
	},
	{
		name:        "vehicle_status",
		description: "Vehicles with their papers (insurance, PUC, road tax, RC, licence) and expiry dates, service schedules and what's due, mileage, and recent fuel and service logs.",
		params:      []toolParam{{name: "vehicle", kind: "string", about: "Vehicle name, registration number or id; all vehicles when left out"}},
		run:         toolVehicleStatus,
	},
	{
		name: "add_transaction",
		description: "Record money that moved: an expense, income, a transfer between the person's accounts, or money lent/borrowed/repaid. " +
			"Kosh only records; it never sends money. Fuel or other costs for a vehicle: pass vehicle (and litres/odometer for fuel).",
		write: true,
		params: []toolParam{
			{name: "type", kind: "string", about: "What happened", required: true, enum: []string{"expense", "income", "transfer", "lend", "borrow", "collect", "repay"}},
			{name: "amount", kind: "number", about: "In rupees, like 249.50", required: true},
			{name: "account", kind: "string", about: "Account it came from (or went into, for income). Name or id; may be left out when there's only one."},
			{name: "to_account", kind: "string", about: "For a transfer: where it went"},
			{name: "category", kind: "string", about: "For expense/income: category name, like Food & Dining or Fuel"},
			{name: "person", kind: "string", about: "For lend/borrow/collect/repay: who. Someone new is added."},
			{name: "note", kind: "string", about: "What it was for, like 'Lunch at Meghana's'"},
			{name: "date", kind: "string", about: "YYYY-MM-DD or YYYY-MM-DDTHH:MM in India time; now when left out"},
			{name: "vehicle", kind: "string", about: "For an expense on a vehicle: its name or registration number"},
			{name: "litres", kind: "number", about: "Fuel only: litres filled"},
			{name: "odometer", kind: "number", about: "Vehicle only: odometer reading in km"},
			{name: "full_tank", kind: "boolean", about: "Fuel only: filled to full"},
		},
		run: toolAddTransaction,
	},
	{
		name:        "delete_transaction",
		description: "Delete a transaction this agent added (for example, one added by mistake). Others can't be deleted by an agent.",
		write:       true,
		params:      []toolParam{{name: "id", kind: "number", about: "The transaction's id", required: true}},
		run:         toolDeleteTransaction,
	},
	{
		name:        "add_vehicle_log",
		description: "Log fuel, a service, another vehicle cost or an odometer reading. With paid_from it's also recorded as an expense in Money.",
		write:       true,
		params: []toolParam{
			{name: "vehicle", kind: "string", about: "Name, registration number or id; may be left out with one vehicle"},
			{name: "type", kind: "string", about: "What it is", required: true, enum: []string{"fuel", "service", "expense", "odometer"}},
			{name: "date", kind: "string", about: "YYYY-MM-DD; today when left out"},
			{name: "amount", kind: "number", about: "Cost in rupees"},
			{name: "odometer", kind: "number", about: "Odometer reading in km"},
			{name: "litres", kind: "number", about: "Fuel only"},
			{name: "full_tank", kind: "boolean", about: "Fuel only"},
			{name: "title", kind: "string", about: "For a service or cost: what was done, like 'General service, Oil change' or 'Parking'"},
			{name: "note", kind: "string", about: "Garage or pump name"},
			{name: "paid_from", kind: "string", about: "Account it was paid from, to also record it in Money"},
		},
		run: toolAddVehicleLog,
	},
	{
		name:        "add_vehicle_paper",
		description: "Save a vehicle paper's details, such as a renewed insurance policy or a new PUC certificate, so Kosh reminds the person before it expires.",
		write:       true,
		params: []toolParam{
			{name: "type", kind: "string", about: "Which paper", required: true, enum: []string{"insurance", "puc", "road_tax", "rc", "fitness", "permit", "licence", "warranty", "other"}},
			{name: "vehicle", kind: "string", about: "Name, registration number or id (not needed for a driving licence)"},
			{name: "expires_on", kind: "string", about: "YYYY-MM-DD; leave out if it doesn't expire"},
			{name: "issued_on", kind: "string", about: "YYYY-MM-DD"},
			{name: "number", kind: "string", about: "Policy or certificate number"},
			{name: "issuer", kind: "string", about: "Insurer or issuing office"},
			{name: "amount", kind: "number", about: "Premium or fee in rupees"},
			{name: "paid_from", kind: "string", about: "Account the premium or fee was paid from, to also record it in Money"},
		},
		run: toolAddPaper,
	},
}

func findTool(name string) (agentTool, bool) {
	for _, t := range agentTools {
		if t.name == name {
			return t, true
		}
	}
	return agentTool{}, false
}

// ---- Limits ----

// A runaway agent loop shouldn't be able to flood someone's books.
type callLimiter struct {
	mu   sync.Mutex
	hits map[int64][]time.Time
}

var agentLimiter = &callLimiter{hits: map[int64][]time.Time{}}

func (l *callLimiter) allow(conn int64, write bool) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	list := l.hits[conn][:0]
	for _, t := range l.hits[conn] {
		if now.Sub(t) < time.Minute {
			list = append(list, t)
		}
	}
	max := 120
	if write {
		max = 40
	}
	if len(list) >= max {
		l.hits[conn] = list
		return false
	}
	l.hits[conn] = append(list, now)
	return true
}

// runTool checks the caller may use the tool, runs it and notes the use.
func (a *api) runTool(ctx context.Context, c agentCaller, name string, args map[string]any) (any, error) {
	t, ok := findTool(name)
	if !ok {
		return nil, errTool("no tool called " + name)
	}
	if t.write && c.scope != "write" {
		return nil, errTool("this connection is read-only; the person can allow changes in Kosh → Settings → AI agents")
	}
	if !agentLimiter.allow(c.connID, t.write) {
		return nil, errTool("too many requests; wait a minute")
	}
	if args == nil {
		args = map[string]any{}
	}
	a.db.ExecContext(ctx, `UPDATE agent_connections SET last_used_at = ? WHERE id = ?`, time.Now().UTC().Format(timeLayout), c.connID)
	return t.run(ctx, a, c, args)
}

// ---- Tool code ----

func toolOverview(ctx context.Context, a *api, c agentCaller, _ map[string]any) (any, error) {
	u, err := a.loadUser(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	var prefs struct {
		Modules    []string `json:"modules"`
		PayApps    []string `json:"payApps"`
		MonthStart int      `json:"monthStart"`
	}
	json.Unmarshal(u.Prefs, &prefs)
	if len(prefs.Modules) == 0 {
		prefs.Modules = []string{"finance"}
	}
	now := time.Now().In(reminderZone)
	out := map[string]any{
		"name":      u.Name,
		"today":     now.Format("2006-01-02 (Monday)"),
		"currency":  "INR, amounts in rupees",
		"uses":      prefs.Modules,
		"payApps":   prefs.PayApps,
		"addedHere": "Entries you add are marked as added by an agent in Kosh.",
	}
	accounts := []map[string]any{}
	var total int64
	for _, x := range l.accounts {
		if x.Archived {
			continue
		}
		accounts = append(accounts, map[string]any{"name": x.Name, "kind": x.Kind, "balance": rupees(x.Balance)})
		if x.IncludeInTotal {
			total += x.Balance
		}
	}
	out["accounts"] = accounts
	out["totalBalance"] = rupees(total)

	start := max(prefs.MonthStart, 1)
	from := time.Date(now.Year(), now.Month(), start, 0, 0, 0, 0, time.UTC)
	if now.Day() < start {
		from = from.AddDate(0, -1, 0)
	}
	to := from.AddDate(0, 1, -1)
	var sum map[string]any
	if s, err := toolSummary(ctx, a, c, map[string]any{"from": from.Format(dateLayout), "to": to.Format(dateLayout)}); err == nil {
		sum, _ = s.(map[string]any)
	}
	out["thisMonth"] = sum

	owed := []map[string]any{}
	for _, p := range l.people {
		if p.Balance != 0 && !p.Archived {
			owed = append(owed, map[string]any{"person": p.Name, "owesYou": rupees(p.Balance)})
		}
	}
	out["people"] = map[string]any{"note": "owesYou is negative when the person owes them", "balances": owed}

	if len(l.vehicles) > 0 {
		items, err := a.dueReminders(ctx, c.uid, reminderToday())
		if err == nil {
			due := []string{}
			for _, it := range items {
				due = append(due, it.title)
			}
			out["dueSoon"] = due
		}
		vs := []map[string]any{}
		for _, v := range l.vehicles {
			if !v.Archived {
				vs = append(vs, map[string]any{"name": v.Name, "kind": v.Kind, "registration": v.RegNumber, "odometerKm": v.Odometer})
			}
		}
		out["vehicles"] = vs
	}
	return out, nil
}

func toolListTransactions(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	for _, k := range []string{"from", "to"} {
		if v := argString(args, k); v != "" {
			q.Set(k, v)
		}
	}
	if v := argString(args, "search"); v != "" {
		q.Set("q", v)
	}
	if v := argString(args, "type"); v != "" {
		q.Set("kind", strings.ReplaceAll(v, " ", ""))
	}
	if v := argString(args, "account"); v != "" {
		x, err := l.account(v)
		if err != nil {
			return nil, err
		}
		q.Set("account", strconv.FormatInt(x.ID, 10))
	}
	if v := argString(args, "category"); v != "" {
		x, err := pick(l.categories, v, "category", func(x category) int64 { return x.ID }, func(x category) string { return x.Name }, func(category) bool { return true })
		if err != nil {
			return nil, err
		}
		q.Set("category", strconv.FormatInt(x.ID, 10))
	}
	if v := argString(args, "person"); v != "" {
		id, err := a.agentPerson(ctx, c.uid, l, v, false)
		if err != nil {
			return nil, err
		}
		q.Set("person", strconv.FormatInt(id, 10))
	}
	if v := argString(args, "vehicle"); v != "" {
		x, err := l.vehicle(v)
		if err != nil {
			return nil, err
		}
		q.Set("vehicle", strconv.FormatInt(x.ID, 10))
	}
	limit := 50
	if n, ok := argNumber(args, "limit"); ok && n >= 1 {
		limit = min(int(n), 200)
	}
	q.Set("limit", strconv.Itoa(limit))
	var page struct {
		Items []transaction `json:"items"`
	}
	if err := a.call(ctx, a.listTransactions, "GET", "/api/transactions?"+q.Encode(), c.uid, nil, 0, &page); err != nil {
		return nil, err
	}
	items := make([]txView, len(page.Items))
	for i, t := range page.Items {
		items[i] = l.view(t)
	}
	return map[string]any{"transactions": items, "count": len(items)}, nil
}

func toolSummary(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	from, to := argString(args, "from"), argString(args, "to")
	var in struct {
		Totals     map[string]int64 `json:"totals"`
		Categories []struct {
			Kind       string `json:"kind"`
			CategoryID *int64 `json:"categoryId"`
			Total      int64  `json:"total"`
			Count      int64  `json:"count"`
		} `json:"categories"`
	}
	if err := a.call(ctx, a.insights, "GET", "/api/insights?"+url.Values{"from": {from}, "to": {to}}.Encode(), c.uid, nil, 0, &in); err != nil {
		return nil, err
	}
	cats, err := a.loadCategories(ctx, c.uid, 0)
	if err != nil {
		return nil, err
	}
	names := map[int64]string{}
	for _, x := range cats {
		names[x.ID] = x.Name
	}
	spending := []map[string]any{}
	for _, x := range in.Categories {
		if x.Kind != "expense" {
			continue
		}
		name := "Uncategorised"
		if x.CategoryID != nil {
			name = names[*x.CategoryID]
		}
		spending = append(spending, map[string]any{"category": name, "spent": rupees(x.Total), "count": x.Count})
	}
	return map[string]any{
		"from": from, "to": to,
		"spent": rupees(in.Totals["expense"]), "income": rupees(in.Totals["income"]),
		"lent": rupees(in.Totals["lend"]), "borrowed": rupees(in.Totals["borrow"]),
		"byCategory": spending,
	}, nil
}

func toolLists(ctx context.Context, a *api, c agentCaller, _ map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	accounts, expense, income, people, vehicles := []any{}, []any{}, []any{}, []any{}, []any{}
	for _, x := range l.accounts {
		if !x.Archived {
			accounts = append(accounts, map[string]any{"id": x.ID, "name": x.Name, "kind": x.Kind})
		}
	}
	for _, x := range l.categories {
		if x.Archived {
			continue
		}
		item := map[string]any{"id": x.ID, "name": x.Name}
		if x.Kind == "expense" {
			expense = append(expense, item)
		} else {
			income = append(income, item)
		}
	}
	for _, x := range l.people {
		if !x.Archived {
			people = append(people, map[string]any{"id": x.ID, "name": x.Name})
		}
	}
	for _, x := range l.vehicles {
		if !x.Archived {
			vehicles = append(vehicles, map[string]any{"id": x.ID, "name": x.Name, "registration": x.RegNumber, "kind": x.Kind, "fuel": x.Fuel})
		}
	}
	return map[string]any{"accounts": accounts, "expenseCategories": expense, "incomeCategories": income, "people": people, "vehicles": vehicles}, nil
}

func toolVehicleStatus(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	var only int64
	if v := argString(args, "vehicle"); v != "" {
		x, err := l.vehicle(v)
		if err != nil {
			return nil, err
		}
		only = x.ID
	}
	docs, err := a.loadVehicleDocs(ctx, c.uid, 0)
	if err != nil {
		return nil, err
	}
	logs, err := a.loadVehicleLogs(ctx, c.uid, 0)
	if err != nil {
		return nil, err
	}
	today := reminderToday()
	rules, err := a.loadServiceRules(ctx, c.uid, today)
	if err != nil {
		return nil, err
	}
	paperView := func(d vehicleDoc) map[string]any {
		m := map[string]any{"type": d.Type, "name": d.label(), "number": d.Number, "issuer": d.Issuer, "issuedOn": d.IssuedOn}
		if d.ExpiresOn == nil {
			m["expires"] = "never"
		} else {
			m["expiresOn"] = *d.ExpiresOn
			if t, err := time.Parse(dateLayout, *d.ExpiresOn); err == nil {
				m["daysLeft"] = int(t.Sub(today).Hours() / 24)
			}
		}
		return m
	}
	current := currentDocsGo(docs)
	out := []map[string]any{}
	for _, v := range l.vehicles {
		if (only != 0 && v.ID != only) || (only == 0 && v.Archived) {
			continue
		}
		papers := []any{}
		for _, d := range current {
			if d.VehicleID != nil && *d.VehicleID == v.ID {
				papers = append(papers, paperView(d))
			}
		}
		services := []any{}
		for _, r := range rules {
			if r.VehicleID == v.ID {
				services = append(services, map[string]any{"what": r.Title, "everyKm": r.EveryKm, "everyMonths": r.EveryMonths, "lastDone": r.LastOn,
					"dueAtKm": r.NextKm, "kmLeft": r.KmLeft, "dueBy": r.NextOn, "likelyOn": r.GuessOn, "state": r.State})
			}
		}
		recent := []any{}
		for _, x := range logs {
			if x.VehicleID == v.ID && len(recent) < 10 {
				m := map[string]any{"date": x.OccurredOn, "type": x.Kind, "title": x.Title, "amount": rupees(x.Amount), "odometer": x.Odometer}
				if x.Litres != nil {
					m["litres"] = float64(*x.Litres) / 1000
				}
				recent = append(recent, m)
			}
		}
		out = append(out, map[string]any{"name": v.Name, "kind": v.Kind, "registration": v.RegNumber, "make": v.Make, "model": v.Model, "fuel": v.Fuel,
			"odometerKm": v.Odometer, "papers": papers, "services": services, "recentLogs": recent})
	}
	licence := []any{}
	for _, d := range current {
		if d.VehicleID == nil {
			licence = append(licence, paperView(d))
		}
	}
	return map[string]any{"today": today.Format(dateLayout), "vehicles": out, "personalPapers": licence}, nil
}

// markAgent labels an entry as added by this agent, so it can undo it.
func (a *api) markAgent(ctx context.Context, c agentCaller, txID int64) {
	a.db.ExecContext(ctx, `UPDATE transactions SET source = 'agent', ref = ? WHERE id = ? AND user_id = ?`, fmt.Sprintf("agent:%d", c.connID), txID, c.uid)
}

func toolAddTransaction(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	kind := argString(args, "type")
	amount, err := paise(args, "amount")
	if err != nil {
		return nil, err
	}
	if amount <= 0 {
		return nil, errTool("amount is required, in rupees")
	}
	acct, guessed, err := a.agentAccount(ctx, c.uid, l, argString(args, "account"))
	if err != nil {
		return nil, err
	}
	at, err := agentTime(argString(args, "date"))
	if err != nil {
		return nil, err
	}
	body := map[string]any{"kind": kind, "amount": amount, "accountId": acct.ID, "note": argString(args, "note"), "occurredAt": at,
		"toAccountId": nil, "categoryId": nil, "personId": nil}
	switch kind {
	case "expense", "income":
		cat, err := l.category(kind, argString(args, "category"))
		if err != nil {
			return nil, err
		}
		body["categoryId"] = cat
	case "transfer":
		to, err := l.account(argString(args, "to_account"))
		if err != nil {
			return nil, err
		}
		body["toAccountId"] = to.ID
	case "lend", "borrow", "collect", "repay":
		pid, err := a.agentPerson(ctx, c.uid, l, argString(args, "person"), kind == "lend" || kind == "borrow")
		if err != nil {
			return nil, err
		}
		body["personId"] = pid
	default:
		return nil, errTool("type must be expense, income, transfer, lend, borrow, collect or repay")
	}
	if v := argString(args, "vehicle"); v != "" && kind == "expense" {
		veh, err := l.vehicle(v)
		if err != nil {
			return nil, err
		}
		link := map[string]any{"vehicleId": veh.ID, "kind": "expense"}
		if cat, _ := body["categoryId"].(*int64); cat != nil {
			for _, x := range l.categories {
				if x.ID == *cat && strings.EqualFold(x.Name, "fuel") {
					link["kind"] = "fuel"
				}
			}
		}
		if _, ok := argNumber(args, "litres"); ok {
			link["kind"] = "fuel"
		}
		if km, ok := argNumber(args, "odometer"); ok {
			link["odometer"] = int64(km)
		}
		if lt, ok := argNumber(args, "litres"); ok && lt > 0 {
			link["litres"] = int64(math.Round(lt * 1000))
		}
		link["fullTank"] = argBool(args, "full_tank")
		body["vehicle"] = link
	}
	var t transaction
	if err := a.call(ctx, a.createTransaction, "POST", "/api/transactions", c.uid, body, 0, &t); err != nil {
		return nil, err
	}
	a.markAgent(ctx, c, t.ID)
	t.Source = "agent"
	l2, _ := a.lookups(ctx, c.uid)
	out := map[string]any{"saved": l2.view(t)}
	if guessed {
		out["note"] = "No account was given, so Kosh used " + acct.Name + ", their usual one. Mention it, and fix it if they say otherwise."
	}
	return out, nil
}

func toolDeleteTransaction(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	id, ok := argNumber(args, "id")
	if !ok {
		return nil, errTool("id is required")
	}
	var ref string
	err := a.db.QueryRowContext(ctx, `SELECT ref FROM transactions WHERE id = ? AND user_id = ?`, int64(id), c.uid).Scan(&ref)
	if err != nil {
		return nil, errTool("no such transaction")
	}
	if ref != fmt.Sprintf("agent:%d", c.connID) {
		return nil, errTool("an agent can only delete what it added itself; ask the person to delete this one in Kosh")
	}
	if err := a.call(ctx, a.deleteTransaction, "DELETE", "/api/transactions/x", c.uid, nil, int64(id), nil); err != nil {
		return nil, err
	}
	return map[string]any{"deleted": int64(id)}, nil
}

func toolAddVehicleLog(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	v, err := l.vehicle(argString(args, "vehicle"))
	if err != nil {
		return nil, err
	}
	date := argString(args, "date")
	if date == "" {
		date = reminderToday().Format(dateLayout)
	}
	amount, err := paise(args, "amount")
	if err != nil {
		return nil, err
	}
	body := map[string]any{"vehicleId": v.ID, "kind": argString(args, "type"), "occurredOn": date, "amount": amount,
		"title": argString(args, "title"), "note": argString(args, "note"), "fullTank": argBool(args, "full_tank")}
	if km, ok := argNumber(args, "odometer"); ok {
		body["odometer"] = int64(km)
	}
	if lt, ok := argNumber(args, "litres"); ok && lt > 0 {
		body["litres"] = int64(math.Round(lt * 1000))
	}
	if p := argString(args, "paid_from"); p != "" {
		acct, err := l.account(p)
		if err != nil {
			return nil, err
		}
		body["accountId"] = acct.ID
	}
	var saved vehicleLog
	if err := a.call(ctx, a.createVehicleLog, "POST", "/api/vehicle-logs", c.uid, body, 0, &saved); err != nil {
		return nil, err
	}
	if saved.TransactionID != nil {
		a.markAgent(ctx, c, *saved.TransactionID)
	}
	out := map[string]any{"vehicle": v.Name, "type": saved.Kind, "date": saved.OccurredOn, "amount": rupees(saved.Amount), "recordedInMoney": saved.TransactionID != nil}
	if saved.TransactionID != nil {
		out["transactionId"] = *saved.TransactionID
	}
	return out, nil
}

func toolAddPaper(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	typ := argString(args, "type")
	body := map[string]any{"type": typ, "expiresOn": argString(args, "expires_on"), "issuedOn": argString(args, "issued_on"),
		"number": argString(args, "number"), "issuer": argString(args, "issuer")}
	if typ != "licence" {
		v, err := l.vehicle(argString(args, "vehicle"))
		if err != nil {
			return nil, err
		}
		body["vehicleId"] = v.ID
	}
	amount, err := paise(args, "amount")
	if err != nil {
		return nil, err
	}
	body["amount"] = amount
	if p := argString(args, "paid_from"); p != "" && amount > 0 {
		acct, err := l.account(p)
		if err != nil {
			return nil, err
		}
		body["accountId"] = acct.ID
	}
	var d vehicleDoc
	if err := a.call(ctx, a.createVehicleDoc, "POST", "/api/vehicle-documents", c.uid, body, 0, &d); err != nil {
		return nil, err
	}
	if d.TransactionID != nil {
		a.markAgent(ctx, c, *d.TransactionID)
	}
	return map[string]any{"saved": d.label(), "expiresOn": d.ExpiresOn, "recordedInMoney": d.TransactionID != nil,
		"note": "Kosh will remind the person before it expires."}, nil
}
