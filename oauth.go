package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"syscall"
	"time"
)

// Kosh is its own OAuth 2.1 authorization server for the MCP endpoint, so
// assistants connect with a sign-in and an Allow button, never a pasted key.
//
//   - Discovery: /.well-known/oauth-protected-resource (RFC 9728) and
//     /.well-known/oauth-authorization-server (RFC 8414).
//   - Clients: dynamic registration at /oauth/register (RFC 7591), or a
//     client_id that is an https URL to the client's metadata document
//     (Client ID Metadata Documents, which newer MCP clients prefer).
//   - Authorization code with PKCE (S256 only); refresh tokens rotate.
//
// The person signs in to Kosh as usual, then sees what the assistant asks
// for and may make it read-only.

const (
	accessTTL = time.Hour
	codeTTL   = 5 * time.Minute
)

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Protocol-Version")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
}

func (a *api) protectedResource(w http.ResponseWriter, r *http.Request) {
	cors(w)
	base := baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 base + "/mcp",
		"authorization_servers":    []string{base},
		"bearer_methods_supported": []string{"header"},
		"scopes_supported":         []string{"kosh.read", "kosh.write"},
		"resource_name":            "Kosh",
	})
}

func (a *api) authServerMetadata(w http.ResponseWriter, r *http.Request) {
	cors(w)
	base := baseURL(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                         base,
		"authorization_endpoint":                         base + "/oauth/authorize",
		"token_endpoint":                                 base + "/oauth/token",
		"registration_endpoint":                          base + "/oauth/register",
		"response_types_supported":                       []string{"code"},
		"grant_types_supported":                          []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":               []string{"S256"},
		"token_endpoint_auth_methods_supported":          []string{"none"},
		"scopes_supported":                               []string{"kosh.read", "kosh.write"},
		"client_id_metadata_document_supported":          true,
		"authorization_response_iss_parameter_supported": true,
	})
}

// ---- Clients ----

type oauthClient struct {
	id        string
	name      string
	redirects []string
}

// validRedirect allows https, http only to this computer (desktop apps), and
// app schemes like cursor://; never javascript: and friends.
func validRedirect(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.Scheme == "" {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return u.Host != ""
	case "http":
		h := u.Hostname()
		return h == "localhost" || h == "127.0.0.1" || h == "::1"
	case "javascript", "data", "file", "vbscript", "about", "blob":
		return false
	}
	return true
}

var regLimiter = newLimiter(time.Hour, 30)

func (a *api) registerClient(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	ip := clientIP(r)
	if !regLimiter.allow(ip) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "slow_down"})
		return
	}
	regLimiter.fail(ip)
	var in struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&in); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_client_metadata"})
		return
	}
	if len(in.RedirectURIs) == 0 || len(in.RedirectURIs) > 10 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_redirect_uri"})
		return
	}
	for _, u := range in.RedirectURIs {
		if !validRedirect(u) || len(u) > 500 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_redirect_uri", "error_description": u})
			return
		}
	}
	name := strings.TrimSpace(in.ClientName)
	if name == "" {
		name = "An AI assistant"
	}
	if len([]rune(name)) > 60 {
		name = string([]rune(name)[:60])
	}
	id := "kc_" + randomKey()
	uris, _ := json.Marshal(in.RedirectURIs)
	if _, err := a.db.ExecContext(r.Context(), `INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES (?, ?, ?)`, id, name, string(uris)); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id": id, "client_id_issued_at": time.Now().Unix(), "client_name": name,
		"redirect_uris": in.RedirectURIs, "token_endpoint_auth_method": "none",
		"grant_types": []string{"authorization_code", "refresh_token"}, "response_types": []string{"code"},
	})
}

// metadataClient fetches a client's metadata document from its https
// client_id, refusing to reach this server's own network.
var metadataClient = &http.Client{
	Timeout: 5 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("no redirects")
	},
	Transport: &http.Transport{
		DialContext: (&net.Dialer{
			Timeout: 4 * time.Second,
			Control: func(_, address string, _ syscall.RawConn) error {
				host, _, _ := net.SplitHostPort(address)
				ip := net.ParseIP(host)
				if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
					return errors.New("blocked address")
				}
				return nil
			},
		}).DialContext,
	},
}

func (a *api) findClient(ctx context.Context, id string) (oauthClient, error) {
	c := oauthClient{id: id}
	var uris, created string
	var fromURL bool
	err := a.db.QueryRowContext(ctx, `SELECT name, redirect_uris, metadata_url, created_at FROM oauth_clients WHERE client_id = ?`, id).Scan(&c.name, &uris, &fromURL, &created)
	fresh := err == nil && (!fromURL || created > time.Now().Add(-time.Hour).UTC().Format(timeLayout))
	if err == nil && fresh {
		json.Unmarshal([]byte(uris), &c.redirects)
		return c, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return c, err
	}
	// A Client ID Metadata Document.
	u, perr := url.Parse(id)
	if perr != nil || u.Scheme != "https" || u.Host == "" || u.Path == "" || u.Path == "/" {
		return c, errors.New("unknown client")
	}
	res, err := metadataClient.Get(id)
	if err != nil {
		return c, fmt.Errorf("couldn't read the client's details: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return c, fmt.Errorf("the client's details answered %d", res.StatusCode)
	}
	var doc struct {
		ClientID     string   `json:"client_id"`
		ClientName   string   `json:"client_name"`
		RedirectURIs []string `json:"redirect_uris"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&doc); err != nil || doc.ClientID != id || len(doc.RedirectURIs) == 0 {
		return c, errors.New("the client's details don't match")
	}
	for _, x := range doc.RedirectURIs {
		if !validRedirect(x) {
			return c, errors.New("the client asks to return somewhere unsafe")
		}
	}
	c.name = strings.TrimSpace(doc.ClientName)
	if c.name == "" {
		c.name = u.Host
	}
	c.redirects = doc.RedirectURIs
	b, _ := json.Marshal(doc.RedirectURIs)
	_, err = a.db.ExecContext(ctx, `INSERT INTO oauth_clients (client_id, name, redirect_uris, metadata_url) VALUES (?, ?, ?, 1)
		ON CONFLICT (client_id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`,
		id, c.name, string(b))
	return c, err
}

// ---- Authorize: sign in, then Allow ----

type authRequest struct {
	ClientID, RedirectURI, State, Challenge, Scope, Resource string
}

func readAuthRequest(v url.Values) authRequest {
	return authRequest{
		ClientID: v.Get("client_id"), RedirectURI: v.Get("redirect_uri"), State: v.Get("state"),
		Challenge: v.Get("code_challenge"), Scope: v.Get("scope"), Resource: v.Get("resource"),
	}
}

func (q authRequest) values() url.Values {
	v := url.Values{"response_type": {"code"}, "client_id": {q.ClientID}, "redirect_uri": {q.RedirectURI},
		"code_challenge": {q.Challenge}, "code_challenge_method": {"S256"}}
	for k, x := range map[string]string{"state": q.State, "scope": q.Scope, "resource": q.Resource} {
		if x != "" {
			v.Set(k, x)
		}
	}
	return v
}

// checkAuth validates the request; a non-nil redirect means errors can go
// back to the client, otherwise they're shown here.
func (a *api) checkAuth(r *http.Request, q *authRequest, v url.Values) (oauthClient, *url.URL, string) {
	c, err := a.findClient(r.Context(), q.ClientID)
	if err != nil {
		return c, nil, "This app isn't registered with Kosh. Try connecting again from the app. (" + err.Error() + ")"
	}
	if q.RedirectURI == "" && len(c.redirects) == 1 {
		q.RedirectURI = c.redirects[0]
	}
	if !slices.Contains(c.redirects, q.RedirectURI) {
		return c, nil, "This app asked to return to an address it didn't register."
	}
	back, _ := url.Parse(q.RedirectURI)
	if v.Get("response_type") != "code" {
		return c, back, "unsupported_response_type"
	}
	if q.Challenge == "" || v.Get("code_challenge_method") != "S256" {
		return c, back, "invalid_request"
	}
	base := baseURL(r)
	if q.Resource != "" && strings.TrimRight(q.Resource, "/") != base+"/mcp" && strings.TrimRight(q.Resource, "/") != base {
		return c, back, "invalid_target"
	}
	return c, back, ""
}

func redirectWith(w http.ResponseWriter, r *http.Request, back *url.URL, params map[string]string) {
	q := back.Query()
	for k, v := range params {
		if v != "" {
			q.Set(k, v)
		}
	}
	q.Set("iss", baseURL(r))
	back.RawQuery = q.Encode()
	http.Redirect(w, r, back.String(), http.StatusFound)
}

func (a *api) authorize(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		r.ParseForm()
	}
	v := r.Form
	if r.Method == http.MethodGet {
		v = r.URL.Query()
	}
	q := readAuthRequest(v)
	client, back, problem := a.checkAuth(r, &q, v)
	if problem != "" {
		if back == nil {
			renderOAuthPage(w, http.StatusBadRequest, oauthPage{Title: "Can't connect", Message: problem})
			return
		}
		redirectWith(w, r, back, map[string]string{"error": problem, "state": q.State})
		return
	}
	uid, err := a.sessionUser(r)
	if err != nil {
		// Sign in first; the app brings you back here.
		renderOAuthPage(w, http.StatusOK, oauthPage{
			Title:    "Sign in to Kosh",
			Message:  client.name + " wants to connect to your Kosh. Sign in first, then you'll choose what it may do.",
			Link:     "/?after=" + url.QueryEscape("/oauth/authorize?"+q.values().Encode()),
			LinkText: "Sign in to Kosh",
		})
		return
	}

	if r.Method == http.MethodGet {
		var name string
		a.db.QueryRowContext(r.Context(), `SELECT name FROM users WHERE id = ?`, uid).Scan(&name)
		renderOAuthPage(w, http.StatusOK, oauthPage{Consent: true, Client: client.name, User: name, Host: requestHost(r), Fields: q.values(),
			Title: "Connect " + client.name + "?"})
		return
	}

	// The Allow / Deny form. The session cookie is SameSite=Lax, so another
	// site can't post this as you; check the origin too.
	if o := r.Header.Get("Origin"); o != "" {
		if u, err := url.Parse(o); err != nil || !strings.EqualFold(u.Host, requestHost(r)) {
			http.Error(w, "cross-site request", http.StatusForbidden)
			return
		}
	}
	if v.Get("decision") != "allow" {
		redirectWith(w, r, back, map[string]string{"error": "access_denied", "state": q.State})
		return
	}
	scope := "kosh.read kosh.write"
	if v.Get("access") == "read" {
		scope = "kosh.read"
	}
	code := "kosh_ac_" + randomKey() + randomKey()
	if _, err := a.db.ExecContext(r.Context(), `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, resource, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, hashToken(code), q.ClientID, uid, q.RedirectURI, q.Challenge, scope, q.Resource,
		time.Now().Add(codeTTL).UTC().Format(timeLayout)); err != nil {
		serverError(w, err)
		return
	}
	redirectWith(w, r, back, map[string]string{"code": code, "state": q.State})
}

// ---- Tokens ----

func tokenError(w http.ResponseWriter, code, about string) {
	cors(w)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusBadRequest, map[string]string{"error": code, "error_description": about})
}

func pkceOK(verifier, challenge string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

func (a *api) token(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	if err := r.ParseForm(); err != nil {
		tokenError(w, "invalid_request", "send a form")
		return
	}
	ctx := r.Context()
	clientID := r.PostForm.Get("client_id")
	now := time.Now().UTC()
	issue := func(connID int64, scope string) {
		access, refresh := newSecret(accessPrefix), newSecret(refreshPrefix)
		if _, err := a.db.ExecContext(ctx, `UPDATE agent_connections SET access_hash = ?, access_expires_at = ?, refresh_hash = ? WHERE id = ?`,
			hashToken(access), now.Add(accessTTL).Format(timeLayout), hashToken(refresh), connID); err != nil {
			serverError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"access_token": access, "token_type": "Bearer", "expires_in": int(accessTTL.Seconds()),
			"refresh_token": refresh, "scope": scope})
	}
	scopeOf := func(s string) string {
		if s == "write" {
			return "kosh.read kosh.write"
		}
		return "kosh.read"
	}

	switch r.PostForm.Get("grant_type") {
	case "authorization_code":
		var uid int64
		var cid, redirect, challenge, scope, expires string
		err := a.db.QueryRowContext(ctx, `DELETE FROM oauth_codes WHERE code_hash = ? RETURNING user_id, client_id, redirect_uri, code_challenge, scope, expires_at`,
			hashToken(r.PostForm.Get("code"))).Scan(&uid, &cid, &redirect, &challenge, &scope, &expires)
		switch {
		case err != nil:
			tokenError(w, "invalid_grant", "that code isn't valid; connect again")
		case expires < now.Format(timeLayout):
			tokenError(w, "invalid_grant", "that code expired; connect again")
		case cid != clientID:
			tokenError(w, "invalid_grant", "code was for another client")
		case r.PostForm.Get("redirect_uri") != "" && r.PostForm.Get("redirect_uri") != redirect:
			tokenError(w, "invalid_grant", "redirect_uri doesn't match")
		case !pkceOK(r.PostForm.Get("code_verifier"), challenge):
			tokenError(w, "invalid_grant", "PKCE check failed")
		default:
			c, _ := a.findClient(ctx, cid)
			name := c.name
			if name == "" {
				name = "AI assistant"
			}
			s := "read"
			if strings.Contains(scope, "kosh.write") {
				s = "write"
			}
			// Connecting the same app again replaces its old connection.
			a.db.ExecContext(ctx, `DELETE FROM agent_connections WHERE user_id = ? AND kind = 'oauth' AND client_id = ?`, uid, cid)
			res, err := a.db.ExecContext(ctx, `INSERT INTO agent_connections (user_id, name, kind, scope, client_id) VALUES (?, ?, 'oauth', ?, ?)`, uid, name, s, cid)
			if err != nil {
				serverError(w, err)
				return
			}
			id, _ := res.LastInsertId()
			issue(id, scopeOf(s))
		}
	case "refresh_token":
		var id int64
		var cid, scope string
		err := a.db.QueryRowContext(ctx, `SELECT id, client_id, scope FROM agent_connections WHERE refresh_hash = ?`, hashToken(r.PostForm.Get("refresh_token"))).Scan(&id, &cid, &scope)
		if err != nil || (clientID != "" && clientID != cid) {
			tokenError(w, "invalid_grant", "sign in again")
			return
		}
		issue(id, scopeOf(scope))
	default:
		tokenError(w, "unsupported_grant_type", "use authorization_code or refresh_token")
	}
}

// cleanupOAuth drops expired codes and clients nobody connected with; run
// from the daily cleanup job.
func cleanupOAuth(ctx context.Context, db *sql.DB) {
	db.ExecContext(ctx, `DELETE FROM oauth_codes WHERE expires_at < ?`, time.Now().UTC().Format(timeLayout))
	db.ExecContext(ctx, `DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM agent_connections)`,
		time.Now().AddDate(0, 0, -30).UTC().Format(timeLayout))
}

// ---- The page ----

type oauthPage struct {
	Title, Message, Link, LinkText string
	Consent                        bool
	Client, User, Host             string
	Fields                         url.Values
}

var oauthTmpl = template.Must(template.New("oauth").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>{{.Title}} · Kosh</title><link rel="icon" href="/icon.svg">
<style>
:root{--bg:#F7F7FA;--surface:#fff;--ink:#0B0B12;--ink2:#5B5B6B;--line:#E7E7EE;--accent:#7C5CFF}
@media (prefers-color-scheme:dark){:root{--bg:#0B0B10;--surface:#17171F;--ink:#F4F4F7;--ink2:#A0A0B0;--line:#26262F}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;background:var(--bg);color:var(--ink);
font:16px/1.45 -apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif;padding:24px 16px}
main{width:100%;max-width:420px}.card{background:var(--surface);border-radius:28px;padding:28px 24px;box-shadow:0 10px 40px -20px rgba(0,0,0,.25)}
.logo{display:flex;gap:10px;align-items:center;justify-content:center;margin-bottom:18px}.logo img{width:44px;height:44px}
h1{font-size:24px;letter-spacing:-.02em;text-align:center;margin:0 0 6px}p{color:var(--ink2);text-align:center;margin:0 0 20px}
ul{list-style:none;padding:0;margin:0 0 18px;border:1px solid var(--line);border-radius:18px}li{padding:12px 14px;display:flex;gap:10px}
li+li{border-top:1px solid var(--line)}li span{font-size:20px;line-height:1.2}li b{display:block;font-weight:600}li small{color:var(--ink2)}
label.opt{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;border:1.5px solid var(--line);border-radius:16px;margin-bottom:8px;cursor:pointer}
label.opt:has(input:checked){border-color:var(--accent);background:color-mix(in oklab,var(--accent) 8%,transparent)}
label.opt input{accent-color:var(--accent);margin-top:4px}label.opt small{display:block;color:var(--ink2)}
.btns{display:flex;gap:10px;margin-top:18px}button,a.btn{flex:1;height:52px;border:0;border-radius:16px;font-family:inherit;font-weight:600;font-size:16px;cursor:pointer;
display:grid;place-items:center;text-decoration:none}.allow,a.btn{background:var(--accent);color:#fff}.deny{background:var(--line);color:var(--ink)}
.fine{font-size:13px;margin:16px 0 0}
</style></head><body><main><div class="card">
<div class="logo"><img src="/icon.svg" alt=""></div>
<h1>{{.Title}}</h1>
{{if .Consent}}
<p><b>{{.Client}}</b> wants to use {{if .User}}{{.User}}'s {{end}}Kosh at {{.Host}}.</p>
<ul>
<li><span>📖</span><div><b>See your money and vehicles</b><small>Balances, transactions, spending, people, papers and their expiry dates</small></div></li>
<li><span>✍️</span><div><b>Add entries, if you allow it</b><small>Expenses, income, loans, fuel, services, renewed papers. It can delete only what it added.</small></div></li>
<li><span>🔒</span><div><b>Never move money</b><small>Kosh only keeps records. It can't pay anyone or change your settings.</small></div></li>
</ul>
<form method="post" action="/oauth/authorize">
{{range $k, $v := .Fields}}<input type="hidden" name="{{$k}}" value="{{index $v 0}}">{{end}}
<label class="opt"><input type="radio" name="access" value="write" checked><div><b>See and add</b><small>Best for telling it "I spent ₹200 on lunch"</small></div></label>
<label class="opt"><input type="radio" name="access" value="read"><div><b>See only</b><small>It can answer questions but not add anything</small></div></label>
<div class="btns"><button class="deny" name="decision" value="deny">Cancel</button><button class="allow" name="decision" value="allow">Allow</button></div>
</form>
<p class="fine">You can make it read-only or disconnect it any time in Kosh → Settings → AI agents.</p>
{{else}}
<p>{{.Message}}</p>
{{if .Link}}<a class="btn" href="{{.Link}}">{{.LinkText}}</a>{{end}}
{{end}}
</div></main></body></html>`))

func renderOAuthPage(w http.ResponseWriter, status int, p oauthPage) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Frame-Options", "DENY")
	w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
	w.WriteHeader(status)
	oauthTmpl.Execute(w, p)
}
