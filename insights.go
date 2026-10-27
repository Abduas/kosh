package main

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

const dateLayout = "2006-01-02"

type categoryTotal struct {
	Kind       string `json:"kind"`
	CategoryID *int64 `json:"categoryId"`
	Total      int64  `json:"total"`
	Count      int64  `json:"count"`
}

type seriesPoint struct {
	Key     string `json:"key"` // YYYY-MM-DD or YYYY-MM
	Expense int64  `json:"expense"`
	Income  int64  `json:"income"`
}

// kindTotals sums every kind of transaction between from and to (inclusive dates).
func (a *api) kindTotals(ctx context.Context, uid int64, from, to string) (map[string]int64, map[string]int64, error) {
	rows, err := a.db.QueryContext(ctx, `SELECT kind, SUM(amount), COUNT(*) FROM transactions
		WHERE user_id = ? AND occurred_at >= ? AND occurred_at < ? GROUP BY kind`, uid, from, to+"T99")
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	totals := map[string]int64{"expense": 0, "income": 0, "transfer": 0, "lend": 0, "borrow": 0, "collect": 0, "repay": 0}
	counts := map[string]int64{}
	for rows.Next() {
		var kind string
		var sum, n int64
		if err := rows.Scan(&kind, &sum, &n); err != nil {
			return nil, nil, err
		}
		totals[kind], counts[kind] = sum, n
	}
	return totals, counts, rows.Err()
}

// insights summarises a date range: totals, categories, a time series, the
// largest expenses and the same totals for the previous range of equal length.
func (a *api) insights(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	from, err1 := time.Parse(dateLayout, r.URL.Query().Get("from"))
	to, err2 := time.Parse(dateLayout, r.URL.Query().Get("to"))
	if err1 != nil || err2 != nil || to.Before(from) || to.Sub(from) > 10*366*24*time.Hour {
		writeError(w, http.StatusBadRequest, "from and to must be dates (YYYY-MM-DD)")
		return
	}
	fromS, toS := from.Format(dateLayout), to.Format(dateLayout)
	days := int(to.Sub(from).Hours()/24) + 1
	prevTo := from.AddDate(0, 0, -1)
	prevFrom := prevTo.AddDate(0, 0, -(days - 1))

	totals, counts, err := a.kindTotals(ctx, uid, fromS, toS)
	if err != nil {
		serverError(w, err)
		return
	}
	prev, _, err := a.kindTotals(ctx, uid, prevFrom.Format(dateLayout), prevTo.Format(dateLayout))
	if err != nil {
		serverError(w, err)
		return
	}

	// By category
	rows, err := a.db.QueryContext(ctx, `SELECT kind, category_id, SUM(amount), COUNT(*) FROM transactions
		WHERE user_id = ? AND kind IN ('expense', 'income') AND occurred_at >= ? AND occurred_at < ?
		GROUP BY kind, category_id ORDER BY SUM(amount) DESC`, uid, fromS, toS+"T99")
	if err != nil {
		serverError(w, err)
		return
	}
	cats := []categoryTotal{}
	for rows.Next() {
		var c categoryTotal
		if err := rows.Scan(&c.Kind, &c.CategoryID, &c.Total, &c.Count); err != nil {
			rows.Close()
			serverError(w, err)
			return
		}
		cats = append(cats, c)
	}
	rows.Close()

	// Time series: by day for ranges up to ~2 months, by month beyond that.
	bucket, keyLen := "day", 10
	if days > 62 {
		bucket, keyLen = "month", 7
	}
	rows, err = a.db.QueryContext(ctx, `SELECT substr(occurred_at, 1, ?) AS k,
		SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END),
		SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END)
		FROM transactions WHERE user_id = ? AND kind IN ('expense', 'income') AND occurred_at >= ? AND occurred_at < ?
		GROUP BY k`, keyLen, uid, fromS, toS+"T99")
	if err != nil {
		serverError(w, err)
		return
	}
	byKey := map[string]seriesPoint{}
	for rows.Next() {
		var p seriesPoint
		if err := rows.Scan(&p.Key, &p.Expense, &p.Income); err != nil {
			rows.Close()
			serverError(w, err)
			return
		}
		byKey[p.Key] = p
	}
	rows.Close()
	series := []seriesPoint{}
	if bucket == "day" {
		for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
			k := d.Format(dateLayout)
			p := byKey[k]
			p.Key = k
			series = append(series, p)
		}
	} else {
		for m := time.Date(from.Year(), from.Month(), 1, 0, 0, 0, 0, time.UTC); !m.After(to); m = m.AddDate(0, 1, 0) {
			k := m.Format("2006-01")
			p := byKey[k]
			p.Key = k
			series = append(series, p)
		}
	}

	// Largest expenses
	rows, err = a.db.QueryContext(ctx, `SELECT `+txColumns+` FROM transactions t
		WHERE t.user_id = ? AND t.kind = 'expense' AND t.occurred_at >= ? AND t.occurred_at < ?
		ORDER BY t.amount DESC, t.occurred_at DESC LIMIT 5`, uid, fromS, toS+"T99")
	if err != nil {
		serverError(w, err)
		return
	}
	largest := []transaction{}
	for rows.Next() {
		t, err := scanTx(rows)
		if err != nil {
			rows.Close()
			serverError(w, err)
			return
		}
		largest = append(largest, t)
	}
	rows.Close()

	writeJSON(w, http.StatusOK, map[string]any{
		"from": fromS, "to": toS, "days": days,
		"prevFrom": prevFrom.Format(dateLayout), "prevTo": prevTo.Format(dateLayout),
		"totals": totals, "counts": counts,
		"prev":       map[string]int64{"expense": prev["expense"], "income": prev["income"]},
		"categories": cats, "bucket": bucket, "series": series, "largest": largest,
	})
}

// balanceHistory returns the total balance (accounts counted in the total) at
// the end of each of the last `days` days, oldest first, ending at `today`.
func (a *api) balanceHistory(w http.ResponseWriter, r *http.Request, uid int64) {
	ctx := r.Context()
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v >= 2 && v <= 366 {
		days = v
	}
	today, err := time.Parse(dateLayout, r.URL.Query().Get("today"))
	if err != nil {
		today = time.Now()
	}
	today = time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, time.UTC)

	accounts, err := a.loadAccounts(ctx, uid, 0)
	if err != nil {
		serverError(w, err)
		return
	}
	var current int64
	for _, acc := range accounts {
		if acc.IncludeInTotal {
			current += acc.Balance
		}
	}

	// Net change per day for counted accounts, for every day after the start.
	start := today.AddDate(0, 0, -(days - 1))
	rows, err := a.db.QueryContext(ctx, `SELECT substr(t.occurred_at, 1, 10) AS d,
		SUM(CASE WHEN a1.include_in_total = 1 THEN `+accountEffect+` ELSE 0 END)
		+ SUM(CASE WHEN t.kind = 'transfer' AND a2.include_in_total = 1 THEN t.amount ELSE 0 END)
		FROM transactions t
		JOIN accounts a1 ON a1.id = t.account_id
		LEFT JOIN accounts a2 ON a2.id = t.to_account_id
		WHERE t.user_id = ? AND t.occurred_at >= ?
		GROUP BY d`, uid, start.AddDate(0, 0, 1).Format(dateLayout))
	if err != nil {
		serverError(w, err)
		return
	}
	defer rows.Close()
	delta := map[string]int64{}
	var afterToday int64
	todayS := today.Format(dateLayout)
	for rows.Next() {
		var d string
		var v int64
		if err := rows.Scan(&d, &v); err != nil {
			serverError(w, err)
			return
		}
		if d > todayS {
			afterToday += v
		} else {
			delta[d] = v
		}
	}

	type point struct {
		Date    string `json:"date"`
		Balance int64  `json:"balance"`
	}
	out := make([]point, days)
	bal := current - afterToday
	for i := days - 1; i >= 0; i-- {
		d := start.AddDate(0, 0, i).Format(dateLayout)
		out[i] = point{Date: d, Balance: bal}
		bal -= delta[d]
	}
	writeJSON(w, http.StatusOK, out)
}
