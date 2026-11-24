package report

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestOneInstanceStateFailureDoesNotDiscardSuccessfulMonitoringPoints(t *testing.T) {
	previous := cachedInstances()
	t.Cleanup(func() { replaceCachedInstances(previous) })
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.Contains(request.URL.Path, "/failed/") {
			writer.WriteHeader(http.StatusBadGateway)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"type":"sync","metadata":{"status":"Running","pid":42,"started_at":"2026-11-25T00:00:00Z","cpu":{"usage":1000000000},"memory":{"usage":1024}}}`))
	}))
	defer server.Close()
	client := server.Client()
	client.Transport = rewriteIncusTestTransport{base: client.Transport, target: server.URL}
	failed := buildIncusInstanceReportItem(client, incusInstanceSummary{Name: "failed", Status: "Running"})
	succeeded := buildIncusInstanceReportItem(client, incusInstanceSummary{Name: "succeeded", Status: "Running"})
	if _, exists := failed["sampledAt"]; exists {
		t.Fatalf("failed state query produced a monitoring timestamp: %#v", failed)
	}
	if succeeded["sampledAt"] == nil || succeeded["performance"] == nil {
		t.Fatalf("successful state query did not produce monitoring data: %#v", succeeded)
	}
	for _, test := range []struct {
		name             string
		deadlineExceeded bool
	}{
		{name: "state failure"},
		{name: "deadline with completed items", deadlineExceeded: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			replaceCachedInstances(nil)
			publishInstanceReport(map[string]any{
				"available": true, "deadlineExceeded": test.deadlineExceeded,
				"items": []any{failed, succeeded},
			})
			items := cachedInstances()["items"].([]any)
			if len(items) != 2 || items[0].(map[string]any)["error"] == nil {
				t.Fatalf("partial inventory was not published: %#v", items)
			}
			points := RealtimeInstancePayload(3)["instances"].([]any)
			if len(points) != 1 {
				t.Fatalf("expected one monitoring point: %#v", points)
			}
			point := points[0].(map[string]any)
			if point["name"] != "succeeded" || point["sampledAt"] != succeeded["sampledAt"] {
				t.Fatalf("successful monitoring point was lost or restamped: %#v", point)
			}
		})
	}
}

type rewriteIncusTestTransport struct {
	base   http.RoundTripper
	target string
}

func (transport rewriteIncusTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.URL.Scheme = "http"
	copy.URL.Host = strings.TrimPrefix(transport.target, "http://")
	return transport.base.RoundTrip(copy)
}

func TestPressureMissingAndMalformedAreNotZero(t *testing.T) {
	values := parsePressure("some avg10=1.25 avg60=2.50 avg300=0.00 total=12345\nfull avg10=NaN avg60=0 avg300=0 total=1\n")
	if values["some.avg10"] != 1.25 || values["some.total"] != float64(12345) {
		t.Fatalf("unexpected PSI: %#v", values)
	}
	if _, exists := values["full.avg10"]; exists {
		t.Fatal("malformed PSI became a value")
	}
	if len(parsePressure("")) != 0 {
		t.Fatal("missing PSI became zero")
	}
}

func TestPerformanceRatesUseStableIdentity(t *testing.T) {
	identityA := t.Name() + ":a"
	identityB := t.Name() + ":b"
	defer func() {
		performanceCache.Lock()
		delete(performanceCache.items, identityA)
		delete(performanceCache.items, identityB)
		performanceCache.Unlock()
	}()
	state := func(cpu int) incusInstanceState {
		body, _ := json.Marshal(map[string]any{"pid": 7, "started_at": "2026-11-11T00:00:00Z", "cpu": map[string]any{"usage": cpu}, "memory": map[string]any{"usage": 1024}})
		var value incusInstanceState
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	at := time.Now()
	if metrics := performanceMetrics("same-name", identityA, state(1000000000), at); metrics["cpuUsagePercent"] != nil {
		t.Fatal("first stable identity sample produced a rate")
	}
	if metrics := performanceMetrics("same-name", identityB, state(2000000000), at.Add(time.Second)); metrics["cpuUsagePercent"] != nil {
		t.Fatal("different stable identity reused predecessor")
	}
	metrics := performanceMetrics("renamed", identityA, state(3000000000), at.Add(2*time.Second))
	if metrics["cpuUsagePercent"] != float64(100) {
		t.Fatalf("renamed instance did not retain stable predecessor: %#v", metrics)
	}
}

func TestPerformanceRatesResetAndIncusDiskContract(t *testing.T) {
	name := t.Name()
	defer func() { performanceCache.Lock(); delete(performanceCache.items, name); performanceCache.Unlock() }()
	state := func(cpu, read, write int, pid int) incusInstanceState {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"pid": pid, "started_at": "2026-11-11T00:00:00Z", "cpu": map[string]any{"usage": cpu}, "memory": map[string]any{"usage": 1024}, "disk": map[string]any{"root": map[string]any{"counters": map[string]any{"bytes_read": read, "bytes_written": write}}}})
		var value incusInstanceState
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	at := time.Now()
	first := performanceMetrics(name, name, state(1000000000, 100, 200, 1), at)
	if _, exists := first["cpuUsagePercent"]; exists {
		t.Fatal("first counter produced CPU rate")
	}
	second := performanceMetrics(name, name, state(2000000000, 300, 600, 1), at.Add(time.Second))
	if second["cpuUsagePercent"] != float64(100) || second["diskIOBytesPerSecond"] != float64(600) || second["memoryUsedBytes"] != uint64(1024) {
		t.Fatalf("unexpected rates: %#v", second)
	}
	for index, value := range []incusInstanceState{state(1, 1, 1, 1), state(2000000000, 300, 600, 2)} {
		metrics := performanceMetrics(name, name, value, at.Add(time.Duration(index+2)*time.Second))
		if _, exists := metrics["cpuUsagePercent"]; exists {
			t.Fatal("reset produced CPU spike")
		}
		if _, exists := metrics["diskIOBytesPerSecond"]; exists {
			t.Fatal("reset produced I/O spike")
		}
	}
}

func TestPerformanceRatesUseProcStartIdentityWhenIncusOmitsStartedAt(t *testing.T) {
	identity := t.Name()
	defer func() { performanceCache.Lock(); delete(performanceCache.items, identity); performanceCache.Unlock() }()
	state := func(cpu int) incusInstanceState {
		body, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "cpu": map[string]any{"usage": cpu}, "memory": map[string]any{"usage": 1024}})
		var value incusInstanceState
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	at := time.Now()
	performanceMetrics("vm", identity, state(1000000000), at)
	metrics := performanceMetrics("vm", identity, state(2000000000), at.Add(time.Second))
	if metrics["cpuUsagePercent"] != float64(100) {
		t.Fatalf("missing Incus started_at did not use safe process identity: %#v", metrics)
	}
}

func TestProcessStartIdentityParsesStatCommandWithParentheses(t *testing.T) {
	stat := "123 (worker (incus)) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 20"
	if got := processStartIdentityFromStat(stat); got != "987654" {
		t.Fatalf("unexpected process start identity: %q", got)
	}
	if got := processStartIdentityFromStat("123 (worker) S 1 2"); got != "" {
		t.Fatalf("malformed proc stat returned identity: %q", got)
	}
}

func TestRealtimeInstancePayloadPlacesIntervalAtTopLevel(t *testing.T) {
	previous := collector.instances
	collector.Lock()
	collector.instances = map[string]any{"items": []any{map[string]any{"name": "instance-1", "sampledAt": time.Now().UTC().Format(time.RFC3339Nano), "performance": map[string]any{"cpuUsagePercent": 1.5}}}}
	collector.Unlock()
	defer func() { collector.Lock(); collector.instances = previous; collector.Unlock() }()

	payload := RealtimeInstancePayload(15)
	if payload["intervalSeconds"] != 15 {
		t.Fatalf("unexpected top-level monitoring interval: %#v", payload["intervalSeconds"])
	}
	instances, ok := payload["instances"].([]any)
	if !ok || len(instances) != 1 {
		t.Fatalf("unexpected realtime instances: %#v", payload["instances"])
	}
	instance, ok := instances[0].(map[string]any)
	if !ok {
		t.Fatalf("unexpected realtime instance: %#v", instances[0])
	}
	if _, exists := instance["intervalSeconds"]; exists {
		t.Fatal("monitoring interval must not be repeated on each instance")
	}
}

func TestRealtimeInstancePayloadSkipsExpiredAndInvalidSamples(t *testing.T) {
	previous := collector.instances
	now := time.Now()
	collector.Lock()
	collector.instances = map[string]any{"items": []any{
		map[string]any{"name": "fresh", "sampledAt": now.Add(-time.Minute).UTC().Format(time.RFC3339Nano), "performance": map[string]any{"cpuUsagePercent": 1}},
		map[string]any{"name": "expired", "sampledAt": now.Add(-3 * time.Minute).UTC().Format(time.RFC3339Nano), "performance": map[string]any{"cpuUsagePercent": 2}},
		map[string]any{"name": "invalid", "sampledAt": "invalid", "performance": map[string]any{"cpuUsagePercent": 3}},
	}}
	collector.Unlock()
	defer func() { collector.Lock(); collector.instances = previous; collector.Unlock() }()

	payload := realtimeInstancePayload(15, now)
	instances := payload["instances"].([]any)
	if len(instances) != 1 || instances[0].(map[string]any)["name"] != "fresh" {
		t.Fatalf("stale realtime samples were not omitted: %#v", instances)
	}
}
