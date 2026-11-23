package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
)

// Agents can change anything the person can change in the app: add and edit
// vehicles, accounts, categories and people, edit or delete any entry, write
// off loans, set budgets and service schedules. The named tools take names
// and rupees; kosh_api reaches every other part of the app's own API.
//
// What stays out of reach: the person's login (password, Google, erasing the
// account), who else can open their Kosh, agent connections, and the bank-
// message capture key. Kosh still only records; it never moves money.

func init() {
	agentTools = append(agentTools,
		agentTool{
			name:        "add_vehicle",
			description: "Add a vehicle to the garage, so fuel, services and papers (insurance, PUC, RC) can be recorded for it.",
			write:       true,
			params: []toolParam{
				{name: "name", kind: "string", about: "What they call it, like 'Passion Pro' or 'Swift'", required: true},
				{name: "type", kind: "string", about: "Kind of vehicle", required: true, enum: []string{"bike", "scooter", "car", "other"}},
				{name: "registration", kind: "string", about: "Registration number, like KL60D5941"},
				{name: "make", kind: "string", about: "Maker, like Hero or Maruti Suzuki"},
				{name: "model", kind: "string", about: "Model, like Passion Pro"},
				{name: "year", kind: "number", about: "Year made"},
				{name: "fuel", kind: "string", about: "Fuel (petrol when left out)", enum: []string{"petrol", "diesel", "cng", "ev", "hybrid"}},
				{name: "odometer", kind: "number", about: "Today's odometer reading in km"},
				{name: "color", kind: "string", about: "Hex color for the app, like #1E63D6"},
			},
			run: toolAddVehicle,
		},
		agentTool{
			name:        "update_vehicle",
			description: "Change a vehicle's details, or archive it (sold) with archived true. Only the fields given change.",
			write:       true,
			params: []toolParam{
				{name: "vehicle", kind: "string", about: "Which: name, registration number or id", required: true},
				{name: "name", kind: "string", about: "New name"},
				{name: "type", kind: "string", about: "Kind of vehicle", enum: []string{"bike", "scooter", "car", "other"}},
				{name: "registration", kind: "string", about: "Registration number"},
				{name: "make", kind: "string", about: "Maker"},
				{name: "model", kind: "string", about: "Model"},
				{name: "year", kind: "number", about: "Year made (0 clears it)"},
				{name: "fuel", kind: "string", about: "Fuel", enum: []string{"petrol", "diesel", "cng", "ev", "hybrid"}},
				{name: "color", kind: "string", about: "Hex color"},
				{name: "archived", kind: "boolean", about: "true to archive (sold, scrapped), false to bring back"},
			},
			run: toolUpdateVehicle,
		},
		agentTool{
			name:        "update_transaction",
			description: "Change any entry in Money: amount, type, account, category, person, note, date or the vehicle an expense was for. Only the fields given change. Find the id with list_transactions.",
			write:       true,
			params: []toolParam{
				{name: "id", kind: "number", about: "The transaction's id", required: true},
				{name: "type", kind: "string", about: "New type", enum: []string{"expense", "income", "transfer", "lend", "borrow", "collect", "repay"}},
				{name: "amount", kind: "number", about: "In rupees"},
				{name: "account", kind: "string", about: "Account name or id"},
				{name: "to_account", kind: "string", about: "For a transfer: where it went"},
				{name: "category", kind: "string", about: "For expense/income: category name"},
				{name: "person", kind: "string", about: "For lend/borrow/collect/repay: who. Someone new is added."},
				{name: "note", kind: "string", about: "What it was for"},
				{name: "date", kind: "string", about: "YYYY-MM-DD or YYYY-MM-DDTHH:MM in India time"},
				{name: "vehicle", kind: "string", about: "Expense only: link it to this vehicle (name, registration number or id), or 'none' to unlink it"},
				{name: "litres", kind: "number", about: "Fuel only: litres filled"},
				{name: "odometer", kind: "number", about: "Vehicle only: odometer reading in km"},
				{name: "full_tank", kind: "boolean", about: "Fuel only: filled to full"},
			},
			run: toolUpdateTransaction,
		},
		agentTool{
			name:        "save_account",
			description: "Add an account (bank, cash, wallet, card, savings, investment) or change one. Give account to change an existing one; leave it out to add a new one. Changing opening_balance moves the balance without adding an entry.",
			write:       true,
			params: []toolParam{
				{name: "account", kind: "string", about: "To change one: its name or id"},
				{name: "name", kind: "string", about: "Name, like 'HDFC Savings' (required for a new one)"},
				{name: "type", kind: "string", about: "Kind (required for a new one)", enum: []string{"bank", "cash", "wallet", "card", "savings", "investment"}},
				{name: "institution", kind: "string", about: "Bank or provider"},
				{name: "last4", kind: "string", about: "Last 4 digits of the account or card"},
				{name: "opening_balance", kind: "number", about: "Balance before the first entry, in rupees; negative for a card or loan owed"},
				{name: "include_in_total", kind: "boolean", about: "Count it in the total balance"},
				{name: "archived", kind: "boolean", about: "true to archive (closed account)"},
				{name: "icon", kind: "string", about: "An emoji"},
				{name: "color", kind: "string", about: "Hex color"},
			},
			run: toolSaveAccount,
		},
		agentTool{
			name:        "save_category",
			description: "Add a spending or income category, or change one (rename, icon, archive). Give category to change an existing one.",
			write:       true,
			params: []toolParam{
				{name: "category", kind: "string", about: "To change one: its name or id"},
				{name: "kind", kind: "string", about: "For a new one", enum: []string{"expense", "income"}},
				{name: "name", kind: "string", about: "Name (required for a new one)"},
				{name: "icon", kind: "string", about: "An emoji"},
				{name: "color", kind: "string", about: "Hex color"},
				{name: "archived", kind: "boolean", about: "true to archive"},
			},
			run: toolSaveCategory,
		},
		agentTool{
			name:        "save_person",
			description: "Add someone they lend to or borrow from, or change their name, phone or note, or archive them. Give person to change an existing one.",
			write:       true,
			params: []toolParam{
				{name: "person", kind: "string", about: "To change one: their name or id"},
				{name: "name", kind: "string", about: "Name (required for someone new)"},
				{name: "phone", kind: "string", about: "Phone number"},
				{name: "note", kind: "string", about: "A note"},
				{name: "archived", kind: "boolean", about: "true to archive"},
			},
			run: toolSavePerson,
		},
		agentTool{
			name: "write_off_loan",
			description: "Someone won't pay back what they owe: turn that money into an expense. Their latest loans become expenses on the days they were lent, " +
				"so no account balance moves; the person's balance goes down.",
			write: true,
			params: []toolParam{
				{name: "person", kind: "string", about: "Who: name or id", required: true},
				{name: "amount", kind: "number", about: "Rupees that won't come back; all they owe when left out"},
				{name: "category", kind: "string", about: "Expense category; 'Money not returned' when left out"},
				{name: "note", kind: "string", about: "Why, like 'Forgave it'"},
			},
			run: toolWriteOff,
		},
		agentTool{
			name:        "set_budget",
			description: "Set a monthly budget for a spending category, or the overall monthly budget when category is left out.",
			write:       true,
			params: []toolParam{
				{name: "category", kind: "string", about: "Expense category; leave out for the overall budget"},
				{name: "amount", kind: "number", about: "Rupees per month", required: true},
			},
			run: toolSetBudget,
		},
		agentTool{
			name:        "save_service_rule",
			description: "Set how often a vehicle needs a service (like 'General service' every 3000 km or 6 months), so Kosh reminds them. Give rule to change an existing one.",
			write:       true,
			params: []toolParam{
				{name: "vehicle", kind: "string", about: "Name, registration number or id; may be left out with one vehicle"},
				{name: "rule", kind: "string", about: "To change one: its title or id (see vehicle_status)"},
				{name: "title", kind: "string", about: "What's done, like 'General service' or 'Chain lube'"},
				{name: "every_km", kind: "number", about: "Every so many km (0 clears it)"},
				{name: "every_months", kind: "number", about: "Every so many months (0 clears it)"},
			},
			run: toolSaveRule,
		},
		agentTool{
			name:        "delete",
			description: "Delete something for good. Accounts, categories and people with entries can't be deleted; archive them instead. Ids are in get_lists, list_transactions and vehicle_status.",
			write:       true,
			destructive: true,
			params: []toolParam{
				{name: "what", kind: "string", about: "What kind of thing", required: true,
					enum: []string{"transaction", "account", "category", "person", "vehicle", "vehicle_log", "vehicle_paper", "service_rule", "budget"}},
				{name: "id", kind: "number", about: "Its id", required: true},
			},
			run: toolDelete,
		},
		agentTool{
			name:        "interest_summary",
			description: "Interest the banks paid them (they don't keep interest), what they've given away, and what's left to give, by year.",
			run:         toolInterest,
		},
		agentTool{
			name: "kosh_api",
			description: "Anything else the Kosh app can do, through its own API. Amounts here are in paise (₹1 = 100) and things are named by id. " +
				"Reads (GET) work on any connection; changes need permission to add. Routes: " + strings.Join(koshAPIRoutes(), "; ") + ".",
			mayWrite: true,
			params: []toolParam{
				{name: "method", kind: "string", about: "HTTP method", required: true, enum: []string{"GET", "POST", "PATCH", "PUT", "DELETE"}},
				{name: "path", kind: "string", about: "Like /api/transactions?from=2026-11-01 or /api/vehicle-logs/12", required: true},
				{name: "body", kind: "object", about: "JSON body for POST, PATCH and PUT"},
			},
			run: toolKoshAPI,
		},
	)
}

// ---- Helpers ----

// signedPaise is rupees that may be negative, as paise; ok is false when absent.
func signedPaise(args map[string]any, k string) (int64, bool, error) {
	f, ok := argNumber(args, k)
	if !ok {
		return 0, false, nil
	}
	if math.Abs(f) > 1e13 || math.IsNaN(f) {
		return 0, false, errTool(k + " must be a number of rupees")
	}
	return int64(math.Round(f * 100)), true, nil
}

// copyArgs puts each agent argument that was given into body under its API name.
func copyArgs(args, body map[string]any, names map[string]string) {
	for from, to := range names {
		if v, ok := args[from]; ok && v != nil {
			if s, isStr := v.(string); isStr {
				v = strings.TrimSpace(s)
			}
			body[to] = v
		}
	}
}

func intArg(args map[string]any, k string) (int64, bool) {
	f, ok := argNumber(args, k)
	return int64(math.Round(f)), ok
}

var vehicleColors = []string{"#1E63D6", "#DC2626", "#0F766E", "#7C3AED", "#EA580C", "#334155"}

// ---- Vehicles ----

func toolAddVehicle(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"color": vehicleColors[len(l.vehicles)%len(vehicleColors)]}
	copyArgs(args, body, map[string]string{"name": "name", "type": "kind", "registration": "regNumber", "make": "make", "model": "model", "fuel": "fuel", "color": "color"})
	for _, k := range []string{"year", "odometer"} {
		if n, ok := intArg(args, k); ok {
			body[k] = n
		}
	}
	if reg := normalizeReg(argString(args, "registration")); reg != "" {
		for _, v := range l.vehicles {
			if v.RegNumber == reg {
				return nil, errTool(fmt.Sprintf("%s is already in the garage as %q (id %d)", reg, v.Name, v.ID))
			}
		}
	}
	var v vehicle
	if err := a.call(ctx, a.createVehicle, "POST", "/api/vehicles", c.uid, body, 0, &v); err != nil {
		return nil, err
	}
	return map[string]any{"saved": vehicleView(v), "next": "Add its papers with add_vehicle_paper (insurance, PUC, RC with expiry dates) and service schedules with save_service_rule."}, nil
}

func vehicleView(v vehicle) map[string]any {
	return map[string]any{"id": v.ID, "name": v.Name, "type": v.Kind, "registration": v.RegNumber, "make": v.Make, "model": v.Model,
		"year": v.Year, "fuel": v.Fuel, "odometerKm": v.Odometer, "archived": v.Archived}
}

func toolUpdateVehicle(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	what := argString(args, "vehicle")
	v, err := l.vehicle(what)
	if err != nil {
		// An archived vehicle can still be found to bring it back.
		found := false
		for _, x := range l.vehicles {
			if strconv.FormatInt(x.ID, 10) == what || norm(x.Name) == norm(what) || (x.RegNumber != "" && x.RegNumber == normalizeReg(what)) {
				v, found = x, true
			}
		}
		if !found {
			return nil, err
		}
	}
	body := map[string]any{}
	copyArgs(args, body, map[string]string{"name": "name", "type": "kind", "registration": "regNumber", "make": "make", "model": "model", "fuel": "fuel", "color": "color"})
	if n, ok := intArg(args, "year"); ok {
		body["year"] = n
	}
	if _, ok := args["archived"]; ok {
		body["archived"] = argBool(args, "archived")
	}
	var out vehicle
	if err := a.call(ctx, a.updateVehicle, "PATCH", "/api/vehicles/x", c.uid, body, v.ID, &out); err != nil {
		return nil, err
	}
	return map[string]any{"saved": vehicleView(out)}, nil
}

// ---- Money ----

func toolUpdateTransaction(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	id, ok := intArg(args, "id")
	if !ok {
		return nil, errTool("id is required")
	}
	t, err := scanTx(a.db.QueryRowContext(ctx, `SELECT `+txColumns+` FROM transactions t WHERE t.id = ? AND t.user_id = ?`, id, c.uid))
	if err != nil {
		return nil, errTool("no such transaction")
	}
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	kind := t.Kind
	if k := argString(args, "type"); k != "" {
		kind = k
	}
	body := map[string]any{"kind": kind, "amount": t.Amount, "accountId": t.AccountID, "note": t.Note, "occurredAt": t.OccurredAt,
		"toAccountId": t.ToAccountID, "categoryId": t.CategoryID, "personId": t.PersonID}
	if _, ok := argNumber(args, "amount"); ok {
		amount, err := paise(args, "amount")
		if err != nil {
			return nil, err
		}
		body["amount"] = amount
	}
	if v := argString(args, "account"); v != "" {
		x, err := l.account(v)
		if err != nil {
			return nil, err
		}
		body["accountId"] = x.ID
	}
	if v, ok := args["note"]; ok {
		body["note"] = fmt.Sprint(v)
	}
	if v := argString(args, "date"); v != "" {
		at, err := agentTime(v)
		if err != nil {
			return nil, err
		}
		body["occurredAt"] = at
	}
	switch kind {
	case "expense", "income":
		if v := argString(args, "category"); v != "" || kind != t.Kind {
			cat, err := l.category(kind, v)
			if err != nil {
				return nil, err
			}
			body["categoryId"] = cat
		}
	case "transfer":
		if v := argString(args, "to_account"); v != "" {
			to, err := l.account(v)
			if err != nil {
				return nil, err
			}
			body["toAccountId"] = to.ID
		}
	case "lend", "borrow", "collect", "repay":
		if v := argString(args, "person"); v != "" {
			pid, err := a.agentPerson(ctx, c.uid, l, v, true)
			if err != nil {
				return nil, err
			}
			body["personId"] = pid
		}
	default:
		return nil, errTool("type must be expense, income, transfer, lend, borrow, collect or repay")
	}
	var prev *vehicleLink
	if len(t.Vehicle) > 0 {
		prev = &vehicleLink{}
		if err := json.Unmarshal(t.Vehicle, prev); err != nil {
			return nil, err
		}
	}
	_, hasLitres := args["litres"]
	_, hasOdometer := args["odometer"]
	_, hasFull := args["full_tank"]
	switch v := argString(args, "vehicle"); {
	case strings.EqualFold(v, "none"):
		body["vehicle"] = nil
	case v != "":
		if kind != "expense" {
			return nil, errTool("only an expense can be for a vehicle")
		}
		veh, err := l.vehicle(v)
		if err != nil {
			return nil, err
		}
		cat, _ := body["categoryId"].(*int64)
		body["vehicle"] = agentVehicleLink(l, args, veh.ID, cat, prev)
	case hasLitres || hasOdometer || hasFull:
		if prev == nil || kind != "expense" {
			return nil, errTool("this entry isn't for a vehicle; pass vehicle to link it")
		}
		cat, _ := body["categoryId"].(*int64)
		body["vehicle"] = agentVehicleLink(l, args, prev.VehicleID, cat, prev)
	}
	var out transaction
	if err := a.call(ctx, a.updateTransaction, "PATCH", "/api/transactions/x", c.uid, body, id, &out); err != nil {
		return nil, err
	}
	l2, _ := a.lookups(ctx, c.uid)
	return map[string]any{"saved": l2.view(out)}, nil
}

func toolSaveAccount(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	body := map[string]any{}
	copyArgs(args, body, map[string]string{"name": "name", "type": "kind", "institution": "institution", "last4": "last4", "icon": "icon", "color": "color"})
	for from, to := range map[string]string{"include_in_total": "includeInTotal", "archived": "archived"} {
		if _, ok := args[from]; ok {
			body[to] = argBool(args, from)
		}
	}
	if n, ok, err := signedPaise(args, "opening_balance"); err != nil {
		return nil, err
	} else if ok {
		body["openingBalance"] = n
	}
	var out account
	if what := argString(args, "account"); what != "" {
		accounts, err := a.loadAccounts(ctx, c.uid, 0)
		if err != nil {
			return nil, err
		}
		x, err := pick(accounts, what, "account", func(x account) int64 { return x.ID }, func(x account) string { return x.Name }, func(account) bool { return true })
		if err != nil {
			return nil, err
		}
		if err := a.call(ctx, a.updateAccount, "PATCH", "/api/accounts/x", c.uid, body, x.ID, &out); err != nil {
			return nil, err
		}
	} else {
		icons := map[string]string{"bank": "🏦", "cash": "💵", "wallet": "👛", "card": "💳", "savings": "🐖", "investment": "📈"}
		if _, ok := body["icon"]; !ok {
			body["icon"] = icons[argString(args, "type")]
		}
		if _, ok := body["color"]; !ok {
			body["color"] = "#1E63D6"
		}
		if _, ok := body["includeInTotal"]; !ok {
			body["includeInTotal"] = true
		}
		if err := a.call(ctx, a.createAccount, "POST", "/api/accounts", c.uid, body, 0, &out); err != nil {
			return nil, err
		}
	}
	return map[string]any{"saved": map[string]any{"id": out.ID, "name": out.Name, "type": out.Kind, "balance": rupees(out.Balance),
		"openingBalance": rupees(out.OpeningBalance), "includeInTotal": out.IncludeInTotal, "archived": out.Archived}}, nil
}

func toolSaveCategory(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	body := map[string]any{}
	copyArgs(args, body, map[string]string{"kind": "kind", "name": "name", "icon": "icon", "color": "color"})
	if _, ok := args["archived"]; ok {
		body["archived"] = argBool(args, "archived")
	}
	var out category
	if what := argString(args, "category"); what != "" {
		cats, err := a.loadCategories(ctx, c.uid, 0)
		if err != nil {
			return nil, err
		}
		x, err := pick(cats, what, "category", func(x category) int64 { return x.ID }, func(x category) string { return x.Name }, func(category) bool { return true })
		if err != nil {
			return nil, err
		}
		if err := a.call(ctx, a.updateCategory, "PATCH", "/api/categories/x", c.uid, body, x.ID, &out); err != nil {
			return nil, err
		}
	} else {
		if _, ok := body["icon"]; !ok {
			body["icon"] = "🏷️"
		}
		if _, ok := body["color"]; !ok {
			body["color"] = "#64748B"
		}
		if err := a.call(ctx, a.createCategory, "POST", "/api/categories", c.uid, body, 0, &out); err != nil {
			return nil, err
		}
	}
	return map[string]any{"saved": map[string]any{"id": out.ID, "name": out.Name, "kind": out.Kind, "icon": out.Icon, "archived": out.Archived}}, nil
}

func toolSavePerson(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	body := map[string]any{}
	copyArgs(args, body, map[string]string{"name": "name", "phone": "phone", "note": "note"})
	if _, ok := args["archived"]; ok {
		body["archived"] = argBool(args, "archived")
	}
	people, err := a.loadPeople(ctx, c.uid, 0)
	if err != nil {
		return nil, err
	}
	var out person
	if what := argString(args, "person"); what != "" {
		x, err := pick(people, what, "person", func(x person) int64 { return x.ID }, func(x person) string { return x.Name }, func(person) bool { return true })
		if err != nil {
			return nil, err
		}
		if err := a.call(ctx, a.updatePerson, "PATCH", "/api/people/x", c.uid, body, x.ID, &out); err != nil {
			return nil, err
		}
	} else {
		colors := []string{"#F97316", "#3B82F6", "#22C55E", "#EC4899", "#8B5CF6", "#14B8A6"}
		body["color"] = colors[len(people)%len(colors)]
		if err := a.call(ctx, a.createPerson, "POST", "/api/people", c.uid, body, 0, &out); err != nil {
			return nil, err
		}
	}
	return map[string]any{"saved": map[string]any{"id": out.ID, "name": out.Name, "phone": out.Phone, "owesYou": rupees(out.Balance), "archived": out.Archived}}, nil
}

func toolWriteOff(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	p, err := pick(l.people, argString(args, "person"), "person", func(x person) int64 { return x.ID }, func(x person) string { return x.Name }, func(person) bool { return true })
	if err != nil {
		return nil, err
	}
	amount := p.Balance
	if _, ok := argNumber(args, "amount"); ok {
		if amount, err = paise(args, "amount"); err != nil {
			return nil, err
		}
	}
	cat, err := l.category("expense", argString(args, "category"))
	if err != nil {
		return nil, err
	}
	var out struct {
		Person person `json:"person"`
		Loans  int    `json:"loans"`
	}
	if err := a.call(ctx, a.writeOffLoan, "POST", "/api/people/x/write-off", c.uid, map[string]any{"amount": amount, "categoryId": cat, "note": argString(args, "note")}, p.ID, &out); err != nil {
		return nil, err
	}
	return map[string]any{"person": p.Name, "countedAsSpent": rupees(amount), "stillOwesYou": rupees(out.Person.Balance), "loansChanged": out.Loans}, nil
}

func toolSetBudget(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	cat, err := l.category("expense", argString(args, "category"))
	if err != nil {
		return nil, err
	}
	amount, err := paise(args, "amount")
	if err != nil {
		return nil, err
	}
	if err := a.call(ctx, a.upsertBudget, "PUT", "/api/budgets", c.uid, map[string]any{"categoryId": cat, "amount": amount}, 0, nil); err != nil {
		return nil, err
	}
	what := "overall"
	if name := argString(args, "category"); name != "" {
		what = name
	}
	return map[string]any{"budget": what, "perMonth": rupees(amount)}, nil
}

func toolSaveRule(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	l, err := a.lookups(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	body := map[string]any{}
	if t := argString(args, "title"); t != "" {
		body["title"] = t
	}
	for from, to := range map[string]string{"every_km": "everyKm", "every_months": "everyMonths"} {
		if n, ok := intArg(args, from); ok {
			if n <= 0 {
				body[to] = nil
			} else {
				body[to] = n
			}
		}
	}
	var out serviceRule
	if what := argString(args, "rule"); what != "" {
		rules, err := a.loadServiceRules(ctx, c.uid, reminderToday())
		if err != nil {
			return nil, err
		}
		var vid int64
		if v := argString(args, "vehicle"); v != "" {
			veh, err := l.vehicle(v)
			if err != nil {
				return nil, err
			}
			vid = veh.ID
		}
		r, err := pick(rules, what, "service rule", func(x serviceRule) int64 { return x.ID }, func(x serviceRule) string { return x.Title },
			func(x serviceRule) bool { return vid == 0 || x.VehicleID == vid })
		if err != nil {
			return nil, err
		}
		if err := a.call(ctx, a.updateServiceRule, "PATCH", "/api/service-rules/x", c.uid, body, r.ID, &out); err != nil {
			return nil, err
		}
	} else {
		veh, err := l.vehicle(argString(args, "vehicle"))
		if err != nil {
			return nil, err
		}
		body["vehicleId"] = veh.ID
		if err := a.call(ctx, a.createServiceRule, "POST", "/api/service-rules", c.uid, body, 0, &out); err != nil {
			return nil, err
		}
	}
	return map[string]any{"saved": map[string]any{"id": out.ID, "title": out.Title, "everyKm": out.EveryKm, "everyMonths": out.EveryMonths, "dueAtKm": out.NextKm, "dueBy": out.NextOn}}, nil
}

func toolDelete(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	id, ok := intArg(args, "id")
	if !ok || id <= 0 {
		return nil, errTool("id is required")
	}
	handlers := map[string]struct {
		h     authedHandler
		table string
	}{
		"transaction":   {a.deleteTransaction, "transactions"},
		"account":       {a.deleteAccount, "accounts"},
		"category":      {a.deleteCategory, "categories"},
		"person":        {a.deletePerson, "people"},
		"vehicle":       {a.deleteVehicle, "vehicles"},
		"vehicle_log":   {a.deleteVehicleLog, "vehicle_logs"},
		"vehicle_paper": {a.deleteVehicleDoc, "vehicle_documents"},
		"service_rule":  {a.deleteServiceRule, "service_rules"},
		"budget":        {a.deleteBudget, "budgets"},
	}
	what := argString(args, "what")
	d, ok := handlers[what]
	if !ok {
		return nil, errTool("what must be one of transaction, account, category, person, vehicle, vehicle_log, vehicle_paper, service_rule, budget")
	}
	if ok, err := a.owned(ctx, d.table, id, c.uid); err != nil {
		return nil, err
	} else if !ok {
		return nil, errTool(fmt.Sprintf("no %s with id %d", what, id))
	}
	if err := a.call(ctx, d.h, "DELETE", "/api/x", c.uid, nil, id, nil); err != nil {
		return nil, err
	}
	return map[string]any{"deleted": what, "id": id}, nil
}

func toolInterest(ctx context.Context, a *api, c agentCaller, _ map[string]any) (any, error) {
	s, err := a.interestTotals(ctx, c.uid)
	if err != nil {
		return nil, err
	}
	years := []map[string]any{}
	for _, y := range s.Years {
		years = append(years, map[string]any{"year": y.Year, "earned": rupees(y.Earned), "given": rupees(y.Given)})
	}
	return map[string]any{"earned": rupees(s.Earned), "givenAway": rupees(s.Given), "toGiveAway": rupees(s.ToGive), "byYear": years,
		"note": "Interest is income in their Interest category; giving it away is an expense in 'Interest given away' (POST /api/interest/give through kosh_api)."}, nil
}

// ---- The app's own API ----

type koshRoute struct {
	pattern string
	h       func(a *api) authedHandler
}

// koshRoutes are the parts of the app's API an agent may use: everything a
// person does with their records, nothing about their login or who else
// can get in.
var koshRoutes = []koshRoute{
	{"GET /api/bootstrap", func(a *api) authedHandler { return a.bootstrap }},
	{"POST /api/accounts", func(a *api) authedHandler { return a.createAccount }},
	{"PATCH /api/accounts/{id}", func(a *api) authedHandler { return a.updateAccount }},
	{"DELETE /api/accounts/{id}", func(a *api) authedHandler { return a.deleteAccount }},
	{"PUT /api/accounts/order", func(a *api) authedHandler { return a.reorderAccounts }},
	{"POST /api/categories", func(a *api) authedHandler { return a.createCategory }},
	{"PATCH /api/categories/{id}", func(a *api) authedHandler { return a.updateCategory }},
	{"DELETE /api/categories/{id}", func(a *api) authedHandler { return a.deleteCategory }},
	{"POST /api/people", func(a *api) authedHandler { return a.createPerson }},
	{"PATCH /api/people/{id}", func(a *api) authedHandler { return a.updatePerson }},
	{"DELETE /api/people/{id}", func(a *api) authedHandler { return a.deletePerson }},
	{"POST /api/people/{id}/write-off", func(a *api) authedHandler { return a.writeOffLoan }},
	{"GET /api/transactions", func(a *api) authedHandler { return a.listTransactions }},
	{"POST /api/transactions", func(a *api) authedHandler { return a.createTransaction }},
	{"POST /api/transactions/batch", func(a *api) authedHandler { return a.createTransactions }},
	{"PATCH /api/transactions/{id}", func(a *api) authedHandler { return a.updateTransaction }},
	{"DELETE /api/transactions/{id}", func(a *api) authedHandler { return a.deleteTransaction }},
	{"GET /api/vehicles", func(a *api) authedHandler { return a.listVehicles }},
	{"POST /api/vehicles", func(a *api) authedHandler { return a.createVehicle }},
	{"PATCH /api/vehicles/{id}", func(a *api) authedHandler { return a.updateVehicle }},
	{"DELETE /api/vehicles/{id}", func(a *api) authedHandler { return a.deleteVehicle }},
	{"POST /api/vehicle-logs", func(a *api) authedHandler { return a.createVehicleLog }},
	{"PATCH /api/vehicle-logs/{id}", func(a *api) authedHandler { return a.updateVehicleLog }},
	{"DELETE /api/vehicle-logs/{id}", func(a *api) authedHandler { return a.deleteVehicleLog }},
	{"POST /api/vehicle-documents", func(a *api) authedHandler { return a.createVehicleDoc }},
	{"PATCH /api/vehicle-documents/{id}", func(a *api) authedHandler { return a.updateVehicleDoc }},
	{"DELETE /api/vehicle-documents/{id}", func(a *api) authedHandler { return a.deleteVehicleDoc }},
	{"POST /api/service-rules", func(a *api) authedHandler { return a.createServiceRule }},
	{"PATCH /api/service-rules/{id}", func(a *api) authedHandler { return a.updateServiceRule }},
	{"DELETE /api/service-rules/{id}", func(a *api) authedHandler { return a.deleteServiceRule }},
	{"GET /api/insights", func(a *api) authedHandler { return a.insights }},
	{"GET /api/insights/balance", func(a *api) authedHandler { return a.balanceHistory }},
	{"GET /api/budgets", func(a *api) authedHandler { return a.listBudgets }},
	{"PUT /api/budgets", func(a *api) authedHandler { return a.upsertBudget }},
	{"DELETE /api/budgets/{id}", func(a *api) authedHandler { return a.deleteBudget }},
	{"GET /api/interest", func(a *api) authedHandler { return a.getInterest }},
	{"POST /api/interest/give", func(a *api) authedHandler { return a.giveInterest }},
	{"POST /api/statements/mark-interest", func(a *api) authedHandler { return a.markInterest }},
	{"GET /api/captures", func(a *api) authedHandler { return a.listCaptures }},
	{"POST /api/captures/{id}/dismiss", func(a *api) authedHandler { return a.dismissCapture }},
	{"GET /api/payees", func(a *api) authedHandler { return a.lookupPayee }},
}

func koshAPIRoutes() []string {
	out := make([]string, len(koshRoutes))
	for i, r := range koshRoutes {
		out[i] = r.pattern
	}
	return out
}

type uidKey struct{}

func (a *api) koshMux() *http.ServeMux {
	a.koshMuxOnce.Do(func() {
		m := http.NewServeMux()
		for _, r := range koshRoutes {
			h := r.h(a)
			m.HandleFunc(r.pattern, func(w http.ResponseWriter, req *http.Request) {
				h(w, req, req.Context().Value(uidKey{}).(int64))
			})
		}
		a.koshMuxVal = m
	})
	return a.koshMuxVal
}

func toolKoshAPI(ctx context.Context, a *api, c agentCaller, args map[string]any) (any, error) {
	method := strings.ToUpper(argString(args, "method"))
	path := argString(args, "path")
	if !strings.HasPrefix(path, "/api/") {
		return nil, errTool("path starts with /api/, like /api/transactions")
	}
	if method != "GET" && c.scope != "write" {
		return nil, errTool("this connection can only read; the person can allow changes in Kosh → Settings → AI agents")
	}
	if method != "GET" && !agentLimiter.allow(c.connID, true) {
		return nil, errTool("too many changes; wait a minute")
	}
	var body []byte
	if b, ok := args["body"]; ok && b != nil && method != "GET" && method != "DELETE" {
		if s, isStr := b.(string); isStr {
			body = []byte(s)
		} else {
			body, _ = json.Marshal(b)
		}
	}
	req := httptest.NewRequestWithContext(context.WithValue(ctx, uidKey{}, c.uid), method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	mux := a.koshMux()
	if _, pattern := mux.Handler(req); pattern == "" {
		return nil, errTool(method + " " + req.URL.Path + " isn't something agents can use. Routes: " + strings.Join(koshAPIRoutes(), "; "))
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	var out any
	if w.Body.Len() > 0 {
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			out = w.Body.String()
		}
	}
	if w.Code >= 500 {
		return nil, fmt.Errorf("kosh: %v", out)
	}
	if w.Code >= 400 {
		if m, ok := out.(map[string]any); ok {
			if e, ok := m["error"].(string); ok {
				return nil, errTool(e)
			}
		}
		return nil, errTool(fmt.Sprintf("%d: %v", w.Code, out))
	}
	// Mark new entries as the agent's, like add_transaction does.
	if method == "POST" && req.URL.Path == "/api/transactions" {
		if m, ok := out.(map[string]any); ok {
			if id, ok := m["id"].(float64); ok {
				a.markAgent(ctx, c, int64(id))
			}
		}
	}
	if out == nil {
		out = map[string]any{"ok": true, "status": w.Code}
	}
	return out, nil
}
