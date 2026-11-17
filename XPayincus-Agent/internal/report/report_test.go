package report

import (
	"net"
	"runtime"
	"testing"
)

func TestBuildHostReportDetectsAddressFamiliesAndRoutedPrefix(t *testing.T) {
	interfaces := []net.Interface{
		{Name: "eth0"},
		{Name: "eth1"},
	}
	addresses := map[string][]net.Addr{
		"eth0": {mustParseCIDR(t, "192.168.1.20/24"), mustParseCIDR(t, "8.8.4.4/24")},
		"eth1": {mustParseCIDR(t, "2001:4860:abcd::10/64"), mustParseCIDR(t, "fe80::10/64"), mustParseCIDR(t, "fd00::10/64")},
	}
	originalInterfaces := hostNetworkInterfaces
	originalAddresses := hostInterfaceAddresses
	originalPools := hostIncusStoragePools
	originalRouted := hostIpv6DefaultInterface
	hostNetworkInterfaces = func() ([]net.Interface, error) { return interfaces, nil }
	hostInterfaceAddresses = func(iface net.Interface) ([]net.Addr, error) { return addresses[iface.Name], nil }
	hostIncusStoragePools = func() []any { return []any{map[string]any{"name": "default", "driver": "zfs"}} }
	hostIpv6DefaultInterface = func() string { return "eth1" }
	t.Cleanup(func() {
		hostNetworkInterfaces = originalInterfaces
		hostInterfaceAddresses = originalAddresses
		hostIncusStoragePools = originalPools
		hostIpv6DefaultInterface = originalRouted
	})

	report := collectHostReport()
	if report["architecture"] != runtime.GOARCH {
		t.Fatalf("host architecture mismatch: %#v", report["architecture"])
	}
	if report["routedIpv6"] != true || report["ipv6Interface"] != "eth1" {
		t.Fatalf("routed IPv6 detection mismatch: %#v", report)
	}
	prefixes, ok := report["ipv6Prefixes"].([]any)
	if !ok || len(prefixes) != 1 || prefixes[0] != "2001:4860:abcd::10/64" {
		t.Fatalf("routed IPv6 prefixes mismatch: %#v", report["ipv6Prefixes"])
	}
	publicIpv4, ok := report["publicIpv4"].([]string)
	if !ok || len(publicIpv4) != 1 || publicIpv4[0] != "8.8.4.4" {
		t.Fatalf("public IPv4 detection mismatch: %#v", report["publicIpv4"])
	}
	pools, ok := report["storagePools"].([]any)
	if !ok || len(pools) != 1 {
		t.Fatalf("storage pool detection mismatch: %#v", report["storagePools"])
	}
}

func mustParseCIDR(t *testing.T, cidr string) net.Addr {
	t.Helper()
	ip, network, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatal(err)
	}
	return &net.IPNet{IP: ip, Mask: network.Mask}
}

func TestHeartbeatPayloadIncludesHostMetrics(t *testing.T) {
	payload := HeartbeatPayload("test-version", 30)

	capabilities, ok := payload["capabilities"].([]any)
	if !ok {
		t.Fatalf("capabilities missing or invalid: %#v", payload["capabilities"])
	}
	resources, ok := payload["resources"].(map[string]any)
	if !ok {
		t.Fatalf("resources missing or invalid: %#v", payload["resources"])
	}
	if containsCapability(capabilities, "host-metrics") != hasResourceKey(resources, "memoryTotalMb") {
		t.Fatalf("host-metrics capability must reflect memory collector: %#v", capabilities)
	}
	if containsCapability(capabilities, "instance-status") != (cachedInstances()["available"] == true) {
		t.Fatalf("instance-status capability must reflect collector: %#v", capabilities)
	}
	if containsCapability(capabilities, "traffic-counters") != (cachedInstances()["trafficAvailable"] == true) {
		t.Fatalf("traffic-counters capability must reflect successful state collection: %#v", capabilities)
	}

	instances, ok := payload["instances"].(map[string]any)
	if !ok {
		t.Fatalf("instances report missing or invalid: %#v", payload["instances"])
	}
	for _, key := range []string{"available", "reportedAt", "total", "items"} {
		if _, ok := instances[key]; !ok {
			t.Fatalf("instances key %s missing: %#v", key, instances)
		}
	}

	runtimeInfo, ok := payload["runtime"].(map[string]any)
	if !ok {
		t.Fatalf("runtime missing or invalid: %#v", payload["runtime"])
	}
	for _, key := range []string{"goos", "goarch"} {
		if _, ok := runtimeInfo[key]; !ok {
			t.Fatalf("runtime key %s missing: %#v", key, runtimeInfo)
		}
	}

	for _, key := range []string{"cpuTotal"} {
		if _, ok := resources[key]; !ok {
			t.Fatalf("resource key %s missing: %#v", key, resources)
		}
	}
	if runtime.GOOS == "linux" {
		for _, key := range []string{"swapTotalMb", "swapUsedMb", "swapUsagePercent", "diskTotalBytes", "diskUsedBytes", "diskUsagePercent"} {
			if _, ok := resources[key]; !ok {
				t.Fatalf("linux resource key %s missing: %#v", key, resources)
			}
		}
	}
	if runtime.GOOS == "linux" {
		for _, key := range []string{
			"cpuUsagePercent",
			"memoryTotalMb",
			"memoryUsedMb",
			"memoryUsagePercent",
			"processCount",
		} {
			if _, ok := resources[key]; !ok {
				t.Fatalf("linux resource key %s missing: %#v", key, resources)
			}
		}
	}

	metrics, ok := payload["metrics"].(map[string]any)
	if !ok {
		t.Fatalf("metrics missing or invalid: %#v", payload["metrics"])
	}
	for _, key := range []string{"reportedAt", "heartbeatIntervalSeconds"} {
		if _, ok := metrics[key]; !ok {
			t.Fatalf("metric key %s missing: %#v", key, metrics)
		}
	}
	if runtime.GOOS == "linux" {
		for _, key := range []string{"uptimeSeconds", "load1", "load5", "load15"} {
			if _, ok := metrics[key]; !ok {
				t.Fatalf("linux metric key %s missing: %#v", key, metrics)
			}
		}
	}
	if metrics["heartbeatIntervalSeconds"] != 30 {
		t.Fatalf("heartbeat interval mismatch: %#v", metrics["heartbeatIntervalSeconds"])
	}
}

func hasResourceKey(resources map[string]any, key string) bool {
	_, ok := resources[key]
	return ok
}

func TestHeartbeatPayloadClampsHeartbeatInterval(t *testing.T) {
	tests := []struct {
		name     string
		input    int
		expected int
	}{
		{name: "zero falls back", input: 0, expected: 60},
		{name: "too low clamps to min", input: 1, expected: 30},
		{name: "too high clamps to max", input: 7200, expected: 3600},
		{name: "valid stays unchanged", input: 60, expected: 60},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			payload := HeartbeatPayload("test-version", tt.input)
			metrics, ok := payload["metrics"].(map[string]any)
			if !ok {
				t.Fatalf("metrics missing or invalid: %#v", payload["metrics"])
			}
			if metrics["heartbeatIntervalSeconds"] != tt.expected {
				t.Fatalf("heartbeat interval mismatch: got=%#v want=%d", metrics["heartbeatIntervalSeconds"], tt.expected)
			}
		})
	}
}

func TestRunningIncusStatusDetection(t *testing.T) {
	tests := []struct {
		name       string
		status     string
		statusCode int
		expected   bool
	}{
		{name: "running string", status: "Running", statusCode: 0, expected: true},
		{name: "running status code", status: "", statusCode: 103, expected: true},
		{name: "stopped", status: "Stopped", statusCode: 102, expected: false},
		{name: "empty", status: "", statusCode: 0, expected: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRunningIncusStatus(tt.status, tt.statusCode); got != tt.expected {
				t.Fatalf("running status mismatch: got=%t want=%t", got, tt.expected)
			}
		})
	}
}

func TestTrafficCountersFromIncusStateUsesBillableInterfaces(t *testing.T) {
	state := incusInstanceState{
		Network: map[string]incusNetworkDevice{
			"lo": {
				Counters: incusNetworkCounters{
					BytesReceived: "999",
					BytesSent:     "999",
				},
			},
			"eth0": {
				Counters: incusNetworkCounters{
					BytesReceived: "100",
					BytesSent:     "200",
				},
			},
			"docker0": {
				Counters: incusNetworkCounters{
					BytesReceived: "300",
					BytesSent:     "400",
				},
			},
		},
	}

	counters := getTrafficCountersFromIncusState("vm-test", state)
	if counters.rx != 100 || counters.tx != 200 {
		t.Fatalf("traffic counters mismatch: got=%+v", counters)
	}
}

func TestTrafficCountersFromIncusStateFallsBackToExternalInterfaces(t *testing.T) {
	state := incusInstanceState{
		Network: map[string]incusNetworkDevice{
			"lo": {
				Counters: incusNetworkCounters{
					BytesReceived: "999",
					BytesSent:     "999",
				},
			},
			"enp5s0": {
				Counters: incusNetworkCounters{
					BytesReceived: "123",
					BytesSent:     "456",
				},
			},
		},
	}

	counters := getTrafficCountersFromIncusState("vm-test", state)
	if counters.rx != 123 || counters.tx != 456 {
		t.Fatalf("traffic counters mismatch: got=%+v", counters)
	}
}

func containsCapability(capabilities []any, expected string) bool {
	for _, capability := range capabilities {
		if capability == expected {
			return true
		}
	}
	return false
}
