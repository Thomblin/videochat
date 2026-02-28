package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/gorilla/websocket"
)

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
