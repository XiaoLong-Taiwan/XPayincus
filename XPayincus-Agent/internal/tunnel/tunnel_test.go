package tunnel

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/config"
	"github.com/gorilla/websocket"
)

func TestDestinationValidation(t *testing.T) {
	for _, path := range []string{"https://evil.test/1.0", "//evil.test/1.0", "/1.0/../config/", "/1.0/%2e%2e/config/", "/1.0\\evil", "/1.0#fragment", "/config/"} {
		if ValidatePath("incus", path, false) == nil {
			t.Fatalf("accepted %q", path)
		}
	}
	for _, path := range []string{"/1.0", "/1.0/instances/demo/state", "/1.0/operations/op/wait?timeout=10"} {
		if err := ValidatePath("incus", path, false); err != nil {
			t.Fatal(err)
		}
	}
	if ValidatePath("caddy", "/load", false) == nil || ValidatePath("anything", "/1.0", false) == nil {
		t.Fatal("accepted arbitrary target")
	}
	if ValidatePath("incus", "/1.0/operations/abc-123/websocket?secret=12345678", true) != nil {
		t.Fatal("valid websocket rejected")
	}
	for _, path := range []string{"/1.0/events", "/1.0/operations/a/websocket?secret=short", "/1.0/operations/a/websocket?secret=12345678&target=evil", "/1.0/operations/a/websocket?secret=12345678&secret=abcdefgh"} {
		if ValidatePath("incus", path, true) == nil {
			t.Fatalf("accepted websocket %q", path)
		}
	}
	for _, origin := range []string{"http://panel.test", "https://user:pass@panel.test", "https://panel.test/path", "https://panel.test?secret=x", "https://panel.test#x"} {
		if _, err := endpoint(config.Config{PanelURL: origin}); err == nil {
			t.Fatal("accepted unsafe panel origin")
		}
	}
	if value, err := endpoint(config.Config{PanelURL: "https://panel.test"}); err != nil || value != "wss://panel.test"+Path {
		t.Fatal(value, err)
	}
}

func TestExecuteLimitsRedirectAndCancellation(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		switch r.URL.Path {
		case "/1.0/redirect":
			http.Redirect(w, r, "http://evil.invalid/", http.StatusFound)
		case "/1.0/large":
			io.WriteString(w, strings.Repeat("x", MaxBody+1))
		default:
			if r.Header.Get("Authorization") != "" {
				t.Error("forwarded credentials")
			}
			body, _ := io.ReadAll(r.Body)
			w.WriteHeader(201)
			w.Write(body)
		}
	}))
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client.Transport = rewriteTransport{base: client.Transport, origin: server.URL}
	f := Frame{Type: "request", ID: "id", Target: "incus", Method: "POST", Path: "/1.0/instances", Timeout: 1000, Body: base64.StdEncoding.EncodeToString([]byte("payload")), Headers: map[string]string{"Content-Type": "application/json"}}
	result := Execute(context.Background(), f, client)
	if result.Error != "" || result.Status != 201 || result.Body != f.Body {
		t.Fatalf("unexpected response: %+v", result)
	}
	f.Headers["Authorization"] = "forbidden"
	if Execute(context.Background(), f, client).Error != "INVALID_HEADERS" {
		t.Fatal("accepted credential header")
	}
	delete(f.Headers, "Authorization")
	f.Body = base64.StdEncoding.EncodeToString(make([]byte, MaxBody+1))
	if Execute(context.Background(), f, client).Error != "BODY_LIMIT" {
		t.Fatal("accepted oversized body")
	}
	f.Body = ""
	f.Path = "/1.0/redirect"
	if result := Execute(context.Background(), f, client); result.Status != 302 {
		t.Fatal(result)
	}
	f.Path = "/1.0/large"
	if result := Execute(context.Background(), f, client); !strings.Contains(result.Error, "OUTCOME_UNKNOWN") {
		t.Fatal(result)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result := Execute(ctx, f, client); !strings.Contains(result.Error, "OUTCOME_UNKNOWN") {
		t.Fatal(result)
	}
	if requests.Load() != 3 {
		t.Fatal("request was replayed", requests.Load())
	}
}

type rewriteTransport struct {
	base   http.RoundTripper
	origin string
}

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	parsed, _ := http.NewRequest(req.Method, r.origin+req.URL.RequestURI(), nil)
	clone.URL = parsed.URL
	return r.base.RoundTrip(clone)
}

func TestConnectionCapacityRejectsStreamWithHTTPError(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	started := make(chan struct{}, MaxConcurrent)
	client := &http.Client{Transport: streamRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		started <- struct{}{}
		<-r.Context().Done()
		return nil, r.Context().Err()
	})}
	done := make(chan error, 1)
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			done <- err
			return
		}
		defer conn.Close()
		done <- serveConnection(ctx, conn, map[string]*http.Client{"incus": client})
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	for i := 0; i < MaxConcurrent; i++ {
		id := fmt.Sprintf("00000000-0000-0000-0000-%012d", i)
		if err := conn.WriteJSON(Frame{Type: "request", ID: id, Target: "incus", Method: "GET", Path: "/1.0", Timeout: 120000}); err != nil {
			t.Fatal(err)
		}
		select {
		case <-started:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	for i, kind := range []string{"http-open", "request", "ws-open"} {
		id := fmt.Sprintf("00000000-0000-0000-0001-%012d", i)
		if err := conn.WriteJSON(Frame{Type: kind, ID: id, Target: "incus", Method: "GET", Path: "/1.0"}); err != nil {
			t.Fatal(err)
		}
		var response Frame
		if err := conn.ReadJSON(&response); err != nil {
			t.Fatal(err)
		}
		wantType := "response"
		if kind == "http-open" {
			wantType = "http-error"
		}
		if response.Type != wantType || response.ID != id || response.Error != "CAPACITY" {
			t.Fatalf("unexpected capacity response: %+v", response)
		}
	}
	select {
	case <-started:
		t.Fatal("capacity-rejected request reached local transport")
	default:
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("connection did not stop after cancellation")
	}
}
