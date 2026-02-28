package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// setupTestServer creates a Server with the same mux as main() and returns
// the httptest.Server. It saves/restores the roomPassword global.
func setupTestServer(t *testing.T, password string) (*Server, *httptest.Server) {
	t.Helper()

	origPassword := roomPassword
	origOrigin := allowedOrigin
	t.Cleanup(func() {
		roomPassword = origPassword
		allowedOrigin = origOrigin
	})
	roomPassword = password
	allowedOrigin = ""

	server := NewServer()

	// Create a temp static dir with a minimal index.html
	tmpDir := t.TempDir()
	writeFile(t, tmpDir+"/index.html", "<html><body>test</body></html>")

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
	t.Cleanup(ts.Close)
	return server, ts
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

// dialWS connects to the test server's /ws endpoint.
func dialWS(t *testing.T, ts *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?" + query
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// dialWSExpectFail connects expecting an HTTP error.
func dialWSExpectFail(t *testing.T, ts *httptest.Server, query string) int {
	t.Helper()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?" + query
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil {
		t.Fatal("expected dial to fail")
	}
	if resp == nil {
		t.Fatalf("expected HTTP response, got nil (err: %v)", err)
	}
	return resp.StatusCode
}

// --- Validation tests ---

func TestValidRoomName(t *testing.T) {
	tests := []struct {
		name  string
		valid bool
	}{
		{"abc", true},
		{"room-1", true},
		{"test_room", true},
		{"ABC123", true},
		{"a", true},
		{"room name", false},
		{"room/bad", false},
		{"<script>", false},
		{"", false},
		{strings.Repeat("a", 65), false}, // too long (checked in handleWS, not regex)
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			match := validRoomName.MatchString(tt.name)
			if tt.name == "" || len(tt.name) > 64 {
				// These are caught by length check + regex (empty fails regex too)
				if match && len(tt.name) <= 64 {
					t.Errorf("expected invalid for %q", tt.name)
				}
			} else if match != tt.valid {
				t.Errorf("validRoomName(%q) = %v, want %v", tt.name, match, tt.valid)
			}
		})
	}
}

func TestHandleWS_InvalidRoom(t *testing.T) {
	_, ts := setupTestServer(t, "")

	code := dialWSExpectFail(t, ts, "room=bad+room")
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", code)
	}

	code = dialWSExpectFail(t, ts, "room="+strings.Repeat("x", 65))
	if code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", code)
	}
}

func TestHandleWS_PasswordProtection(t *testing.T) {
	_, ts := setupTestServer(t, "secret")

	t.Run("rejected without password", func(t *testing.T) {
		code := dialWSExpectFail(t, ts, "room=pwtest1")
		if code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", code)
		}
	})

	t.Run("rejected with wrong password", func(t *testing.T) {
		code := dialWSExpectFail(t, ts, "room=pwtest2&password=wrong")
		if code != http.StatusUnauthorized {
			t.Fatalf("expected 401, got %d", code)
		}
	})

	t.Run("accepted with correct password", func(t *testing.T) {
		conn := dialWS(t, ts, "room=pwtest3&password=secret")
		msg := readMsg(t, conn)
		if msg["type"] != "welcome" {
			t.Fatalf("expected welcome, got %v", msg["type"])
		}
	})

	t.Run("no password needed for occupied room", func(t *testing.T) {
		// First peer creates the room with password
		conn1 := dialWS(t, ts, "room=pwtest4&password=secret")
		msg1 := readMsg(t, conn1)
		if msg1["type"] != "welcome" {
			t.Fatalf("expected welcome, got %v", msg1["type"])
		}

		// Second peer joins without password
		conn2 := dialWS(t, ts, "room=pwtest4")
		msg2 := readMsg(t, conn2)
		if msg2["type"] != "welcome" {
			t.Fatalf("expected welcome, got %v", msg2["type"])
		}
	})
}

// --- Feature integration tests ---

func TestHandleWS_JoinAndWelcome(t *testing.T) {
	_, ts := setupTestServer(t, "")

	// First peer joins
	conn1 := dialWS(t, ts, "room=jointest")
	msg1 := readMsg(t, conn1)
	if msg1["type"] != "welcome" {
		t.Fatalf("expected welcome, got %v", msg1)
	}
	peer1ID, _ := msg1["yourId"].(string)
	if !strings.HasPrefix(peer1ID, "peer-") {
		t.Fatalf("expected peer- prefix, got %q", peer1ID)
	}
	peers1, _ := msg1["peers"].([]interface{})
	if len(peers1) != 0 {
		t.Fatalf("first peer should see empty peers list, got %v", peers1)
	}

	// Second peer joins same room
	conn2 := dialWS(t, ts, "room=jointest")
	msg2 := readMsg(t, conn2)
	if msg2["type"] != "welcome" {
		t.Fatalf("expected welcome, got %v", msg2)
	}
	peer2ID, _ := msg2["yourId"].(string)
	peers2, _ := msg2["peers"].([]interface{})
	if len(peers2) != 1 || peers2[0] != peer1ID {
		t.Fatalf("second peer should see [%s], got %v", peer1ID, peers2)
	}

	// First peer should receive peer-joined
	joinMsg := readMsg(t, conn1)
	if joinMsg["type"] != "peer-joined" || joinMsg["peerId"] != peer2ID {
		t.Fatalf("expected peer-joined for %s, got %v", peer2ID, joinMsg)
	}
}

func TestHandleWS_SignalingRelay(t *testing.T) {
	_, ts := setupTestServer(t, "")

	conn1 := dialWS(t, ts, "room=signal")
	msg1 := readMsg(t, conn1)
	peer1ID, _ := msg1["yourId"].(string)

	conn2 := dialWS(t, ts, "room=signal")
	msg2 := readMsg(t, conn2)
	peer2ID, _ := msg2["yourId"].(string)

	// Drain peer-joined notification on conn1
	readMsg(t, conn1)

	// Peer 1 sends offer to Peer 2
	offer := map[string]interface{}{
		"type":     "offer",
		"targetId": peer2ID,
		"sdp":      "test-sdp-data",
	}
	conn1.WriteJSON(offer)

	// Peer 2 should receive the offer with peerId stamped
	received := readMsg(t, conn2)
	if received["type"] != "offer" {
		t.Fatalf("expected offer, got %v", received["type"])
	}
	if received["peerId"] != peer1ID {
		t.Fatalf("expected peerId=%s, got %v", peer1ID, received["peerId"])
	}
	if received["sdp"] != "test-sdp-data" {
		t.Fatalf("expected sdp=test-sdp-data, got %v", received["sdp"])
	}
	if _, exists := received["targetId"]; exists {
		t.Fatal("targetId should have been removed")
	}

	// Peer 2 sends answer back
	answer := map[string]interface{}{
		"type":     "answer",
		"targetId": peer1ID,
		"sdp":      "answer-sdp",
	}
	conn2.WriteJSON(answer)

	answerMsg := readMsg(t, conn1)
	if answerMsg["type"] != "answer" || answerMsg["peerId"] != peer2ID {
		t.Fatalf("expected answer from %s, got %v", peer2ID, answerMsg)
	}

	// ICE candidate relay
	ice := map[string]interface{}{
		"type":     "ice",
		"targetId": peer2ID,
		"ice":      map[string]interface{}{"candidate": "test-ice"},
	}
	conn1.WriteJSON(ice)

	iceMsg := readMsg(t, conn2)
	if iceMsg["type"] != "ice" || iceMsg["peerId"] != peer1ID {
		t.Fatalf("expected ice from %s, got %v", peer1ID, iceMsg)
	}
}

func TestHandleWS_ChatRelay(t *testing.T) {
	_, ts := setupTestServer(t, "")

	conn1 := dialWS(t, ts, "room=chat")
	msg1 := readMsg(t, conn1)
	peer1ID, _ := msg1["yourId"].(string)

	conn2 := dialWS(t, ts, "room=chat")
	msg2 := readMsg(t, conn2)
	peer2ID, _ := msg2["yourId"].(string)

	// Drain peer-joined on conn1
	readMsg(t, conn1)

	// Peer 1 sends chat message to Peer 2
	chatMsg := map[string]interface{}{
		"type":     "chat",
		"targetId": peer2ID,
		"text":     "Hello, world!",
	}
	conn1.WriteJSON(chatMsg)

	received := readMsg(t, conn2)
	if received["type"] != "chat" {
		t.Fatalf("expected chat, got %v", received["type"])
	}
	if received["peerId"] != peer1ID {
		t.Fatalf("expected peerId=%s, got %v", peer1ID, received["peerId"])
	}
	if received["text"] != "Hello, world!" {
		t.Fatalf("expected text='Hello, world!', got %v", received["text"])
	}
	if _, exists := received["targetId"]; exists {
		t.Fatal("targetId should have been removed")
	}
}

func TestHandleWS_ScreenShareSignaling(t *testing.T) {
	_, ts := setupTestServer(t, "")

	conn1 := dialWS(t, ts, "room=screen")
	msg1 := readMsg(t, conn1)
	peer1ID, _ := msg1["yourId"].(string)

	conn2 := dialWS(t, ts, "room=screen")
	msg2 := readMsg(t, conn2)
	peer2ID, _ := msg2["yourId"].(string)

	// Drain peer-joined on conn1
	readMsg(t, conn1)

	// Peer 1 starts screen sharing — signal sent to Peer 2
	conn1.WriteJSON(map[string]interface{}{
		"type":     "screen-share-start",
		"targetId": peer2ID,
	})

	startMsg := readMsg(t, conn2)
	if startMsg["type"] != "screen-share-start" {
		t.Fatalf("expected screen-share-start, got %v", startMsg["type"])
	}
	if startMsg["peerId"] != peer1ID {
		t.Fatalf("expected peerId=%s, got %v", peer1ID, startMsg["peerId"])
	}

	// Peer 1 stops screen sharing
	conn1.WriteJSON(map[string]interface{}{
		"type":     "screen-share-stop",
		"targetId": peer2ID,
	})

	stopMsg := readMsg(t, conn2)
	if stopMsg["type"] != "screen-share-stop" {
		t.Fatalf("expected screen-share-stop, got %v", stopMsg["type"])
	}
	if stopMsg["peerId"] != peer1ID {
		t.Fatalf("expected peerId=%s, got %v", peer1ID, stopMsg["peerId"])
	}
}

func TestHandleWS_PeerLeft(t *testing.T) {
	_, ts := setupTestServer(t, "")

	conn1 := dialWS(t, ts, "room=leave")
	readMsg(t, conn1) // welcome

	conn2 := dialWS(t, ts, "room=leave")
	msg2 := readMsg(t, conn2)
	peer2ID, _ := msg2["yourId"].(string)

	// Drain peer-joined on conn1
	readMsg(t, conn1)

	// Close conn2
	conn2.Close()

	// conn1 should receive peer-left
	leftMsg := readMsg(t, conn1)
	if leftMsg["type"] != "peer-left" || leftMsg["peerId"] != peer2ID {
		t.Fatalf("expected peer-left for %s, got %v", peer2ID, leftMsg)
	}
}

func TestHandleWS_RateLimit(t *testing.T) {
	_, ts := setupTestServer(t, "")

	conn1 := dialWS(t, ts, "room=ratelimit")
	msg1 := readMsg(t, conn1)
	peer1ID, _ := msg1["yourId"].(string)

	conn2 := dialWS(t, ts, "room=ratelimit")
	msg2 := readMsg(t, conn2)
	peer2ID, _ := msg2["yourId"].(string)
	_ = peer1ID

	// Drain peer-joined on conn1
	readMsg(t, conn1)

	// Send 201 messages rapidly (limit is 200)
	for i := 0; i < 201; i++ {
		err := conn1.WriteJSON(map[string]interface{}{
			"type":     "offer",
			"targetId": peer2ID,
			"n":        i,
		})
		if err != nil {
			break // connection already closed
		}
	}

	// conn1 should be disconnected — reading should fail
	conn1.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err := conn1.ReadMessage()
	if err == nil {
		t.Fatal("expected connection to be closed after rate limit")
	}
}

func TestHandleRoomInfo(t *testing.T) {
	t.Run("no password configured", func(t *testing.T) {
		_, ts := setupTestServer(t, "")
		resp, err := http.Get(ts.URL + "/room-info?room=test")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()

		var info map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&info)
		if info["needsPassword"] != false {
			t.Fatalf("expected needsPassword=false, got %v", info["needsPassword"])
		}
	})

	t.Run("password configured, empty room", func(t *testing.T) {
		_, ts := setupTestServer(t, "secret")
		resp, err := http.Get(ts.URL + "/room-info?room=newroom")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()

		var info map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&info)
		if info["needsPassword"] != true {
			t.Fatalf("expected needsPassword=true, got %v", info["needsPassword"])
		}
	})

	t.Run("password configured, occupied room", func(t *testing.T) {
		_, ts := setupTestServer(t, "secret")

		// Join a peer first
		conn := dialWS(t, ts, "room=occupied&password=secret")
		readMsg(t, conn) // welcome

		resp, err := http.Get(ts.URL + "/room-info?room=occupied")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()

		var info map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&info)
		if info["needsPassword"] != false {
			t.Fatalf("expected needsPassword=false, got %v", info["needsPassword"])
		}
	})

	t.Run("default room name", func(t *testing.T) {
		_, ts := setupTestServer(t, "")
		resp, err := http.Get(ts.URL + "/room-info")
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			t.Fatalf("expected 200, got %d", resp.StatusCode)
		}
		var info map[string]interface{}
		json.NewDecoder(resp.Body).Decode(&info)
		if _, ok := info["needsPassword"]; !ok {
			t.Fatal("response should contain needsPassword field")
		}
	})
}
