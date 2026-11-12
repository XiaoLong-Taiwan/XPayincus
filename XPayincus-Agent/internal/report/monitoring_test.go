package report

import (
	"encoding/json"
	"testing"
	"time"
)

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
	first := performanceMetrics(name, state(1000000000, 100, 200, 1), at)
	if _, exists := first["cpuUsagePercent"]; exists {
		t.Fatal("first counter produced CPU rate")
	}
	second := performanceMetrics(name, state(2000000000, 300, 600, 1), at.Add(time.Second))
	if second["cpuUsagePercent"] != float64(100) || second["diskIOBytesPerSecond"] != float64(600) || second["memoryUsedBytes"] != uint64(1024) {
		t.Fatalf("unexpected rates: %#v", second)
	}
	for index, value := range []incusInstanceState{state(1, 1, 1, 1), state(2000000000, 300, 600, 2)} {
		metrics := performanceMetrics(name, value, at.Add(time.Duration(index+2)*time.Second))
		if _, exists := metrics["cpuUsagePercent"]; exists {
			t.Fatal("reset produced CPU spike")
		}
		if _, exists := metrics["diskIOBytesPerSecond"]; exists {
			t.Fatal("reset produced I/O spike")
		}
	}
}
