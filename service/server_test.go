package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// wsEndpoint creates an httptest.Server that upgrades to WebSocket and returns
// the server-side connection. The caller gets the client-side connection.
func wsEndpoint(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	var serverConn *websocket.Conn
	var wg sync.WaitGroup
	wg.Add(1)

	upgrader := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Fatalf("upgrade: %v", err)
		}
		serverConn = c
		wg.Done()
	}))
	t.Cleanup(srv.Close)

	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	clientConn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { clientConn.Close() })

	wg.Wait()
	t.Cleanup(func() { serverConn.Close() })
	return clientConn, serverConn
}

// readMsg reads a JSON message from a WebSocket connection with a timeout.
func readMsg(t *testing.T, conn *websocket.Conn) map[string]interface{} {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var msg map[string]interface{}
	if err := conn.ReadJSON(&msg); err != nil {
		t.Fatalf("readMsg: %v", err)
	}
	return msg
}

func TestNewServer(t *testing.T) {
	s := NewServer()
	if s == nil {
		t.Fatal("NewServer returned nil")
	}
	if len(s.rooms) != 0 {
		t.Fatalf("expected 0 rooms, got %d", len(s.rooms))
	}
}

func TestGeneratePeerID(t *testing.T) {
	seen := make(map[string]bool)
	for i := 0; i < 100; i++ {
		id := generatePeerID()
		if !strings.HasPrefix(id, "peer-") {
			t.Fatalf("expected peer- prefix, got %q", id)
		}
		// "peer-" (5) + 32 hex chars = 37
		if len(id) != 37 {
			t.Fatalf("expected length 37, got %d for %q", len(id), id)
		}
		if seen[id] {
			t.Fatalf("duplicate peer ID: %s", id)
		}
		seen[id] = true
	}
}

func TestGetOrCreateRoom(t *testing.T) {
	s := NewServer()

	r1 := s.getOrCreateRoom("room1")
	if r1 == nil {
		t.Fatal("room1 is nil")
	}

	r1Again := s.getOrCreateRoom("room1")
	if r1 != r1Again {
		t.Fatal("expected same room pointer for same name")
	}

	r2 := s.getOrCreateRoom("room2")
	if r1 == r2 {
		t.Fatal("expected different rooms for different names")
	}
}

func TestRemoveFromRoom(t *testing.T) {
	t.Run("removes peer and notifies others", func(t *testing.T) {
		s := NewServer()
		room := s.getOrCreateRoom("test")

		// Create 3 peers with real WS connections
		client1, server1 := wsEndpoint(t)
		client2, server2 := wsEndpoint(t)
		_, server3 := wsEndpoint(t)

		p1 := &Peer{ID: "p1", Conn: server1, Room: "test"}
		p2 := &Peer{ID: "p2", Conn: server2, Room: "test"}
		p3 := &Peer{ID: "p3", Conn: server3, Room: "test"}

		room.mu.Lock()
		room.peers["p1"] = p1
		room.peers["p2"] = p2
		room.peers["p3"] = p3
		room.mu.Unlock()

		s.removeFromRoom(p1)

		room.mu.RLock()
		_, exists := room.peers["p1"]
		remaining := len(room.peers)
		room.mu.RUnlock()

		if exists {
			t.Fatal("p1 should have been removed")
		}
		if remaining != 2 {
			t.Fatalf("expected 2 remaining, got %d", remaining)
		}

		// Both remaining peers should get peer-left
		msg2 := readMsg(t, client2)
		if msg2["type"] != "peer-left" || msg2["peerId"] != "p1" {
			t.Fatalf("unexpected msg for p2: %v", msg2)
		}
		_ = client1 // p1's client won't receive (it was removed)
	})

	t.Run("cleans up empty room", func(t *testing.T) {
		s := NewServer()
		room := s.getOrCreateRoom("cleanup")

		_, server := wsEndpoint(t)
		p := &Peer{ID: "solo", Conn: server, Room: "cleanup"}
		room.mu.Lock()
		room.peers["solo"] = p
		room.mu.Unlock()

		s.removeFromRoom(p)

		s.mu.RLock()
		_, exists := s.rooms["cleanup"]
		s.mu.RUnlock()
		if exists {
			t.Fatal("empty room should have been deleted")
		}
	})

	t.Run("no-op for nonexistent room", func(t *testing.T) {
		s := NewServer()
		p := &Peer{ID: "ghost", Room: "nonexistent"}
		s.removeFromRoom(p) // should not panic
	})
}

func TestSweepEmptyRooms(t *testing.T) {
	s := NewServer()

	// Room with a peer (should survive)
	occupied := s.getOrCreateRoom("occupied")
	occupied.mu.Lock()
	occupied.peers["p1"] = &Peer{ID: "p1"}
	occupied.mu.Unlock()

	// Empty room (should be swept)
	s.getOrCreateRoom("empty")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.sweepEmptyRooms(ctx, 10*time.Millisecond)
		close(done)
	}()

	// Wait for at least one sweep
	time.Sleep(50 * time.Millisecond)

	s.mu.RLock()
	_, emptyExists := s.rooms["empty"]
	_, occExists := s.rooms["occupied"]
	s.mu.RUnlock()

	if emptyExists {
		t.Fatal("empty room should have been swept")
	}
	if !occExists {
		t.Fatal("occupied room should still exist")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("sweepEmptyRooms did not stop after context cancel")
	}
}

func TestBroadcastAll(t *testing.T) {
	s := NewServer()

	// Two rooms, 2 peers each
	room1 := s.getOrCreateRoom("r1")
	room2 := s.getOrCreateRoom("r2")

	clients := make([]*websocket.Conn, 4)
	for i := 0; i < 4; i++ {
		client, server := wsEndpoint(t)
		clients[i] = client
		peerID := generatePeerID()
		p := &Peer{ID: peerID, Conn: server}
		if i < 2 {
			room1.mu.Lock()
			room1.peers[peerID] = p
			room1.mu.Unlock()
		} else {
			room2.mu.Lock()
			room2.peers[peerID] = p
			room2.mu.Unlock()
		}
	}

	testMsg := map[string]interface{}{"type": "test-broadcast", "data": "hello"}
	s.broadcastAll(testMsg)

	for i, client := range clients {
		msg := readMsg(t, client)
		if msg["type"] != "test-broadcast" {
			t.Fatalf("client %d: expected test-broadcast, got %v", i, msg["type"])
		}
		if msg["data"] != "hello" {
			t.Fatalf("client %d: expected hello, got %v", i, msg["data"])
		}
	}
}

func TestPeerSend(t *testing.T) {
	client, server := wsEndpoint(t)
	p := &Peer{ID: "test", Conn: server}

	testMsg := map[string]interface{}{"type": "test", "value": "ok"}
	if err := p.Send(testMsg); err != nil {
		t.Fatalf("Send failed: %v", err)
	}

	var received map[string]interface{}
	client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := client.ReadJSON(&received); err != nil {
		t.Fatalf("read failed: %v", err)
	}
	if received["type"] != "test" {
		t.Fatalf("expected type=test, got %v", received["type"])
	}
}

func TestPeerSendConcurrent(t *testing.T) {
	client, server := wsEndpoint(t)
	p := &Peer{ID: "test", Conn: server}

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			p.Send(map[string]interface{}{"n": n})
		}(i)
	}
	wg.Wait()

	// Read all 10 messages
	received := make(map[float64]bool)
	for i := 0; i < 10; i++ {
		var msg map[string]interface{}
		client.SetReadDeadline(time.Now().Add(2 * time.Second))
		if err := client.ReadJSON(&msg); err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		n, _ := msg["n"].(json.Number)
		nf, _ := n.Float64()
		// JSON numbers come as float64
		if v, ok := msg["n"].(float64); ok {
			nf = v
		}
		received[nf] = true
	}
	if len(received) != 10 {
		t.Fatalf("expected 10 unique messages, got %d", len(received))
	}
}
