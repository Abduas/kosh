package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func postJSON(t *testing.T, hc *http.Client, u string, body any, headers map[string]string) (int, map[string]any, http.Header) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", u, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	out := map[string]any{}
	json.Unmarshal(data, &out)
	return res.StatusCode, out, res.Header
}

func getText(t *testing.T, u string) (int, string) {
	t.Helper()
	res, err := http.Get(u)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func TestAgentKeyAndTools(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Abdullah Samad", "username": "abdullah", "password": "password123"}, 201, nil)
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"payApps": []string{"gpay", "phonepe"}, "modules": []string{"finance", "vehicles"}}}, 200, nil)
	me.do("POST", "/api/accounts", map[string]any{"name": "HDFC", "kind": "bank", "color": "#3B82F6", "icon": "🏦", "openingBalance": 10_000_00}, 201, nil)
	me.do("POST", "/api/vehicles", map[string]any{"kind": "scooter", "name": "Activa", "regNumber": "KA05MN9876", "color": "#22C55E"}, 201, nil)

	var made struct {
		Key, Link, Message string
	}
	me.do("POST", "/api/agents", map[string]any{"name": "Instinct", "scope": "write"}, 201, &made)
	if !strings.HasPrefix(made.Key, keyPrefix) || !strings.Contains(made.Message, made.Link) || !strings.HasSuffix(made.Link, "/agent/"+made.Key) {
		t.Fatalf("made = %+v", made)
	}
	base := srv.URL + "/agent/" + made.Key

	// The instructions an agent reads.
	code, md := getText(t, base)
	if code != 200 || !strings.Contains(md, "Abdullah Samad") || !strings.Contains(md, "add_transaction") || !strings.Contains(md, "never pays anyone") {
		t.Fatalf("instructions %d:\n%s", code, md)
	}
	if code, _ := getText(t, srv.URL+"/agent/kosh_k_nope"); code != 404 {
		t.Fatalf("bad key: %d", code)
	}

	// Reading in a browser.
	code, body := getText(t, base+"/get_overview")
	if code != 200 || !strings.Contains(body, `"payApps":["gpay","phonepe"]`) || !strings.Contains(body, `"HDFC"`) {
		t.Fatalf("overview %d: %s", code, body)
	}
	// A GET never changes anything.
	if code, _ := getText(t, base+"/add_transaction?type=expense&amount=5"); code != 405 {
		t.Fatalf("GET write: %d", code)
	}

	// Writing, by name, in rupees.
	hc := &http.Client{}
	code, out, _ := postJSON(t, hc, base+"/add_transaction", map[string]any{"type": "expense", "amount": 249.5, "category": "food", "note": "Lunch", "account": "hdfc"}, nil)
	saved, _ := out["saved"].(map[string]any)
	if code != 200 || saved["amount"] != 249.5 || saved["category"] != "Food & Dining" || saved["account"] != "HDFC" || saved["addedBy"] != "an agent" {
		t.Fatalf("add %d: %v", code, out)
	}
	lunch := saved["id"].(float64)
	// Fuel for the scooter, with litres, also logged on the vehicle.
	code, out, _ = postJSON(t, hc, base+"/add_transaction", map[string]any{"type": "expense", "amount": "₹500", "category": "Fuel", "account": "HDFC", "vehicle": "ka 05 mn 9876", "litres": 4.6, "odometer": 12450}, nil)
	if code != 200 || out["saved"].(map[string]any)["vehicle"] != "Activa" {
		t.Fatalf("fuel %d: %v", code, out)
	}
	var g garage
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if len(g.Logs) != 1 || g.Logs[0].Kind != "fuel" || *g.Logs[0].Litres != 4600 {
		t.Fatalf("fuel log = %+v", g.Logs)
	}
	// Lending to someone new adds them.
	code, out, _ = postJSON(t, hc, base+"/add_transaction", map[string]any{"type": "lend", "amount": 1000, "person": "Rahul", "account": "HDFC"}, nil)
	if code != 200 || out["saved"].(map[string]any)["person"] != "Rahul" {
		t.Fatalf("lend %d: %v", code, out)
	}
	// Mistakes come back as messages to act on.
	code, out, _ = postJSON(t, hc, base+"/add_transaction", map[string]any{"type": "expense", "amount": 10, "account": "SBI"}, nil)
	if code != 400 || !strings.Contains(out["error"].(string), "HDFC") {
		t.Fatalf("unknown account %d: %v", code, out)
	}
	code, out, _ = postJSON(t, hc, base+"/add_vehicle_paper", map[string]any{"type": "puc", "expires_on": "2027-05-01"}, nil)
	if code != 200 {
		t.Fatalf("paper %d: %v", code, out)
	}

	// It may delete anything: what it added, and what the person added.
	var mine struct{ ID int64 }
	me.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 100, "accountId": 2, "occurredAt": "2026-11-10T10:00"}, 201, &mine)
	if code, out, _ := postJSON(t, hc, base+"/delete_transaction", map[string]any{"id": mine.ID}, nil); code != 200 {
		t.Fatalf("delete the person's: %d %v", code, out)
	}
	if code, out, _ := postJSON(t, hc, base+"/delete_transaction", map[string]any{"id": lunch}, nil); code != 200 {
		t.Fatalf("delete own: %d %v", code, out)
	}

	// Read-only: no write tools, and writes are refused.
	var conns struct {
		Connections []agentConn `json:"connections"`
		McpURL      string      `json:"mcpUrl"`
	}
	me.do("GET", "/api/agents", nil, 200, &conns)
	if len(conns.Connections) != 1 || conns.Connections[0].LastUsedAt == nil || !strings.HasSuffix(conns.McpURL, "/mcp") {
		t.Fatalf("connections = %+v", conns)
	}
	me.do("PATCH", fmt.Sprintf("/api/agents/%d", conns.Connections[0].ID), map[string]any{"scope": "read"}, 204, nil)
	if code, out, _ := postJSON(t, hc, base+"/add_transaction", map[string]any{"type": "expense", "amount": 1, "account": "HDFC"}, nil); code != 400 || !strings.Contains(out["error"].(string), "read-only") {
		t.Fatalf("read-only write: %d %v", code, out)
	}
	_, tools := getText(t, base+"/tools")
	if strings.Contains(tools, "add_transaction") {
		t.Fatal("read-only connection lists write tools")
	}

	// The same key works on the MCP server.
	auth := map[string]string{"Authorization": "Bearer " + made.Key}
	code, out, _ = postJSON(t, hc, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18"}}, auth)
	if code != 200 || out["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize %d: %v", code, out)
	}
	code, out, _ = postJSON(t, hc, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call",
		"params": map[string]any{"name": "list_transactions", "arguments": map[string]any{"person": "rahul"}}}, auth)
	res := out["result"].(map[string]any)
	if code != 200 || res["isError"] == true || !strings.Contains(res["content"].([]any)[0].(map[string]any)["text"].(string), "Rahul") {
		t.Fatalf("tools/call %d: %v", code, out)
	}

	// Disconnecting stops it at once.
	me.do("DELETE", fmt.Sprintf("/api/agents/%d", conns.Connections[0].ID), nil, 204, nil)
	if code, _ := getText(t, base+"/get_overview"); code != 404 {
		t.Fatalf("after disconnect: %d", code)
	}
}

func TestMCPWithOAuth(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "password123"}, 201, nil)
	noFollow := &http.Client{Jar: me.hc.Jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	anon := &http.Client{}

	// 1. The assistant tries the MCP URL and is told where to sign in.
	code, _, h := postJSON(t, anon, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize"}, nil)
	if code != 401 || !strings.Contains(h.Get("WWW-Authenticate"), "resource_metadata=\""+srv.URL+"/.well-known/oauth-protected-resource/mcp\"") {
		t.Fatalf("401: %d %v", code, h)
	}
	var prm, asm map[string]any
	_, body := getText(t, srv.URL+"/.well-known/oauth-protected-resource/mcp")
	json.Unmarshal([]byte(body), &prm)
	_, body = getText(t, srv.URL+"/.well-known/oauth-authorization-server")
	json.Unmarshal([]byte(body), &asm)
	if prm["resource"] != srv.URL+"/mcp" || asm["token_endpoint"] != srv.URL+"/oauth/token" || asm["client_id_metadata_document_supported"] != true {
		t.Fatalf("metadata: %v %v", prm, asm)
	}

	// 2. It registers.
	code, reg, _ := postJSON(t, anon, srv.URL+"/oauth/register", map[string]any{"client_name": "Grok", "redirect_uris": []string{"https://grok.com/callback"}}, nil)
	if code != 201 {
		t.Fatalf("register %d %v", code, reg)
	}
	if code, _, _ := postJSON(t, anon, srv.URL+"/oauth/register", map[string]any{"redirect_uris": []string{"javascript:alert(1)"}}, nil); code != 400 {
		t.Fatalf("bad redirect accepted: %d", code)
	}
	clientID := reg["client_id"].(string)

	// 3. The person signs in and allows it.
	verifier := strings.Repeat("v", 50)
	sum := sha256.Sum256([]byte(verifier))
	q := url.Values{"response_type": {"code"}, "client_id": {clientID}, "redirect_uri": {"https://grok.com/callback"}, "state": {"xyz"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])}, "code_challenge_method": {"S256"}, "resource": {srv.URL + "/mcp"}}
	if code, page := getText(t, srv.URL+"/oauth/authorize?"+q.Encode()); code != 200 || !strings.Contains(page, "Sign in to Kosh") {
		t.Fatalf("signed out: %d", code)
	}
	res, _ := noFollow.Get(srv.URL + "/oauth/authorize?" + q.Encode())
	page, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if !strings.Contains(string(page), "Connect Grok?") || !strings.Contains(string(page), "Never move money") {
		t.Fatalf("consent page:\n%s", page)
	}
	bad := url.Values{}
	for k, v := range q {
		bad[k] = v
	}
	bad.Set("redirect_uri", "https://evil.example/cb")
	if code, page := getText(t, srv.URL+"/oauth/authorize?"+bad.Encode()); code != 400 || !strings.Contains(page, "return to an address") {
		t.Fatalf("unregistered redirect: %d", code)
	}

	form := url.Values{}
	for k, v := range q {
		form[k] = v
	}
	form.Set("decision", "allow")
	form.Set("access", "write")
	res, _ = noFollow.PostForm(srv.URL+"/oauth/authorize", form)
	res.Body.Close()
	loc, _ := url.Parse(res.Header.Get("Location"))
	if res.StatusCode != 302 || loc.Host != "grok.com" || loc.Query().Get("state") != "xyz" || loc.Query().Get("code") == "" || loc.Query().Get("iss") != srv.URL {
		t.Fatalf("allow: %d %s", res.StatusCode, loc)
	}
	authCode := loc.Query().Get("code")

	// 4. Tokens: PKCE is checked, a code works once.
	tok := func(v url.Values) (int, map[string]any) {
		res, err := anon.PostForm(srv.URL+"/oauth/token", v)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		out := map[string]any{}
		json.NewDecoder(res.Body).Decode(&out)
		return res.StatusCode, out
	}
	if code, _ := tok(url.Values{"grant_type": {"authorization_code"}, "code": {authCode}, "client_id": {clientID}, "code_verifier": {strings.Repeat("x", 50)}}); code != 400 {
		t.Fatal("wrong verifier accepted")
	}
	// The failed try used the code up.
	if code, _ := tok(url.Values{"grant_type": {"authorization_code"}, "code": {authCode}, "client_id": {clientID}, "code_verifier": {verifier}}); code != 400 {
		t.Fatal("a code worked twice")
	}
	res, _ = noFollow.PostForm(srv.URL+"/oauth/authorize", form)
	res.Body.Close()
	loc, _ = url.Parse(res.Header.Get("Location"))
	code, tokens := tok(url.Values{"grant_type": {"authorization_code"}, "code": {loc.Query().Get("code")}, "client_id": {clientID},
		"code_verifier": {verifier}, "redirect_uri": {"https://grok.com/callback"}})
	if code != 200 || tokens["scope"] != "kosh.read kosh.write" {
		t.Fatalf("token %d: %v", code, tokens)
	}

	// 5. MCP with the token.
	auth := map[string]string{"Authorization": "Bearer " + tokens["access_token"].(string)}
	code, out, _ := postJSON(t, anon, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, auth)
	tools := out["result"].(map[string]any)["tools"].([]any)
	if code != 200 || len(tools) != len(agentTools) {
		t.Fatalf("tools/list %d: %d tools", code, len(tools))
	}
	code, _, _ = postJSON(t, anon, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"}, auth)
	if code != 202 {
		t.Fatalf("notification: %d", code)
	}
	code, out, _ = postJSON(t, anon, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call",
		"params": map[string]any{"name": "add_transaction", "arguments": map[string]any{"type": "income", "amount": 50000, "category": "Salary"}}}, auth)
	if r := out["result"].(map[string]any); code != 200 || r["isError"] == true {
		t.Fatalf("add via MCP: %v", out)
	}

	// 6. Refresh rotates; the old refresh token stops working.
	code, fresh := tok(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens["refresh_token"].(string)}, "client_id": {clientID}})
	if code != 200 || fresh["access_token"] == tokens["access_token"] {
		t.Fatalf("refresh %d %v", code, fresh)
	}
	if code, _ := tok(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {tokens["refresh_token"].(string)}, "client_id": {clientID}}); code != 400 {
		t.Fatal("old refresh token still works")
	}
	if code, _, _ := postJSON(t, anon, srv.URL+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "ping"}, auth); code != 401 {
		t.Fatal("old access token still works after refresh")
	}

	// It shows up in Settings, named after the app.
	var conns struct {
		Connections []agentConn `json:"connections"`
	}
	me.do("GET", "/api/agents", nil, 200, &conns)
	if len(conns.Connections) != 1 || conns.Connections[0].Name != "Grok" || conns.Connections[0].Kind != "oauth" {
		t.Fatalf("connections = %+v", conns.Connections)
	}

	// Denying sends the person back with access_denied.
	form.Set("decision", "deny")
	res, _ = noFollow.PostForm(srv.URL+"/oauth/authorize", form)
	res.Body.Close()
	if loc, _ := url.Parse(res.Header.Get("Location")); loc.Query().Get("error") != "access_denied" {
		t.Fatalf("deny: %s", loc)
	}
}
