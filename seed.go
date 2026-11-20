package main

import "database/sql"

type seedCategory struct{ name, icon, color string }

var defaultExpenseCategories = []seedCategory{
	{"Food & Dining", "🍜", "#F97316"},
	{"Groceries", "🛒", "#22C55E"},
	{"Transport", "🚕", "#EAB308"},
	{"Fuel", "⛽", "#EF4444"},
	{"Shopping", "🛍️", "#EC4899"},
	{"Bills & Utilities", "💡", "#06B6D4"},
	{"Rent", "🏠", "#8B5CF6"},
	{"Recharge", "📱", "#3B82F6"},
	{"Health", "💊", "#14B8A6"},
	{"Entertainment", "🎬", "#F43F5E"},
	{"Subscriptions", "📺", "#6366F1"},
	{"Travel", "✈️", "#0EA5E9"},
	{"Education", "📚", "#A855F7"},
	{"Personal Care", "💇", "#D946EF"},
	{"Gifts", "🎁", "#FB7185"},
	{"Family", "👨‍👩‍👧", "#F59E0B"},
	{"EMI & Loans", "🏦", "#64748B"},
	{"Other", "✨", "#94A3B8"},
}

var defaultIncomeCategories = []seedCategory{
	{"Salary", "💼", "#10B981"},
	{"Freelance", "💻", "#3B82F6"},
	{"Business", "🏪", "#F59E0B"},
	{"Interest", "📈", "#8B5CF6"},
	{"Refund", "↩️", "#06B6D4"},
	{"Gift", "🎁", "#EC4899"},
	{"Other", "💰", "#94A3B8"},
}

// seedUser gives a new user starter categories and a Cash account.
func seedUser(tx *sql.Tx, uid int64) error {
	insert := func(kind string, list []seedCategory) error {
		for i, c := range list {
			role := ""
			if kind == "income" && c.name == "Interest" {
				role = "interest"
			}
			if _, err := tx.Exec(`INSERT INTO categories (user_id, kind, name, icon, color, sort_order, role) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				uid, kind, c.name, c.icon, c.color, i, role); err != nil {
				return err
			}
		}
		return nil
	}
	if err := insert("expense", defaultExpenseCategories); err != nil {
		return err
	}
	if err := insert("income", defaultIncomeCategories); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO accounts (user_id, name, kind, color, icon, sort_order) VALUES (?, 'Cash', 'cash', '#22C55E', '💵', 0)`, uid)
	return err
}
