package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// post sends a bank message the way the Shortcuts action does: JSON, no cookie.
func postCapture(t *testing.T, url, body, contentType string, want int) string {
	t.Helper()
	resp, err := http.Post(url, contentType, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		Status string `json:"status"`
	}
	if resp.StatusCode != want {
		t.Fatalf("capture: got %d, want %d", resp.StatusCode, want)
	}
	if want == 200 {
		if err := decodeJSON(resp, &out); err != nil {
			t.Fatal(err)
		}
	}
	return out.Status
}

func TestCaptureFlow(t *testing.T) {
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "A", "username": "capturer", "password": "password123"}, 201, nil)
	var boot struct {
		Categories []category `json:"categories"`
	}
	me.do("GET", "/api/bootstrap", nil, 200, &boot)
	var food int64
	for _, c := range boot.Categories {
		if c.Kind == "expense" {
			food = c.ID
			break
		}
	}
	var hdfc, sbi idResp
	me.do("POST", "/api/accounts", map[string]any{"name": "HDFC", "kind": "bank", "institution": "HDFC Bank", "last4": "4521", "color": "#3B82F6", "icon": "🏦"}, 201, &hdfc)
	me.do("POST", "/api/accounts", map[string]any{"name": "SBI Savings", "kind": "bank", "last4": "7788", "color": "#10B981", "icon": "🏦"}, 201, &sbi)

	var setup captureSetup
	me.do("GET", "/api/captures/setup", nil, 200, &setup)
	if setup.Enabled {
		t.Fatal("capture on before setup")
	}
	me.do("PUT", "/api/captures/setup", map[string]any{"timezone": "Asia/Kolkata"}, 200, &setup)
	if !setup.Enabled || len(setup.Token) < 20 {
		t.Fatalf("setup = %+v", setup)
	}
	link := srv.URL + "/api/capture/" + setup.Token
	postCapture(t, srv.URL+"/api/capture/not-a-token", `{"text":"x"}`, "application/json", 401)

	// Chats and OTPs are ignored and not kept.
	if s := postCapture(t, link, `{"text":"see you at 5"}`, "application/json", 200); s != captureIgnored {
		t.Fatalf("chat: %s", s)
	}

	// An unknown payee goes to review, on the account its digits name.
	swiggy := "Sent Rs.250.00\nFrom HDFC Bank A/C *4521\nTo SWIGGY LIMITED\nOn 13/11/25\nRef 531712345678\nNot You?"
	if s := postCapture(t, link, `{"text":`+jsonString(swiggy)+`}`, "application/json", 200); s != captureReview {
		t.Fatalf("first swiggy: %s", s)
	}
	// The same message again, or the same payment told by another app, is a duplicate.
	if s := postCapture(t, link, swiggy, "text/plain", 200); s != captureDuplicate {
		t.Fatalf("repeat: %s", s)
	}
	var list struct {
		Items []capture `json:"items"`
	}
	me.do("GET", "/api/captures", nil, 200, &list)
	if len(list.Items) != 1 || list.Items[0].AccountID == nil || *list.Items[0].AccountID != hdfc.ID || list.Items[0].Amount != 25000 || list.Items[0].Suggestion.Kind != "expense" {
		t.Fatalf("review list = %+v", list.Items)
	}

	// Saving it from review files it and teaches Kosh the merchant.
	c := list.Items[0]
	var saved transaction
	me.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": c.Amount, "accountId": hdfc.ID, "categoryId": food, "occurredAt": c.OccurredAt, "captureId": c.ID, "note": "Swiggy"}, 201, &saved)
	if saved.Source != "sms" || saved.Ref != "531712345678" {
		t.Fatalf("saved = %+v", saved)
	}
	me.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": c.Amount, "accountId": hdfc.ID, "occurredAt": c.OccurredAt, "captureId": c.ID}, 400, nil)
	me.do("GET", "/api/captures", nil, 200, &list)
	if len(list.Items) != 0 {
		t.Fatalf("still in review: %+v", list.Items)
	}

	// Next time the same merchant is saved straight away, in the same category.
	again := "Sent Rs.180.00\nFrom HDFC Bank A/C *4521\nTo SWIGGY LIMITED\nOn 14/11/25\nRef 531712349999\nNot You?"
	if s := postCapture(t, link, `{"text":`+jsonString(again)+`}`, "application/json", 200); s != captureSaved {
		t.Fatalf("known merchant: %s", s)
	}
	var page struct {
		Items []transaction `json:"items"`
	}
	me.do("GET", "/api/transactions?q=531712349999", nil, 200, &page)
	me.do("GET", "/api/transactions", nil, 200, &page)
	if len(page.Items) != 2 || page.Items[0].Amount != 18000 || page.Items[0].CategoryID == nil || *page.Items[0].CategoryID != food || page.Items[0].AccountID != hdfc.ID {
		t.Fatalf("auto-saved = %+v", page.Items)
	}

	// With auto-save off, it waits for review instead.
	me.do("PATCH", "/api/me", map[string]any{"prefs": map[string]any{"captureAuto": false}}, 200, nil)
	third := strings.Replace(again, "531712349999", "531712340000", 1)
	if s := postCapture(t, link, `{"text":`+jsonString(third)+`}`, "application/json", 200); s != captureReview {
		t.Fatalf("auto off: %s", s)
	}
	me.do("GET", "/api/captures", nil, 200, &list)
	if len(list.Items) != 1 || !list.Items[0].Suggestion.Known || *list.Items[0].Suggestion.CategoryID != food {
		t.Fatalf("suggestion = %+v", list.Items)
	}
	me.do("POST", "/api/captures/"+itoa(list.Items[0].ID)+"/dismiss", nil, 204, nil)

	// A payment already recorded with scan & pay is matched, not added twice.
	now := time.Now().In(mustLoc("Asia/Kolkata")).Format(localTimeLayout)
	var scanned transaction
	me.do("POST", "/api/transactions", map[string]any{"kind": "expense", "amount": 12000, "accountId": sbi.ID, "occurredAt": now, "source": "upi-scan", "payee": "tea@ybl"}, 201, &scanned)
	sbiMsg := "Dear UPI user A/C X7788 debited by 120.0 on date 13Nov25 trf to RAMESH TEA Refno 531755554444. If not u? call 1800111109. -SBI"
	if s := postCapture(t, link, "text="+urlEscape(sbiMsg), "application/x-www-form-urlencoded", 200); s != captureMatched {
		t.Fatalf("scan & pay: %s", s)
	}
	var got transaction
	me.do("GET", "/api/transactions?q=tea", nil, 200, &page)
	for _, x := range page.Items {
		if x.ID == scanned.ID {
			got = x
		}
	}
	if got.Ref != "531755554444" {
		t.Fatalf("matched transaction = %+v", got)
	}

	// A new link stops the old one.
	me.do("PUT", "/api/captures/setup", map[string]any{"rotate": true}, 200, &setup)
	postCapture(t, link, `{"text":"x"}`, "application/json", 401)
	me.do("DELETE", "/api/captures/setup", nil, 204, nil)
	postCapture(t, srv.URL+"/api/capture/"+setup.Token, `{"text":"x"}`, "application/json", 401)
}

func decodeJSON(resp *http.Response, v any) error { return json.NewDecoder(resp.Body).Decode(v) }
func jsonString(s string) string                  { b, _ := json.Marshal(s); return string(b) }
func itoa(n int64) string                         { return strconv.FormatInt(n, 10) }
func urlEscape(s string) string                   { return url.QueryEscape(s) }
func mustLoc(name string) *time.Location {
	l, err := time.LoadLocation(name)
	if err != nil {
		panic(err)
	}
	return l
}
