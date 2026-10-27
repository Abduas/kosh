package main

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite" // pure Go, so CGO_ENABLED=0 cross-compiles
)

func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)&_txlock=immediate"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return db, nil
}

// migrations run in order, once each. Only ever append to this list: the
// previous release may still be running against the new schema for a few
// seconds during a deploy, and rolling back doesn't undo a migration.
//
// Money is always stored as an integer number of minor units (paise for INR).
var migrations = []string{
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		username TEXT NOT NULL UNIQUE COLLATE NOCASE,
		name TEXT NOT NULL,
		password_hash TEXT NOT NULL,
		prefs TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);

	CREATE TABLE sessions (
		token_hash TEXT PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX sessions_user ON sessions(user_id);

	-- Where money lives: bank accounts, cash, wallets, credit cards.
	CREATE TABLE accounts (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('bank', 'cash', 'wallet', 'card', 'savings', 'investment')),
		institution TEXT NOT NULL DEFAULT '',
		last4 TEXT NOT NULL DEFAULT '',
		color TEXT NOT NULL,
		icon TEXT NOT NULL,
		opening_balance INTEGER NOT NULL DEFAULT 0,
		include_in_total INTEGER NOT NULL DEFAULT 1,
		archived INTEGER NOT NULL DEFAULT 0,
		sort_order INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX accounts_user ON accounts(user_id);

	CREATE TABLE categories (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
		name TEXT NOT NULL,
		icon TEXT NOT NULL,
		color TEXT NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0,
		sort_order INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX categories_user ON categories(user_id);

	-- People you lend to or borrow from.
	CREATE TABLE people (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		phone TEXT NOT NULL DEFAULT '',
		note TEXT NOT NULL DEFAULT '',
		color TEXT NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX people_user ON people(user_id);

	-- Every movement of money. kind decides which side it touches:
	--   expense, income   one account, a category
	--   transfer          account_id -> to_account_id
	--   lend, repay       money leaves account_id to person_id (they owe you more / you owe less)
	--   borrow, collect   money arrives in account_id from person_id (you owe more / they owe less)
	-- occurred_at is the user's local wall-clock time, 'YYYY-MM-DDTHH:MM'.
	-- source and ref are for automatic capture later (UPI reference numbers, SMS).
	CREATE TABLE transactions (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('expense', 'income', 'transfer', 'lend', 'borrow', 'collect', 'repay')),
		amount INTEGER NOT NULL CHECK (amount > 0),
		account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
		to_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
		category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
		person_id INTEGER REFERENCES people(id) ON DELETE RESTRICT,
		note TEXT NOT NULL DEFAULT '',
		occurred_at TEXT NOT NULL,
		source TEXT NOT NULL DEFAULT 'manual',
		ref TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		CHECK ((kind = 'transfer') = (to_account_id IS NOT NULL)),
		CHECK ((kind IN ('lend', 'borrow', 'collect', 'repay')) = (person_id IS NOT NULL))
	);
	CREATE INDEX transactions_user_time ON transactions(user_id, occurred_at DESC, id DESC);
	CREATE INDEX transactions_account ON transactions(account_id);
	CREATE INDEX transactions_to_account ON transactions(to_account_id) WHERE to_account_id IS NOT NULL;
	CREATE INDEX transactions_person ON transactions(person_id) WHERE person_id IS NOT NULL;
	CREATE INDEX transactions_category ON transactions(category_id) WHERE category_id IS NOT NULL;

	-- Monthly budgets. category_id NULL is the overall budget.
	CREATE TABLE budgets (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
		amount INTEGER NOT NULL CHECK (amount > 0),
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE UNIQUE INDEX budgets_user_category ON budgets(user_id, IFNULL(category_id, 0));`,

	// payee is the UPI ID (VPA) a scanned payment went to, lowercased. The last
	// transaction to a payee is how Kosh remembers its category, person and account.
	`ALTER TABLE transactions ADD COLUMN payee TEXT NOT NULL DEFAULT '';
	CREATE INDEX transactions_payee ON transactions(user_id, payee, occurred_at DESC) WHERE payee != '';`,

	// A pending UPI payment: the money left your account but the payment app
	// didn't confirm it. It counts in balances until you mark it done or refunded.
	`ALTER TABLE transactions ADD COLUMN status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done', 'pending'));
	CREATE INDEX transactions_pending ON transactions(user_id) WHERE status = 'pending';`,

	// Pending payments were dropped as a feature; settle any that were saved.
	// The status column stays (columns are only ever added) and is unused.
	`UPDATE transactions SET status = 'done' WHERE status = 'pending';`,
}

func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return err
	}
	for i := version; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
