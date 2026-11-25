package panel

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/config"
	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/protocol"
)

func TestHostRealtimeMonitoring(t *testing.T) {
	for _, status := range []int{http.StatusNoContent, http.StatusTemporaryRedirect, http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			const path = "/api/agent/monitoring/host-realtime"
			const expectedBody = `{"ramPercent":0,"sampledAt":"2026-11-25T06:00:00Z"}`
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path == "/redirected" {
					w.WriteHeader(http.StatusNoContent)
					return
				}
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != expectedBody || r.Method != http.MethodPost || r.URL.Path != path {
					t.Errorf("unexpected request: %s %s %s (%v)", r.Method, r.URL.Path, body, err)
				}
				timestamp, nonce := r.Header.Get("x-incudal-timestamp"), r.Header.Get("x-incudal-nonce")
				hash := protocol.BodySHA256(body)
				want := protocol.Signature("test-secret", protocol.SigningPayload(http.MethodPost, path, timestamp, nonce, hash))
				if timestamp == "" || nonce == "" || r.Header.Get("x-incudal-agent-id") != "test-agent" || r.Header.Get("x-incudal-body-sha256") != hash || r.Header.Get("x-incudal-signature") != want {
					t.Error("missing or invalid signed request headers")
				}
				if status == http.StatusTemporaryRedirect {
					w.Header().Set("Location", "/redirected")
				}
				w.WriteHeader(status)
			}))
			defer server.Close()
			client := New(config.Config{PanelURL: server.URL, AgentID: "test-agent", AgentSecret: "test-secret"})
			err := client.HostRealtimeMonitoring(context.Background(), map[string]any{"sampledAt": "2026-11-25T06:00:00Z", "ramPercent": 0.0})
			wantUnsupported := status == 404 || status == 405 || status == 501
			if (err == nil) != (status == 204) || errors.Is(err, ErrHostRealtimeUnsupported) != wantUnsupported || calls.Load() != 1 {
				t.Fatalf("status %d: err=%v calls=%d", status, err, calls.Load())
			}
		})
	}
}
