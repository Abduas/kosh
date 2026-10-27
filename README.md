# Kosh

A self-hosted personal finance app that installs on your phone as a PWA.
Track every bank account, cash and wallets, money you lend and borrow, budgets and
where your money goes. One small Go binary, your data in one SQLite file.

## What it does today

- **Accounts:** banks, cash, wallets (Paytm, PhonePe…), credit cards, savings. Balances update with every entry.
- **Fast entry:** a keypad that does sums (`450+120`), one-tap categories, and keyboard input on desktop.
- **People:** lend, borrow, partial repayments, a running balance per person, one-tap "settle up",
  and WhatsApp reminders with your UPI ID.
- **Transfers:** moving money between accounts (an ATM withdrawal is bank → cash) isn't counted as spending.
- **Insights:** spending by day and by category, comparison with the previous period, savings rate, biggest expenses.
- **Budgets:** a monthly budget plus per-category limits, with "safe to spend per day".
- **Search:** notes, categories, people, accounts or an exact amount, across all time.
- **Privacy:** tap the eye to blur every amount. Export everything to CSV.
- **PWA:** installs to the home screen, opens instantly from an on-device cache, works offline for viewing.

## Run it locally

You need Go 1.26+ and Node 24+.

```sh
make api       # Go API on http://127.0.0.1:3100
make web-dev   # in another terminal: Vite on http://localhost:5173
```

Open http://localhost:5173 and create your account. The first account created owns the app.
To try it on your phone over Wi-Fi, run `cd web && npm run dev -- --host` and open the address it prints.

## Build and deploy

```sh
make build     # one Linux binary, ./app, with the frontend inside
```

Run `./app` anywhere. It reads `PORT` (default 3100), `HOST` (default 127.0.0.1), `DATA_DIR` and `DATABASE_PATH`.
It's also built to deploy on [Sideyard](https://rabeeh-ta.github.io/sideyard/): see `AGENTS.md` and
`.github/workflows/deploy.yml`. Schedule the `cleanup-sessions` job daily.

## Code map

| Path | What's there |
|---|---|
| `db.go` | Schema and migrations (append-only) |
| `auth.go` | First-run setup, login, sessions, rate limiting |
| `finance.go` | Accounts, categories, people, settings |
| `transactions.go` | Transactions: validation, search, paging |
| `insights.go`, `budgets.go` | Reports, budgets, CSV export |
| `api_test.go` | End-to-end API tests (`go test ./...`) |
| `web/src/components/Composer.tsx` | The add/edit transaction sheet and keypad |
| `web/src/screens/` | Home, Activity, People, Insights, Accounts, Budgets, Settings |

Money is stored as integers in minor units (paise). Each transaction has a kind that decides
which balances it moves: `expense`, `income`, `transfer`, `lend`, `borrow`, `collect` (they paid you back)
and `repay` (you paid them back).

## Roadmap

- Vehicles and documents (insurance, PUC, tax, RC, licence) with expiry reminders
- Works and clients, with monthly or yearly billing and pending payments
- Automatic capture of UPI payments (share target, Android companion app, SMS and email parsing)
- Recurring transactions and offline entry with sync
