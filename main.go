// Command app is Kosh, a personal finance app: one Go binary that serves a
// JSON API and the React frontend embedded from web/dist. It runs on Sideyard
// or anywhere else as a plain binary.
package main

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

//go:embed all:web/dist
var webDist embed.FS

func main() {
	// Sideyard sets these. The fallbacks are for running locally.
	port := env("PORT", "3100")
	host := env("HOST", "127.0.0.1")
	dataDir := env("DATA_DIR", "data")
	dbPath := env("DATABASE_PATH", filepath.Join(dataDir, "app.db"))

	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		log.Fatal(err)
	}
	db, err := openDB(dbPath)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	// 127.0.0.1 by default: Sideyard's proxy is the public entry point.
	srv := &http.Server{Addr: host + ":" + port, Handler: newServer(db), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("listening on http://%s", srv.Addr)
		if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()

	// Sideyard sends SIGTERM when a new release takes over. Finish in-flight
	// requests, then exit.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	srv.Shutdown(shutdownCtx)
}

// newServer wires every route. It's separate from main so tests can run the
// whole API against a temporary database.
func newServer(db *sql.DB) http.Handler {
	a := &api{db: db, limiter: newLoginLimiter()}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		if err := db.PingContext(r.Context()); err != nil {
			http.Error(w, "database unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok"))
	})

	// Auth
	mux.HandleFunc("GET /api/auth/status", a.authStatus)
	mux.HandleFunc("POST /api/auth/setup", a.setup)
	mux.HandleFunc("POST /api/auth/login", a.login)
	mux.HandleFunc("POST /api/auth/logout", a.logout)

	// Everything below needs a signed-in user.
	mux.HandleFunc("GET /api/bootstrap", a.authed(a.bootstrap))
	mux.HandleFunc("PATCH /api/me", a.authed(a.updateMe))

	mux.HandleFunc("POST /api/accounts", a.authed(a.createAccount))
	mux.HandleFunc("PATCH /api/accounts/{id}", a.authed(a.updateAccount))
	mux.HandleFunc("DELETE /api/accounts/{id}", a.authed(a.deleteAccount))
	mux.HandleFunc("PUT /api/accounts/order", a.authed(a.reorderAccounts))

	mux.HandleFunc("POST /api/categories", a.authed(a.createCategory))
	mux.HandleFunc("PATCH /api/categories/{id}", a.authed(a.updateCategory))
	mux.HandleFunc("DELETE /api/categories/{id}", a.authed(a.deleteCategory))

	mux.HandleFunc("POST /api/people", a.authed(a.createPerson))
	mux.HandleFunc("PATCH /api/people/{id}", a.authed(a.updatePerson))
	mux.HandleFunc("DELETE /api/people/{id}", a.authed(a.deletePerson))

	mux.HandleFunc("GET /api/transactions", a.authed(a.listTransactions))
	mux.HandleFunc("POST /api/transactions", a.authed(a.createTransaction))
	mux.HandleFunc("PATCH /api/transactions/{id}", a.authed(a.updateTransaction))
	mux.HandleFunc("DELETE /api/transactions/{id}", a.authed(a.deleteTransaction))

	mux.HandleFunc("GET /api/insights", a.authed(a.insights))
	mux.HandleFunc("GET /api/insights/balance", a.authed(a.balanceHistory))

	mux.HandleFunc("GET /api/budgets", a.authed(a.listBudgets))
	mux.HandleFunc("PUT /api/budgets", a.authed(a.upsertBudget))
	mux.HandleFunc("DELETE /api/budgets/{id}", a.authed(a.deleteBudget))

	mux.HandleFunc("GET /api/export.csv", a.authed(a.exportCSV))

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})
	mux.HandleFunc("POST /_jobs/{name}", jobHandler(db))
	mux.Handle("/", frontend(webDist))

	return sameOrigin(mux)
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
