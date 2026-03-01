package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

var allowedOrigin = os.Getenv("ALLOWED_ORIGIN")

var defaultICEServers = `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"stun:stun1.l.google.com:19302"}]`

func handleConfig(w http.ResponseWriter, r *http.Request) {
	iceServers := os.Getenv("ICE_SERVERS")
	if iceServers == "" {
		iceServers = defaultICEServers
	}
	// Validate it's valid JSON
	var parsed json.RawMessage
	if json.Unmarshal([]byte(iceServers), &parsed) != nil {
		iceServers = defaultICEServers
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"iceServers":` + iceServers + `}`))
}

// securityHeaders wraps an http.Handler to add standard security headers.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; media-src 'self' blob:; frame-ancestors 'none'")
		next.ServeHTTP(w, r)
	})
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}

	// Set NO_TLS=1 (or --no-tls env) when running behind a reverse proxy like
	// nginx that terminates TLS itself (e.g. with a certbot certificate).
	// Leave unset for direct local use — the server will use its own self-signed cert.
	noTLS := os.Getenv("NO_TLS") == "1"

	if roomPassword != "" {
		log.Printf("Room password protection enabled")
	}

	server := NewServer()

	// Start periodic room sweep
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go server.sweepEmptyRooms(ctx, 5*time.Minute)

	staticFS := http.FileServer(http.Dir("www/static"))

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
			http.ServeFile(w, r, "www/static/index.html")
			return
		}
		for _, ext := range []string{".js", ".css", ".ico", ".png", ".svg"} {
			if len(r.URL.Path) > len(ext) && r.URL.Path[len(r.URL.Path)-len(ext):] == ext {
				staticFS.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, "www/static/index.html")
	})

	handler := securityHeaders(mux)

	// Graceful shutdown
	shutdownCh := make(chan os.Signal, 1)
	signal.Notify(shutdownCh, syscall.SIGTERM, syscall.SIGINT)

	if noTLS {
		addr := "127.0.0.1:" + port
		srv := &http.Server{Addr: addr, Handler: handler}
		go func() {
			<-shutdownCh
			log.Println("Shutting down...")
			server.broadcastAll(map[string]interface{}{"type": "server-shutdown"})
			time.Sleep(500 * time.Millisecond)
			cancel()
			srv.Shutdown(context.Background())
		}()
		log.Printf("Video chat server running on http://%s (plain HTTP, TLS handled by proxy)", addr)
		if err := srv.ListenAndServe(); err != http.ErrServerClosed {
			log.Fatal(err)
		}
		return
	}

	cert, err := getOrCreateCert()
	if err != nil {
		log.Fatalf("Failed to generate TLS cert: %v", err)
	}

	tlsConfig := &tls.Config{Certificates: []tls.Certificate{cert}}
	ln, err := tls.Listen("tcp", ":"+port, tlsConfig)
	if err != nil {
		log.Fatalf("Failed to listen: %v", err)
	}

	srv := &http.Server{Handler: handler}
	go func() {
		<-shutdownCh
		log.Println("Shutting down...")
		server.broadcastAll(map[string]interface{}{"type": "server-shutdown"})
		time.Sleep(500 * time.Millisecond)
		cancel()
		srv.Shutdown(context.Background())
	}()

	log.Printf("Video chat server running on https://localhost:%s", port)
	log.Printf("On your LAN, open https://<your-pc-ip>:%s (accept the certificate warning)", port)
	if err := srv.Serve(ln); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
