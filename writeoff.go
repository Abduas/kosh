package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// Writing off a loan: when someone won't pay back what they borrowed, the
// money they still owe becomes an expense. The loans themselves turn into
// expenses (newest first, as repayments clear the oldest loans), so each keeps
// its date and account and no account's balance moves; only the person's
// balance goes down. A loan only partly written off is split in two.

const roleWrittenOff = "written-off"

func init() {
	roleCategories[roleWrittenOff] = struct{ kind, name, icon, color string }{"expense", "Money not returned", "💸", "#F43F5E"}
}

func (a *api) writeOffLoan(w http.ResponseWriter, r *http.Request, uid int64) {
	pid, ok := pathID(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	var in struct {
		Amount     int64  `json:"amount"`
		CategoryID *int64 `json:"categoryId"`
		Note       string `json:"note"`
	}
	if !readJSON(w, r, &in) {
		return
	}
	ctx := r.Context()
	people, err := a.loadPeople(ctx, uid, pid)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(people) == 0 {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	p := people[0]
	if p.Balance <= 0 {
		respondErr(w, errValidation(p.Name+" doesn't owe you anything"))
		return
	}
	if in.Amount <= 0 {
		respondErr(w, errValidation("Enter how much won't come back"))
		return
	}
	if in.Amount > p.Balance {
		respondErr(w, errValidation("That's more than "+p.Name+" owes you ("+inr(p.Balance)+")"))
		return
	}
	if in.CategoryID != nil {
		var kind string
		if err := a.db.QueryRowContext(ctx, `SELECT kind FROM categories WHERE id = ? AND user_id = ?`, *in.CategoryID, uid).Scan(&kind); err != nil || kind != "expense" {
			respondErr(w, errValidation("Pick an expense category"))
			return
		}
	}

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		serverError(w, err)
		return
	}
	defer tx.Rollback()
	cat := in.CategoryID
	if cat == nil {
		id, err := ensureRoleCategory(ctx, tx, uid, roleWrittenOff)
		if err != nil {
			serverError(w, err)
			return
		}
		cat = &id
	}
	extra := truncateRunes(strings.TrimSpace(in.Note), 120)

	rows, err := tx.QueryContext(ctx, `SELECT id, amount, account_id, note, occurred_at FROM transactions
		WHERE user_id = ? AND person_id = ? AND kind = 'lend' ORDER BY occurred_at DESC, id DESC`, uid, pid)
	if err != nil {
		serverError(w, err)
		return
	}
	type loan struct {
		id, amount, account int64
		note, at            string
	}
	var loans []loan
	for rows.Next() {
		var l loan
		if err := rows.Scan(&l.id, &l.amount, &l.account, &l.note, &l.at); err != nil {
			rows.Close()
			serverError(w, err)
			return
		}
		loans = append(loans, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		serverError(w, err)
		return
	}

	noteFor := func(old string) string {
		parts := []string{"Lent to " + p.Name + ", not paid back"}
		if old = strings.TrimSpace(old); old != "" {
			parts = append(parts, old)
		}
		if extra != "" {
			parts = append(parts, extra)
		}
		return truncateRunes(strings.Join(parts, " · "), 280)
	}
	left, changed := in.Amount, 0
	for _, l := range loans {
		if left == 0 {
			break
		}
		if l.amount <= left {
			// The whole loan is lost: it becomes the expense.
			if _, err := tx.ExecContext(ctx, `UPDATE transactions SET kind = 'expense', person_id = NULL, lost_from_person_id = ?, category_id = ?, note = ?,
				updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?`, pid, *cat, noteFor(l.note), l.id, uid); err != nil {
				serverError(w, err)
				return
			}
			left -= l.amount
		} else {
			// Part of it is lost: the loan keeps the rest, and the lost part is
			// an expense on the same day from the same account.
			if _, err := tx.ExecContext(ctx, `UPDATE transactions SET amount = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND user_id = ?`,
				l.amount-left, l.id, uid); err != nil {
				serverError(w, err)
				return
			}
			t := transaction{Kind: "expense", Amount: left, AccountID: l.account, CategoryID: cat, Note: noteFor(l.note), OccurredAt: l.at, Source: "manual"}
			res, err := insertTx(ctx, tx, uid, t)
			if err == nil {
				id, _ := res.LastInsertId()
				_, err = tx.ExecContext(ctx, `UPDATE transactions SET lost_from_person_id = ? WHERE id = ?`, pid, id)
			}
			if err != nil {
				serverError(w, err)
				return
			}
			left = 0
		}
		changed++
	}
	if left > 0 {
		// What they owe isn't all loans (paying them back more than you
		// borrowed, say), so there's nothing to turn into an expense for it.
		respondErr(w, errValidation("Only "+inr(in.Amount-left)+" of that was lent to "+p.Name+", so that's the most that can be written off"))
		return
	}
	if err := tx.Commit(); err != nil {
		serverError(w, err)
		return
	}
	people, err = a.loadPeople(ctx, uid, pid)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"person": people[0], "categoryId": *cat, "loans": changed})
}

// inr writes paise as rupees the Indian way: ₹1,23,456.50, or ₹500 when whole.
func inr(paise int64) string {
	sign := ""
	if paise < 0 {
		sign, paise = "-", -paise
	}
	whole := strconv.FormatInt(paise/100, 10)
	var b strings.Builder
	if len(whole) > 3 {
		head, tail := whole[:len(whole)-3], whole[len(whole)-3:]
		for i, c := range head {
			if i > 0 && (len(head)-i)%2 == 0 {
				b.WriteByte(',')
			}
			b.WriteRune(c)
		}
		b.WriteString("," + tail)
	} else {
		b.WriteString(whole)
	}
	if p := paise % 100; p != 0 {
		b.WriteString(fmt.Sprintf(".%02d", p))
	}
	return sign + "₹" + b.String()
}
