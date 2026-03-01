package main

import (
	"encoding/json"
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
	if !strings.Contains(csp, "script-src 'self'") {
		t.Errorf("CSP missing script-src: %q", csp)
	}
	if strings.Contains(csp, "'unsafe-inline'") && strings.Contains(csp, "script-src") {
		// Check that script-src does NOT have unsafe-inline
		// style-src may still have it
		parts := strings.Split(csp, ";")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if strings.HasPrefix(p, "script-src") && strings.Contains(p, "'unsafe-inline'") {
				t.Errorf("script-src should not contain 'unsafe-inline': %q", csp)
			}
		}
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
		if r.URL.Path == "/config" {
			handleConfig(w, r)
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

func TestConfigEndpoint(t *testing.T) {
	t.Run("returns default ICE servers when env unset", func(t *testing.T) {
		orig := os.Getenv("ICE_SERVERS")
		os.Unsetenv("ICE_SERVERS")
		defer os.Setenv("ICE_SERVERS", orig)

		req := httptest.NewRequest("GET", "/config", nil)
		rec := httptest.NewRecorder()
		handleConfig(rec, req)

		if rec.Code != 200 {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		var result map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatalf("invalid JSON: %v", err)
		}
		if _, ok := result["iceServers"]; !ok {
			t.Fatal("response missing iceServers field")
		}
		var servers []map[string]interface{}
		json.Unmarshal(result["iceServers"], &servers)
		if len(servers) != 2 {
			t.Fatalf("expected 2 default servers, got %d", len(servers))
		}
	})

	t.Run("returns custom ICE servers from env", func(t *testing.T) {
		orig := os.Getenv("ICE_SERVERS")
		os.Setenv("ICE_SERVERS", `[{"urls":"turn:example.com:3478","username":"u","credential":"p"}]`)
		defer os.Setenv("ICE_SERVERS", orig)

		req := httptest.NewRequest("GET", "/config", nil)
		rec := httptest.NewRecorder()
		handleConfig(rec, req)

		var result map[string]json.RawMessage
		json.Unmarshal(rec.Body.Bytes(), &result)
		var servers []map[string]interface{}
		json.Unmarshal(result["iceServers"], &servers)
		if len(servers) != 1 {
			t.Fatalf("expected 1 server, got %d", len(servers))
		}
		if servers[0]["urls"] != "turn:example.com:3478" {
			t.Fatalf("unexpected server URL: %v", servers[0]["urls"])
		}
	})

	t.Run("falls back to default on invalid JSON", func(t *testing.T) {
		orig := os.Getenv("ICE_SERVERS")
		os.Setenv("ICE_SERVERS", "not valid json")
		defer os.Setenv("ICE_SERVERS", orig)

		req := httptest.NewRequest("GET", "/config", nil)
		rec := httptest.NewRecorder()
		handleConfig(rec, req)

		var result map[string]json.RawMessage
		json.Unmarshal(rec.Body.Bytes(), &result)
		var servers []map[string]interface{}
		json.Unmarshal(result["iceServers"], &servers)
		if len(servers) != 2 {
			t.Fatalf("expected 2 default servers on invalid JSON, got %d", len(servers))
		}
	})
}
