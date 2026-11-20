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

	// More than one person can use a Kosh. The first account is the owner, who
	// invites others with one-time links. Each person's money stays separate.
	// used_at marks an invite spent even if the person it made is later removed.
	`ALTER TABLE users ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;
	UPDATE users SET is_owner = 1 WHERE id = (SELECT MIN(id) FROM users);

	CREATE TABLE invites (
		id INTEGER PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		expires_at TEXT NOT NULL,
		used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
		used_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);

	-- Sign-in with Google (through Sideyard). provider_id is Google's stable
	-- user ID; email is only for showing which account is connected. Someone
	-- who signed up with Google has an empty password_hash until they set one.
	CREATE TABLE identities (
		provider TEXT NOT NULL,
		provider_id TEXT NOT NULL,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		email TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		PRIMARY KEY (provider, provider_id)
	);
	CREATE UNIQUE INDEX identities_user ON identities(user_id, provider);`,

	// Auto-capture: an iPhone automation forwards bank and UPI messages to
	// POST /api/capture/{token}. The token only lets a phone send messages in;
	// it's kept as is so Settings can show the link again. timezone turns the
	// time a message arrived into the user's wall-clock time.
	`CREATE TABLE capture_keys (
		user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		token TEXT NOT NULL UNIQUE,
		timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
		last_used_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);

	-- Each bank message Kosh understood. status: 'review' waits for you,
	-- 'saved' became (or matched) transaction_id, 'dismissed' you said no.
	-- Messages that aren't money moving are never stored.
	CREATE TABLE captures (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		text TEXT NOT NULL,
		text_hash TEXT NOT NULL,
		direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
		amount INTEGER NOT NULL CHECK (amount > 0),
		account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
		bank TEXT NOT NULL DEFAULT '',
		last4 TEXT NOT NULL DEFAULT '',
		payee TEXT NOT NULL DEFAULT '',
		merchant TEXT NOT NULL DEFAULT '',
		ref TEXT NOT NULL DEFAULT '',
		occurred_at TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'saved', 'dismissed')),
		transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE UNIQUE INDEX captures_text ON captures(user_id, text_hash);
	-- The same payment told twice (bank SMS and a UPI app's) shares a reference.
	-- Out of one account and into another with one reference is a transfer, so direction is part of it.
	CREATE UNIQUE INDEX captures_ref ON captures(user_id, ref, direction) WHERE ref != '';
	CREATE INDEX captures_review ON captures(user_id, occurred_at DESC) WHERE status = 'review';
	CREATE INDEX captures_merchant ON captures(user_id, merchant) WHERE status = 'saved';
	CREATE INDEX captures_transaction ON captures(transaction_id) WHERE transaction_id IS NOT NULL;`,

	// Vehicles: the garage, what was done to each (fuel, service, other costs,
	// odometer readings) and their papers with expiry dates.
	//
	// A log paid from an account points at its transaction; that link is how
	// an expense in Money belongs to a vehicle. amount and occurred_on are kept
	// in step with the transaction, and stay when Money is erased.
	// litres is in millilitres; odometer in km.
	// A document with no vehicle is yours, like a driving licence. No
	// expires_on means it doesn't expire (lifetime road tax, an RC).
	`CREATE TABLE vehicles (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('car', 'bike', 'scooter', 'other')),
		name TEXT NOT NULL,
		make TEXT NOT NULL DEFAULT '',
		model TEXT NOT NULL DEFAULT '',
		year INTEGER,
		reg_number TEXT NOT NULL DEFAULT '',
		fuel TEXT NOT NULL DEFAULT 'petrol' CHECK (fuel IN ('petrol', 'diesel', 'cng', 'ev', 'hybrid')),
		color TEXT NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0,
		sort_order INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX vehicles_user ON vehicles(user_id);

	CREATE TABLE vehicle_logs (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('fuel', 'service', 'expense', 'odometer')),
		occurred_on TEXT NOT NULL,
		odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
		litres INTEGER CHECK (litres IS NULL OR litres > 0),
		full_tank INTEGER NOT NULL DEFAULT 0,
		title TEXT NOT NULL DEFAULT '',
		amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
		note TEXT NOT NULL DEFAULT '',
		transaction_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE SET NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX vehicle_logs_user ON vehicle_logs(user_id, occurred_on DESC);
	CREATE INDEX vehicle_logs_vehicle ON vehicle_logs(vehicle_id, occurred_on DESC);

	CREATE TABLE vehicle_documents (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		vehicle_id INTEGER REFERENCES vehicles(id) ON DELETE CASCADE,
		type TEXT NOT NULL CHECK (type IN ('rc', 'insurance', 'puc', 'road_tax', 'fitness', 'permit', 'licence', 'warranty', 'other')),
		title TEXT NOT NULL DEFAULT '',
		number TEXT NOT NULL DEFAULT '',
		issuer TEXT NOT NULL DEFAULT '',
		issued_on TEXT,
		expires_on TEXT,
		amount INTEGER NOT NULL DEFAULT 0 CHECK (amount >= 0),
		note TEXT NOT NULL DEFAULT '',
		file_key TEXT NOT NULL DEFAULT '',
		file_name TEXT NOT NULL DEFAULT '',
		file_type TEXT NOT NULL DEFAULT '',
		file_size INTEGER NOT NULL DEFAULT 0,
		transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX vehicle_documents_user ON vehicle_documents(user_id, expires_on);
	CREATE INDEX vehicle_documents_vehicle ON vehicle_documents(vehicle_id);`,

	// Service schedules ("oil change every 3,000 km or 6 months") and
	// reminders: phones subscribed to Web Push, a private calendar feed, and
	// what's been sent so the daily job never says the same thing twice.
	`CREATE TABLE service_rules (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		vehicle_id INTEGER NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
		title TEXT NOT NULL,
		every_km INTEGER CHECK (every_km IS NULL OR every_km > 0),
		every_months INTEGER CHECK (every_months IS NULL OR every_months > 0),
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		CHECK (every_km IS NOT NULL OR every_months IS NOT NULL)
	);
	CREATE INDEX service_rules_vehicle ON service_rules(vehicle_id);
	CREATE INDEX service_rules_user ON service_rules(user_id);

	CREATE TABLE push_subscriptions (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		endpoint TEXT NOT NULL UNIQUE,
		p256dh TEXT NOT NULL,
		auth TEXT NOT NULL,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

	CREATE TABLE calendar_keys (
		user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
		token TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);

	CREATE TABLE reminders_sent (
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		key TEXT NOT NULL,
		sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
		PRIMARY KEY (user_id, key)
	);`,

	// AI agents. A connection is either a key you hand an agent yourself
	// (Instinct on WhatsApp, OpenClaw…) or what an assistant like Grok,
	// ChatGPT or Claude gets by signing in with OAuth. scope is 'read' or
	// 'write'. Only hashes of keys and tokens are kept. An OAuth access token
	// expires; its refresh token rotates on use.
	//
	// oauth_clients are the apps that registered (dynamic registration) or
	// that Kosh looked up from their metadata URL. oauth_codes live minutes.
	`CREATE TABLE agent_connections (
		id INTEGER PRIMARY KEY,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		kind TEXT NOT NULL CHECK (kind IN ('key', 'oauth')),
		scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
		client_id TEXT NOT NULL DEFAULT '',
		key_hash TEXT UNIQUE,
		access_hash TEXT UNIQUE,
		access_expires_at TEXT,
		refresh_hash TEXT UNIQUE,
		last_used_at TEXT,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);
	CREATE INDEX agent_connections_user ON agent_connections(user_id);

	CREATE TABLE oauth_clients (
		client_id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		redirect_uris TEXT NOT NULL,
		metadata_url INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	);

	CREATE TABLE oauth_codes (
		code_hash TEXT PRIMARY KEY,
		client_id TEXT NOT NULL,
		user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		redirect_uri TEXT NOT NULL,
		code_challenge TEXT NOT NULL,
		scope TEXT NOT NULL,
		resource TEXT NOT NULL DEFAULT '',
		expires_at TEXT NOT NULL
	);`,

	// What a category is for, when Kosh needs to know: 'interest' (interest
	// the bank paid you), 'interest-given' (interest given away to charity),
	// 'charges' (bank charges). Everyone's starter "Interest" category is
	// interest.
	`ALTER TABLE categories ADD COLUMN role TEXT NOT NULL DEFAULT '';
	UPDATE categories SET role = 'interest' WHERE kind = 'income' AND name = 'Interest';`,
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
