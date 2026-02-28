package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestSecurityHeaders(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	handler := securityHeaders(inner)
	req := httptest.NewRequest("GET", "/", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	tests := map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":       "DENY",
		"Referrer-Policy":       "no-referrer",
	}
	for header, expected := range tests {
		got := rec.Header().Get(header)
		if got != expected {
			t.Errorf("%s = %q, want %q", header, got, expected)
		}
	}

	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'self'") {
		t.Errorf("CSP missing default-src 'self': %q", csp)
	}
	if !strings.Contains(csp, "script-src 'self' 'unsafe-inline'") {
		t.Errorf("CSP missing script-src: %q", csp)
	}
	if !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Errorf("CSP missing frame-ancestors: %q", csp)
	}
}

func TestRouting(t *testing.T) {
	// Create temp static dir
	tmpDir := t.TempDir()
	os.WriteFile(tmpDir+"/index.html", []byte("<html>test-index</html>"), 0644)
	os.WriteFile(tmpDir+"/app.js", []byte("// test js"), 0644)
	os.WriteFile(tmpDir+"/style.css", []byte("/* test css */"), 0644)

	server := NewServer()
	staticFS := http.FileServer(http.Dir(tmpDir))

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			server.handleWS(w, r)
			return
		}
		if r.URL.Path == "/room-info" {
			server.handleRoomInfo(w, r)
			return
		}
		if r.URL.Path == "/" || r.URL.Path == "/index.html" {
			http.ServeFile(w, r, tmpDir+"/index.html")
			return
		}
		for _, ext := range []string{".js", ".css", ".ico", ".png", ".svg"} {
			if len(r.URL.Path) > len(ext) && r.URL.Path[len(r.URL.Path)-len(ext):] == ext {
				staticFS.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, tmpDir+"/index.html")
	})

	ts := httptest.NewServer(mux)
	defer ts.Close()

	t.Run("root serves index.html", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		if !strings.Contains(string(buf[:n]), "test-index") {
			t.Fatal("root should serve index.html")
		}
	})

	t.Run("static JS served", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/app.js")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
	})

	t.Run("static CSS served", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/style.css")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
	})

	t.Run("SPA fallback for unknown paths", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/some-room-name")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		buf := make([]byte, 1024)
		n, _ := resp.Body.Read(buf)
		if !strings.Contains(string(buf[:n]), "test-index") {
			t.Fatal("unknown path should serve index.html")
		}
	})

	t.Run("room-info returns JSON", func(t *testing.T) {
		resp, err := http.Get(ts.URL + "/room-info")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		ct := resp.Header.Get("Content-Type")
		if !strings.Contains(ct, "application/json") {
			t.Fatalf("expected JSON content type, got %q", ct)
		}
	})
}
