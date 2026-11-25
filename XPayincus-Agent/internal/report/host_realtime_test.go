package report

import (
	"reflect"
	"testing"
	"time"
)

func TestHostRealtimePayload(t *testing.T) {
	start := time.Date(2026, 11, 25, 14, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	var sampler HostRealtimeSampler
	memory := map[string]int64{"MemTotal": 100, "MemAvailable": 30, "SwapTotal": 0}
	network := map[string]hostNetworkCounter{"eth0": {rx: 200, tx: 100}}
	first := sampler.sample(start, cpuStat{idle: 60, total: 100}, memory, 25, true, network)
	want := map[string]any{"sampledAt": "2026-11-25T06:00:00Z", "ramPercent": 70.0, "swapPercent": 0.0, "diskPercent": 25.0}
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("first sample = %v, want %v", first, want)
	}

	memory = map[string]int64{"MemTotal": 100, "SwapTotal": 80, "SwapFree": 60}
	network = map[string]hostNetworkCounter{"eth0": {rx: 440, tx: 100}}
	second := sampler.sample(start.Add(4*time.Second), cpuStat{idle: 140, total: 220, guest: 20}, memory, 0, false, network)
	want = map[string]any{"sampledAt": "2026-11-25T06:00:04Z", "cpuPercent": 20.0, "swapPercent": 25.0, "rxBytesPerSecond": 60.0, "txBytesPerSecond": 0.0}
	if !reflect.DeepEqual(second, want) {
		t.Fatalf("second sample = %v, want %v", second, want)
	}

	if got := sampler.sample(start.Add(7*time.Second), cpuStat{}, nil, 0, false, nil); got != nil {
		t.Fatalf("empty sample = %v", got)
	}
	if got := sampler.sample(start.Add(10*time.Second), cpuStat{idle: 190, total: 280}, nil, 0, false, network); got != nil {
		t.Fatalf("invalid post-gap baseline = %v", got)
	}
}

func TestHostRealtimeNetworkRebases(t *testing.T) {
	var sampler HostRealtimeSampler
	now := time.Now()
	for step, test := range []struct {
		network  map[string]hostNetworkCounter
		wantRate bool
	}{
		{map[string]hostNetworkCounter{"eth0": {rx: 30}, "eth1": {rx: 30}}, false},
		{map[string]hostNetworkCounter{"eth0": {rx: 1}, "eth1": {rx: 300}}, false}, // Reset masked by aggregate growth.
		{map[string]hostNetworkCounter{"eth0": {rx: 4}, "eth1": {rx: 306}}, true},
		{map[string]hostNetworkCounter{"eth0": {rx: 5}, "eth2": {rx: 400}}, false}, // Replaced interface.
		{map[string]hostNetworkCounter{"eth0": {rx: 8}, "eth2": {rx: 406}}, true},
	} {
		rx, tx, ok := sampler.networkRates(now.Add(time.Duration(step)*3*time.Second), test.network)
		if ok != test.wantRate || (ok && (rx != 3 || tx != 0)) {
			t.Errorf("step %d: got rx=%v tx=%v ok=%v", step, rx, tx, ok)
		}
	}
}
