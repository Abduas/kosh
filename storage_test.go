package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

// useFakeBucket points the app at an in-memory S3 for one test.
func useFakeBucket(t *testing.T) {
	backend := s3mem.New()
	if err := backend.CreateBucket("kosh-test"); err != nil {
		t.Fatal(err)
	}
	s3 := httptest.NewServer(gofakes3.New(backend).Server())
	t.Cleanup(s3.Close)
	t.Setenv("S3_BUCKET", "kosh-test")
	t.Setenv("AWS_ENDPOINT_URL_S3", s3.URL)
	t.Setenv("AWS_REGION", "us-east-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	reset := func() {
		bucketOnce = sync.Once{}
		theBucket = nil
	}
	reset()
	t.Cleanup(reset)
}

func TestDocumentFiles(t *testing.T) {
	useFakeBucket(t)
	srv := newTestServer(t)
	me := newClient(t, srv)
	me.do("POST", "/api/auth/signup", map[string]string{"name": "Abdullah", "username": "abdullah", "password": "password123"}, 201, nil)
	var v vehicle
	me.do("POST", "/api/vehicles", map[string]any{"kind": "car", "name": "Swift", "color": "#3B82F6"}, 201, &v)
	var d vehicleDoc
	me.do("POST", "/api/vehicle-documents", map[string]any{"vehicleId": v.ID, "type": "insurance", "expiresOn": "2027-03-11"}, 201, &d)

	upload := func(name, contentType string, data []byte) (int, vehicleDoc) {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		h := make(map[string][]string)
		h["Content-Disposition"] = []string{fmt.Sprintf(`form-data; name="file"; filename="%s"`, name)}
		h["Content-Type"] = []string{contentType}
		part, _ := mw.CreatePart(h)
		part.Write(data)
		mw.Close()
		req, _ := http.NewRequest("PUT", fmt.Sprintf("%s/api/vehicle-documents/%d/file", srv.URL, d.ID), &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		res, err := me.hc.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var out vehicleDoc
		if res.StatusCode == 200 {
			b, _ := io.ReadAll(res.Body)
			if err := jsonUnmarshal(b, &out); err != nil {
				t.Fatal(err)
			}
		}
		return res.StatusCode, out
	}

	if code, _ := upload("notes.txt", "text/plain", []byte("hi")); code != 400 {
		t.Fatalf("text file: %d", code)
	}
	pdf := []byte("%PDF-1.4 a policy")
	code, got := upload("policy.pdf", "application/pdf", pdf)
	if code != 200 || got.FileName != "policy.pdf" || got.FileSize != int64(len(pdf)) || got.FileID == "" {
		t.Fatalf("upload: %d %+v", code, got)
	}
	firstID := got.FileID

	// The app streams it back, cacheable.
	res, err := me.hc.Get(fmt.Sprintf("%s/api/vehicle-documents/%d/file", srv.URL, d.ID))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 200 || !bytes.Equal(b, pdf) || res.Header.Get("Content-Type") != "application/pdf" || !strings.Contains(res.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("download: %d %q %v", res.StatusCode, b, res.Header)
	}
	// Someone else can't.
	other := newClient(t, srv)
	other.do("POST", "/api/auth/signup", map[string]string{"name": "Sara", "username": "sara", "password": "password456"}, 201, nil)
	other.do("GET", fmt.Sprintf("/api/vehicle-documents/%d/file", d.ID), nil, 404, nil)

	// A new upload gets a new id, so phones fetch the new copy.
	_, got = upload("photo.jpg", "image/jpeg", []byte{0xff, 0xd8, 0xff})
	if got.FileID == firstID || got.FileType != "image/jpeg" {
		t.Fatalf("replace: %+v", got)
	}
	var g garage
	me.do("GET", "/api/vehicles", nil, 200, &g)
	if !g.Storage || g.Documents[0].FileID != got.FileID {
		t.Fatalf("garage = %+v", g)
	}
	me.do("DELETE", fmt.Sprintf("/api/vehicle-documents/%d/file", d.ID), nil, 200, &got)
	if got.FileID != "" || got.FileName != "" {
		t.Fatalf("after remove: %+v", got)
	}
	me.do("GET", fmt.Sprintf("/api/vehicle-documents/%d/file", d.ID), nil, 404, nil)
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
