package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

var allowedOrigin = os.Getenv("ALLOWED_ORIGIN")

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		if allowedOrigin == "" {
			return true
		}
		return r.Header.Get("Origin") == allowedOrigin
	},
}

var roomPassword = os.Getenv("ROOM_PASSWORD")

var validRoomName = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

type Peer struct {
	ID   string
	Conn *websocket.Conn
	Room string
	mu   sync.Mutex
}

func (p *Peer) Send(msg interface{}) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Conn.WriteJSON(msg)
}

type Room struct {
	peers map[string]*Peer
	mu    sync.RWMutex
}

type Server struct {
	rooms map[string]*Room
	mu    sync.RWMutex
}

func NewServer() *Server {
	return &Server{rooms: make(map[string]*Room)}
}

func (s *Server) getOrCreateRoom(name string) *Room {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rooms[name]; ok {
		return r
	}
	r := &Room{peers: make(map[string]*Peer)}
	s.rooms[name] = r
	return r
}

func (s *Server) removeFromRoom(p *Peer) {
	s.mu.RLock()
	room, ok := s.rooms[p.Room]
	s.mu.RUnlock()
	if !ok {
		return
	}

	room.mu.Lock()
	delete(room.peers, p.ID)
	remaining := len(room.peers)
	peers := make([]*Peer, 0, len(room.peers))
	for _, peer := range room.peers {
		peers = append(peers, peer)
	}
	room.mu.Unlock()

	// Notify others that this peer left
	msg := map[string]interface{}{"type": "peer-left", "peerId": p.ID}
	for _, peer := range peers {
		peer.Send(msg)
	}

	// Clean up empty rooms
	if remaining == 0 {
		s.mu.Lock()
		delete(s.rooms, p.Room)
		s.mu.Unlock()
	}
}

// sweepEmptyRooms periodically removes rooms with zero peers.
func (s *Server) sweepEmptyRooms(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			for name, room := range s.rooms {
				room.mu.RLock()
				empty := len(room.peers) == 0
				room.mu.RUnlock()
				if empty {
					delete(s.rooms, name)
					log.Printf("Swept empty room: %s", name)
				}
			}
			s.mu.Unlock()
		}
	}
}

// broadcastAll sends a message to every connected peer across all rooms.
func (s *Server) broadcastAll(msg interface{}) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, room := range s.rooms {
		room.mu.RLock()
		for _, peer := range room.peers {
			peer.Send(msg)
		}
		room.mu.RUnlock()
	}
}

func generatePeerID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return "peer-" + hex.EncodeToString(b)
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		roomName = "default"
	}

	// Validate room name
	if len(roomName) > 64 || !validRoomName.MatchString(roomName) {
		http.Error(w, "invalid room name", http.StatusBadRequest)
		return
	}

	// Check password only when creating a new room (no peers yet)
	if roomPassword != "" {
		s.mu.RLock()
		room, exists := s.rooms[roomName]
		var occupied bool
		if exists {
			room.mu.RLock()
			occupied = len(room.peers) > 0
			room.mu.RUnlock()
		}
		s.mu.RUnlock()

		if !occupied {
			if r.URL.Query().Get("password") != roomPassword {
				http.Error(w, "invalid password", http.StatusUnauthorized)
				return
			}
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	peerID := generatePeerID()

	peer := &Peer{ID: peerID, Conn: conn, Room: roomName}
	room := s.getOrCreateRoom(roomName)

	// Get existing peers before adding new one
	room.mu.Lock()
	existingPeers := make([]string, 0, len(room.peers))
	existingPeerList := make([]*Peer, 0, len(room.peers))
	for id, p := range room.peers {
		existingPeers = append(existingPeers, id)
		existingPeerList = append(existingPeerList, p)
	}
	room.peers[peerID] = peer
	room.mu.Unlock()

	log.Printf("[%s] %s joined (%d peers now)", roomName, peerID, len(existingPeers)+1)

	// Tell the new peer their ID and who else is in the room
	peer.Send(map[string]interface{}{
		"type":   "welcome",
		"yourId": peerID,
		"peers":  existingPeers,
	})

	// Tell existing peers about the new peer
	joinMsg := map[string]interface{}{"type": "peer-joined", "peerId": peerID}
	for _, p := range existingPeerList {
		p.Send(joinMsg)
	}

	defer func() {
		conn.Close()
		s.removeFromRoom(peer)
		log.Printf("[%s] %s left", roomName, peerID)
	}()

	// Rate limiting: allow bursts up to 200 messages per second
	const rateLimit = 200
	msgCount := 0
	rateTicker := time.NewTicker(time.Second)
	defer rateTicker.Stop()

	// Relay signaling messages
	for {
		// Reset counter each second
		select {
		case <-rateTicker.C:
			msgCount = 0
		default:
		}

		var msg map[string]json.RawMessage
		if err := conn.ReadJSON(&msg); err != nil {
			break
		}

		msgCount++
		if msgCount > rateLimit {
			log.Printf("[%s] %s exceeded rate limit, disconnecting", roomName, peerID)
			break
		}

		targetIDBytes, ok := msg["targetId"]
		if !ok {
			continue
		}
		var targetID string
		if err := json.Unmarshal(targetIDBytes, &targetID); err != nil {
			continue
		}

		room.mu.RLock()
		target, ok := room.peers[targetID]
		room.mu.RUnlock()

		if !ok {
			continue
		}

		// Forward the whole message, overwriting peerId with sender's ID
		b, _ := json.Marshal(peerID)
		msg["peerId"] = json.RawMessage(b)
		delete(msg, "targetId")
		target.Send(msg)
	}
}

// handleRoomInfo returns whether a room needs a password to join.
func (s *Server) handleRoomInfo(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		roomName = "default"
	}

	needsPassword := false
	if roomPassword != "" {
		s.mu.RLock()
		room, exists := s.rooms[roomName]
		var occupied bool
		if exists {
			room.mu.RLock()
			occupied = len(room.peers) > 0
			room.mu.RUnlock()
		}
		s.mu.RUnlock()
		needsPassword = !occupied
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"needsPassword": needsPassword,
	})
}

const certFile = "cert.pem"
const keyFile = "key.pem"

// getOrCreateCert loads the TLS cert/key from disk, generating them if they
// don't exist yet. This means the browser only needs to accept the cert once.
func getOrCreateCert() (tls.Certificate, error) {
	// If both files exist, load and return them directly.
	if _, err := os.Stat(certFile); err == nil {
		if _, err := os.Stat(keyFile); err == nil {
			cert, err := tls.LoadX509KeyPair(certFile, keyFile)
			if err == nil {
				log.Printf("Loaded TLS cert from %s / %s", certFile, keyFile)
				return cert, nil
			}
			log.Printf("Failed to load existing cert, regenerating: %v", err)
		}
	}

	// Generate a new cert and persist it.
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}

	// Random serial number per RFC 5280
	serialBytes := make([]byte, 16)
	rand.Read(serialBytes)
	serial := new(big.Int).SetBytes(serialBytes)

	template := x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "videochat"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(2 * 365 * 24 * time.Hour), // 2 years
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
		DNSNames:     []string{"localhost"},
	}

	// Include all current local IPs so the cert is valid for LAN access.
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			if ipnet, ok := addr.(*net.IPNet); ok {
				if ip4 := ipnet.IP.To4(); ip4 != nil {
					template.IPAddresses = append(template.IPAddresses, ip4)
				}
			}
		}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}

	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})

	if err := os.WriteFile(certFile, certPEM, 0600); err != nil {
		log.Printf("Warning: could not save cert: %v", err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0600); err != nil {
		log.Printf("Warning: could not save key: %v", err)
	}
	log.Printf("Generated new TLS cert, saved to %s / %s", certFile, keyFile)

	return tls.X509KeyPair(certPEM, keyPEM)
}

// securityHeaders wraps an http.Handler to add standard security headers.
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' wss: ws:; media-src 'self' blob:; frame-ancestors 'none'")
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

	staticFS := http.FileServer(http.Dir("static"))

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
			http.ServeFile(w, r, "static/index.html")
			return
		}
		for _, ext := range []string{".js", ".css", ".ico", ".png", ".svg"} {
			if len(r.URL.Path) > len(ext) && r.URL.Path[len(r.URL.Path)-len(ext):] == ext {
				staticFS.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, "static/index.html")
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
