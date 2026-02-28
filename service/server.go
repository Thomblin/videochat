package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

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
