package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

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

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	roomName := r.URL.Query().Get("room")
	if roomName == "" {
		roomName = "default"
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}

	peerID := fmt.Sprintf("%d", r.Context().Value(http.LocalAddrContextKey))
	// Use a simpler unique ID
	peerID = fmt.Sprintf("peer-%p", conn)

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

	// Relay signaling messages
	for {
		var msg map[string]json.RawMessage
		if err := conn.ReadJSON(&msg); err != nil {
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
		msg["peerId"] = json.RawMessage(`"` + peerID + `"`)
		delete(msg, "targetId")
		target.Send(msg)
	}
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

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "videochat"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(10 * 365 * 24 * time.Hour), // 10 years
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

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8083"
	}

	// Set NO_TLS=1 (or --no-tls env) when running behind a reverse proxy like
	// nginx that terminates TLS itself (e.g. with a certbot certificate).
	// Leave unset for direct local use — the server will use its own self-signed cert.
	noTLS := os.Getenv("NO_TLS") == "1"

	server := NewServer()

	staticFS := http.FileServer(http.Dir("static"))

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			server.handleWS(w, r)
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

	if noTLS {
		addr := "127.0.0.1:" + port
		log.Printf("Video chat server running on http://%s (plain HTTP, TLS handled by proxy)", addr)
		log.Fatal(http.ListenAndServe(addr, nil))
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

	log.Printf("Video chat server running on https://localhost:%s", port)
	log.Printf("On your LAN, open https://<your-pc-ip>:%s (accept the certificate warning)", port)
	log.Fatal(http.Serve(ln, nil))
}
