package panel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/config"
)

func TestRetryablePanelFailuresAndTimeouts(t *testing.T) {
	for _, test := range []struct {
		name          string
		status        int
		wantAttempts  int32
		wantRetryable bool
	}{
		{name: "bad request is not retried", status: http.StatusBadRequest, wantAttempts: 1},
		{name: "bad gateway is retried", status: http.StatusBadGateway, wantAttempts: 3, wantRetryable: true},
		{name: "cloudflare 530 is retried", status: 530, wantAttempts: 3, wantRetryable: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var attempts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				attempts.Add(1)
				writer.WriteHeader(test.status)
			}))
			defer server.Close()
			client := New(config.Config{StateDir: t.TempDir(), PanelURL: server.URL, AgentID: "fixture", AgentSecret: "fixture", RequestTimeout: time.Second})
			_, err := client.Heartbeat(context.Background(), map[string]any{})
			if err == nil || attempts.Load() != test.wantAttempts || isRetryableStatus(test.status) != test.wantRetryable {
				t.Fatalf("unexpected retry behavior: err=%v attempts=%d retryable=%t", err, attempts.Load(), isRetryableStatus(test.status))
			}
		})
	}
	t.Run("timeout retries", func(t *testing.T) {
			var attempts atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				attempts.Add(1)
				time.Sleep(100 * time.Millisecond)
			}))
			defer server.Close()
			client := New(config.Config{StateDir: t.TempDir(), PanelURL: server.URL, AgentID: "fixture", AgentSecret: "fixture", RequestTimeout: 20 * time.Millisecond})
			if _, err := client.Heartbeat(context.Background(), map[string]any{}); err == nil || attempts.Load() != 3 {
				t.Fatalf("timeout attempts mismatch: err=%v attempts=%d", err, attempts.Load())
			}
		})
}

func TestMonitoringSpoolRestartSemanticDiffAndBillingIsolation(t *testing.T) {
	directory := t.TempDir()
	client := &Client{spoolDir: directory, spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	base := time.Now().UTC()
	payload := func(at string, loaded bool) map[string]any {
		return map[string]any{
			"instances":  map[string]any{"items": []any{map[string]any{"name": "vm1", "sampledAt": at, "performance": map[string]any{"cpuUsagePercent": 5}, "traffic": map[string]any{"rxBytes": "999"}}}},
			"components": map[string]any{"zfs": map[string]any{"available": true, "observedAt": at, "status": map[string]any{"collectedAt": at, "moduleLoaded": loaded}}},
		}
	}
	formatAt := func(offset time.Duration) string { return base.Add(offset).Format(time.RFC3339Nano) }
	first, err := client.queueMonitoring(payload(formatAt(0), true))
	if err != nil || len(first) != 2 {
		t.Fatalf("first queue: %v %#v", err, first)
	}
	restarted := &Client{spoolDir: directory, spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	second, err := restarted.queueMonitoring(payload(formatAt(30*time.Second), true))
	if err != nil || len(second) != 3 || second[0]["id"] != first[0]["id"] {
		t.Fatalf("restart lost sample: %v %#v", err, second)
	}
	if _, exists := second[2]["events"]; exists {
		t.Fatal("timestamps generated semantic event")
	}
	third, err := restarted.queueMonitoring(payload(formatAt(time.Minute), false))
	if err != nil || len(third) != 5 || len(third[3]["events"].([]any)) != 1 {
		t.Fatal("semantic change not queued")
	}
	restarted = &Client{spoolDir: directory, spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	fourth, err := restarted.queueMonitoring(payload(formatAt(90*time.Second), true))
	if err != nil || len(fourth) != 7 {
		t.Fatalf("offline A-B-A lost: %v %#v", err, fourth)
	}
	for _, index := range []int{0, 3, 5} {
		if len(fourth[index]["events"].([]any)) != 1 {
			t.Fatal("transition lost across restart")
		}
		if _, exists := fourth[index]["instances"]; exists {
			t.Fatal("event contains metrics sample")
		}
	}
	if fourth[1]["instances"].([]any)[0].(map[string]any)["sampledAt"] != formatAt(0) {
		t.Fatal("instance timestamp replaced by heartbeat")
	}
	encoded, _ := json.Marshal(third)
	if strings.Contains(string(encoded), "rxBytes") || strings.Contains(string(encoded), "traffic") {
		t.Fatal("monitoring replay contains billing counters")
	}
	for _, path := range restarted.pendingSamples {
		if filepath.Dir(path) != directory {
			t.Fatal("ACK escaped spool")
		}
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMonitoringPayloadIncludesNetworkCountersAndRates(t *testing.T) {
	client := &Client{spoolDir: t.TempDir(), spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	sampledAt := time.Now().UTC().Format(time.RFC3339Nano)
	payload := map[string]any{
		"instances": map[string]any{"items": []any{map[string]any{
			"name": "vm1", "sampledAt": sampledAt,
			"performance": map[string]any{"intervalSeconds": 60, "rxBytes": uint64(1000), "txBytes": uint64(2000), "rxBytesPerSecond": 10.5, "txBytesPerSecond": 20.5},
		}}},
	}
	samples, err := client.queueMonitoring(payload)
	if err != nil {
		t.Fatal(err)
	}
	instances := samples[len(samples)-1]["instances"].([]any)
	metrics := instances[0].(map[string]any)["metrics"].(map[string]any)
	for key, expected := range map[string]any{"rxBytes": float64(1000), "txBytes": float64(2000), "rxBytesPerSecond": 10.5, "txBytesPerSecond": 20.5} {
		if metrics[key] != expected {
			t.Fatalf("network metric %s mismatch: got=%#v want=%#v", key, metrics[key], expected)
		}
	}
}

func TestMonitoringPayloadKeepsInstancesWithoutPerformanceData(t *testing.T) {
	client := &Client{spoolDir: t.TempDir(), spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	sampledAt := time.Now().UTC().Format(time.RFC3339Nano)
	samples, err := client.queueMonitoring(map[string]any{
		"instances": map[string]any{"items": []any{map[string]any{
			"name": "stopped-vm", "sampledAt": sampledAt, "status": "Stopped",
		}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	instances := samples[len(samples)-1]["instances"].([]any)
	if len(instances) != 1 || instances[0].(map[string]any)["name"] != "stopped-vm" {
		t.Fatalf("instance without performance data was dropped: %#v", instances)
	}
}

func TestMonitoringPayloadSkipsExpiredAndInvalidSamples(t *testing.T) {
	client := &Client{spoolDir: t.TempDir(), spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	now := time.Now()
	samples, err := client.queueMonitoringAt(map[string]any{
		"instances": map[string]any{"items": []any{
			map[string]any{"name": "fresh", "sampledAt": now.Add(-time.Minute).UTC().Format(time.RFC3339Nano), "performance": map[string]any{"cpuUsagePercent": 5}},
			map[string]any{"name": "expired", "sampledAt": now.Add(-3 * time.Minute).UTC().Format(time.RFC3339Nano), "performance": map[string]any{"cpuUsagePercent": 6}},
			map[string]any{"name": "invalid", "sampledAt": "invalid", "performance": map[string]any{"cpuUsagePercent": 7}},
		}},
	}, now)
	if err != nil {
		t.Fatal(err)
	}
	instances := samples[len(samples)-1]["instances"].([]any)
	if len(instances) != 1 || instances[0].(map[string]any)["name"] != "fresh" {
		t.Fatalf("stale monitoring points were queued: %#v", instances)
	}
}

func TestMonitoringSpoolReplaysPersistedInstanceSamplesOlderThanTwoMinutes(t *testing.T) {
	client := &Client{spoolDir: t.TempDir(), spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	now := time.Now()
	historical := map[string]any{
		"sampledAt": now.Add(-3 * time.Minute).UTC().Format(time.RFC3339Nano),
		"instances": []any{map[string]any{"name": "offline-vm"}},
	}
	if _, err := client.queueRecord(historical, 256*1024, 384*1024); err != nil {
		t.Fatal(err)
	}
	id := historical["id"].(string)
	path := client.pendingSamples[id]
	samples, err := client.queueMonitoringAt(map[string]any{}, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	for _, sample := range samples {
		if sample["id"] == id && sample["sampledAt"] == historical["sampledAt"] {
			return
		}
	}
	t.Fatalf("persisted monitoring sample %s was not replayed: %#v", id, samples)
}

func TestMonitoringAckIsIndependentAndExplicit(t *testing.T) {
	var ack atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Error(err)
			writer.WriteHeader(400)
			return
		}
		monitoring := payload["monitoring"].(map[string]any)
		ids := []string{}
		for _, raw := range monitoring["samples"].([]any) {
			ids = append(ids, raw.(map[string]any)["id"].(string))
		}
		response := map[string]any{"acceptedSampleIds": ids}
		if ack.Load() {
			response["monitoringAck"] = map[string]any{"schemaVersion": 2, "acceptedSampleIds": append(ids, strings.Repeat("f", 32))}
		}
		if err := json.NewEncoder(writer).Encode(response); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	client := New(config.Config{StateDir: t.TempDir(), PanelURL: server.URL, AgentID: "fixture", AgentSecret: "fixture", RequestTimeout: time.Second})
	if _, err := client.Heartbeat(context.Background(), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(client.monitoring.spoolDir)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			count++
		}
	}
	if count != 2 {
		t.Fatal("legacy ACK removed monitoring sample")
	}
	ack.Store(true)
	if _, err := client.Heartbeat(context.Background(), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	entries, err = os.ReadDir(client.monitoring.spoolDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".json") {
			t.Fatal("explicit v2 ACK did not remove sample")
		}
	}
}

func TestComponentPendingCheckpointRecoversSameIdentity(t *testing.T) {
	directory := t.TempDir()
	client := &Client{spoolDir: directory, spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	components := map[string]any{"zfs": map[string]any{"available": true}}
	encoded, _ := json.Marshal(semanticComponent(componentSummary(components)))
	id := strings.Repeat("a", 32)
	at := time.Now().UTC().Format(time.RFC3339Nano)
	pending := map[string]any{"id": id, "sampledAt": at, "events": []any{map[string]any{"id": id, "sampledAt": at, "type": "component-state", "components": json.RawMessage(encoded)}}}
	path := filepath.Join(directory, "components.state")
	checkpoint := componentCheckpoint{SchemaVersion: 2, Components: encoded, Pending: pending}
	if err := writeComponentCheckpoint(path, checkpoint); err != nil {
		t.Fatal(err)
	}
	if _, err := client.queueRecord(pending, 256*1024, 384*1024); err != nil {
		t.Fatal(err)
	}
	restarted := &Client{spoolDir: directory, spoolMaxBytes: 1024 * 1024, spoolRetention: time.Hour}
	samples, err := restarted.queueMonitoring(map[string]any{"components": components})
	if err != nil || len(samples) != 2 {
		t.Fatalf("recovery duplicated event: %v %#v", err, samples)
	}
	if samples[0]["id"] != id {
		t.Fatal("recovery replaced event identity")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint = componentCheckpoint{}
	if err := json.Unmarshal(data, &checkpoint); err != nil {
		t.Fatal(err)
	}
	if checkpoint.Pending != nil {
		t.Fatal("pending checkpoint not cleared")
	}
}

func TestMonitoringCapacityPreservesEventsBeforeMetrics(t *testing.T) {
	client := &Client{spoolDir: t.TempDir(), spoolMaxBytes: 1600, spoolRetention: time.Hour}
	components := map[string]any{"zfs": map[string]any{"available": true}}
	if err := client.queueComponentChange(components); err != nil {
		t.Fatal(err)
	}
	var eventID any
	for index := 0; index < 20; index++ {
		samples, err := client.queueRecord(map[string]any{"resources": map[string]any{"padding": strings.Repeat("x", 500)}}, 256*1024, 384*1024)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, sample := range samples {
			if _, ok := sample["events"]; ok {
				if eventID != nil && eventID != sample["id"] {
					t.Fatal("event identity changed during eviction")
				}
				eventID = sample["id"]
				found = true
			}
		}
		if !found {
			t.Fatal("metrics pressure evicted unacknowledged event")
		}
		entries, _ := os.ReadDir(client.spoolDir)
		var total int64
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") {
				info, _ := entry.Info()
				total += info.Size()
			}
		}
		if total > client.spoolMaxBytes {
			t.Fatal("spool exceeded capacity")
		}
	}
}

func TestMonitoringAckRejectsFailedWrongVersionAndUnsentIDs(t *testing.T) {
	var mode atomic.Int32
	var unsentID string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		ids := []string{unsentID, "../../outside"}
		for _, raw := range payload["monitoring"].(map[string]any)["samples"].([]any) {
			ids = append(ids, raw.(map[string]any)["id"].(string))
		}
		version := 2
		if mode.Load() == 0 {
			writer.WriteHeader(500)
		}
		if mode.Load() == 1 {
			version = 1
		}
		if err := json.NewEncoder(writer).Encode(map[string]any{"monitoringAck": map[string]any{"schemaVersion": version, "acceptedSampleIds": ids}}); err != nil {
			t.Error(err)
		}
	}))
	defer server.Close()
	client := New(config.Config{StateDir: t.TempDir(), PanelURL: server.URL, AgentID: "fixture", AgentSecret: "fixture", RequestTimeout: time.Second})
	for index := 0; index < 40; index++ {
		if _, err := client.monitoring.queueRecord(map[string]any{"resources": map[string]any{"cpuTotal": 1}}, 256*1024, 384*1024); err != nil {
			t.Fatal(err)
		}
	}
	entries, _ := os.ReadDir(client.monitoring.spoolDir)
	unsentPath := filepath.Join(client.monitoring.spoolDir, entries[len(entries)-1].Name())
	body, _ := os.ReadFile(unsentPath)
	var unsent map[string]any
	if err := json.Unmarshal(body, &unsent); err != nil {
		t.Fatal(err)
	}
	unsentID = unsent["id"].(string)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Heartbeat(context.Background(), map[string]any{}); err == nil {
		t.Fatal("HTTP failure accepted")
	}
	mode.Store(1)
	if _, err := client.Heartbeat(context.Background(), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	entries, _ = os.ReadDir(client.monitoring.spoolDir)
	if len(entries) < 43 {
		t.Fatal("failed or wrong-version ACK removed queued files")
	}
	mode.Store(2)
	if _, err := client.Heartbeat(context.Background(), map[string]any{}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(unsentPath); err != nil {
		t.Fatal("ACK removed an unsent sample")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("ACK escaped spool")
	}
}
