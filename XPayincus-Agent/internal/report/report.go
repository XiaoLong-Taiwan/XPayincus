package report

import (
	"context"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var incusSocketCandidates = []string{
	"/var/lib/incus/unix.socket",
	"/var/snap/incus/common/lxd/unix.socket",
	"/var/lib/lxd/unix.socket",
}

var hostNetworkInterfaces = net.Interfaces
var hostInterfaceAddresses = func(iface net.Interface) ([]net.Addr, error) { return iface.Addrs() }
var hostIpv6DefaultInterface = readIpv6DefaultInterface
var hostIncusStoragePools = collectIncusStoragePools

func HeartbeatPayload(version string, heartbeatIntervalSeconds int) map[string]any {
	instances := cachedInstances()
	resources := collectResources()
	components := componentStatus()
	capabilities := []any{"heartbeat", "report", "host-history-v1", "upgrade-status-v1", "monitoring-v2"}
	if _, ok := resources["memoryTotalMb"]; ok {
		capabilities = append(capabilities, "host-metrics")
	}
	if instances["available"] == true {
		capabilities = append(capabilities, "instance-status")
	}
	if instances["trafficAvailable"] == true {
		capabilities = append(capabilities, "traffic-counters")
	}
	for _, name := range []string{"rfw", "zfs"} {
		if status, ok := components[name].(map[string]any); ok && status["available"] == true {
			capabilities = append(capabilities, name+"-status-v1")
		}
	}
	return map[string]any{
		"version":      version,
		"capabilities": capabilities,
		"runtime": map[string]any{
			"goos":   runtime.GOOS,
			"goarch": runtime.GOARCH,
		},
		"incus": map[string]any{"available": instances["available"], "collector": map[string]any{
			"reportedAt": instances["reportedAt"], "total": instances["total"],
			"truncated": instances["truncated"], "deadlineExceeded": instances["deadlineExceeded"],
			"status": instances["status"],
		}},
		"components": components,
		"instances":  instances,
		"resources":  resources,
		"host":       collectHostReport(),
		"metrics":    collectMetrics(heartbeatIntervalSeconds),
	}
}

func collectHostReport() map[string]any {
	interfaces, err := hostNetworkInterfaces()
	if err != nil {
		interfaces = nil
	}
	return buildHostReport(interfaces, hostIncusStoragePools(), hostIpv6DefaultInterface())
}

func buildHostReport(systemInterfaces []net.Interface, pools []any, routedInterface string) map[string]any {
	interfaces := make([]any, 0)
	ipv6Prefixes := make([]any, 0)
	publicIpv4 := make([]string, 0)
	for _, iface := range systemInterfaces {
		addresses := make([]any, 0)
		ifaceAddresses, err := hostInterfaceAddresses(iface)
		if err != nil {
			continue
		}
		for _, address := range ifaceAddresses {
			ip, network, err := net.ParseCIDR(address.String())
			if err != nil || ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || ip.IsMulticast() {
				continue
			}
			prefix, bits := network.Mask.Size()
			if prefix < 0 {
				continue
			}
			addresses = append(addresses, map[string]any{"address": ip.String(), "prefixLength": prefix})
			if ip.To4() != nil && isPublicHostIPv4(ip) {
				publicIpv4 = append(publicIpv4, ip.String())
			}
			if iface.Name == routedInterface && ip.To4() == nil && ip.IsGlobalUnicast() && bits == 128 && prefix >= 1 && prefix <= 64 && !ip.IsPrivate() {
				ipv6Prefixes = append(ipv6Prefixes, ip.String()+"/"+strconv.Itoa(prefix))
			}
		}
		if len(addresses) > 0 {
			interfaces = append(interfaces, map[string]any{"name": iface.Name, "addresses": addresses})
		}
	}
	return map[string]any{
		"architecture": runtime.GOARCH,
		"network":       map[string]any{"interfaces": interfaces},
		"publicIpv4":    publicIpv4,
		"storagePools":  pools,
		"ipv6Prefixes":  ipv6Prefixes,
		"routedIpv6":    len(ipv6Prefixes) > 0,
		"ipv6Interface": routedInterface,
	}
}

func isPublicHostIPv4(ip net.IP) bool {
	return ip.To4() != nil && ip.IsGlobalUnicast() && !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast()
}

func readIpv6DefaultInterface() string {
	content, err := os.ReadFile("/proc/net/ipv6_route")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(content), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 10 && fields[0] == strings.Repeat("0", 32) && fields[1] == "00" && fields[9] != "lo" {
			return fields[9]
		}
	}
	return ""
}

func collectIncusStoragePools() []any {
	socketPath, ok := detectIncusSocket()
	if !ok {
		return []any{}
	}
	client := newIncusUnixHTTPClient(socketPath)
	return collectIncusStoragePoolsWithClient(client)
}

func collectIncusStoragePoolsWithClient(client *http.Client) []any {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	boundedClient := *client
	transport := client.Transport
	if transport == nil {
		transport = http.DefaultTransport
	}
	boundedClient.Transport = deadlineTransport{ctx: ctx, base: transport}
	response, err := incusRequest[[]struct {
		Name   string `json:"name"`
		Driver string `json:"driver"`
	}](&boundedClient, "/1.0/storage-pools?recursion=1")
	if err != nil {
		return []any{}
	}
	pools := make([]any, 0, len(response))
	for _, pool := range response {
		if pool.Name != "" && len(pool.Name) <= 64 {
			report := map[string]any{"name": pool.Name, "driver": pool.Driver}
			resources, err := incusRequest[struct {
				Space struct {
					Total uint64 `json:"total"`
					Used  uint64 `json:"used"`
				} `json:"space"`
			}](&boundedClient, "/1.0/storage-pools/"+url.PathEscape(pool.Name)+"/resources")
			if err == nil {
				report["space"] = map[string]any{"total": resources.Space.Total, "used": resources.Space.Used}
			}
			pools = append(pools, report)
		}
		if len(pools) >= 64 {
			break
		}
	}
	return pools
}

func networkInterfaces() []net.Interface {
	interfaces, err := hostNetworkInterfaces()
	if err != nil {
		return nil
	}
	return interfaces
}

func firstIpv6Interface(interfaces []any) string {
	for _, item := range interfaces {
		value, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if addresses, ok := value["addresses"].([]any); ok {
			for _, address := range addresses {
				entry, ok := address.(map[string]any)
				if !ok {
					continue
				}
				if address, ok := entry["address"].(string); ok && strings.Contains(address, ":") {
					if name, ok := value["name"].(string); ok {
						return name
					}
				}
			}
		}
	}
	return ""
}

func collectResources() map[string]any {
	resources := map[string]any{
		"cpuTotal": runtime.NumCPU(),
	}
	if cpuUsagePercent := readCPUUsagePercent(); cpuUsagePercent >= 0 {
		resources["cpuUsagePercent"] = cpuUsagePercent
	}
	for key, value := range readMemoryStats() {
		resources[key] = value
	}
	for key, value := range readDiskStats("/") {
		resources[key] = value
	}
	if processCount := readProcessCount(); processCount >= 0 {
		resources["processCount"] = processCount
	}
	for key, value := range collectPressure() {
		resources[key] = value
	}
	return resources
}

func collectMetrics(heartbeatIntervalSeconds int) map[string]any {
	switch {
	case heartbeatIntervalSeconds <= 0:
		heartbeatIntervalSeconds = 60
	case heartbeatIntervalSeconds < 30:
		heartbeatIntervalSeconds = 30
	case heartbeatIntervalSeconds > 3600:
		heartbeatIntervalSeconds = 3600
	}

	metrics := map[string]any{
		"reportedAt":               time.Now().UTC().Format(time.RFC3339),
		"heartbeatIntervalSeconds": heartbeatIntervalSeconds,
	}
	if uptimeSeconds := readUptimeSeconds(); uptimeSeconds > 0 {
		metrics["uptimeSeconds"] = uptimeSeconds
	}
	for key, value := range readLoadAverage() {
		metrics[key] = value
	}
	return metrics
}

func detectIncus() map[string]any {
	socketPath, ok := detectIncusSocket()
	if ok {
		return map[string]any{
			"available": true,
			"socket":    socketPath,
		}
	}
	return map[string]any{
		"available": false,
		"socket":    "",
	}
}

func detectIncusSocket() (string, bool) {
	for _, socketPath := range incusSocketCandidates {
		if info, err := os.Stat(socketPath); err == nil && !info.IsDir() {
			return socketPath, true
		}
	}
	return "", false
}

type cpuStat struct {
	idle  uint64
	total uint64
}

func readCPUUsagePercent() float64 {
	before, ok := readCPUStat()
	if !ok {
		return -1
	}
	time.Sleep(200 * time.Millisecond)
	after, ok := readCPUStat()
	if !ok {
		return -1
	}

	if after.total < before.total || after.idle < before.idle {
		return -1
	}
	totalDelta := after.total - before.total
	idleDelta := after.idle - before.idle
	if totalDelta == 0 || idleDelta > totalDelta {
		return -1
	}

	return roundPercent(float64(totalDelta-idleDelta) / float64(totalDelta) * 100)
}

func readCPUStat() (cpuStat, bool) {
	content, err := os.ReadFile("/proc/stat")
	if err != nil {
		return cpuStat{}, false
	}
	for _, line := range strings.Split(string(content), "\n") {
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 5 {
			return cpuStat{}, false
		}

		var values []uint64
		for _, field := range fields[1:] {
			value, err := strconv.ParseUint(field, 10, 64)
			if err != nil {
				return cpuStat{}, false
			}
			values = append(values, value)
		}

		var total uint64
		for _, value := range values {
			total += value
		}
		idle := values[3]
		if len(values) > 4 {
			idle += values[4]
		}
		return cpuStat{idle: idle, total: total}, true
	}
	return cpuStat{}, false
}

func readMemoryStats() map[string]any {
	meminfo := readMeminfoKB()
	stats := map[string]any{}
	memTotal := meminfo["MemTotal"]
	memAvailable := meminfo["MemAvailable"]
	if memTotal > 0 {
		memUsed := memTotal - memAvailable
		if memUsed < 0 {
			memUsed = 0
		}
		stats["memoryTotalMb"] = memTotal / 1024
		stats["memoryAvailableMb"] = memAvailable / 1024
		stats["memoryUsedMb"] = memUsed / 1024
		stats["memoryUsagePercent"] = roundPercent(float64(memUsed) / float64(memTotal) * 100)
	}

	swapTotal := meminfo["SwapTotal"]
	swapFree := meminfo["SwapFree"]
	if swapTotal > 0 {
		swapUsed := swapTotal - swapFree
		if swapUsed < 0 {
			swapUsed = 0
		}
		stats["swapTotalMb"] = swapTotal / 1024
		stats["swapUsedMb"] = swapUsed / 1024
		stats["swapUsagePercent"] = roundPercent(float64(swapUsed) / float64(swapTotal) * 100)
	} else {
		stats["swapTotalMb"] = int64(0)
		stats["swapUsedMb"] = int64(0)
		stats["swapUsagePercent"] = float64(0)
	}

	return stats
}

func readMeminfoKB() map[string]int64 {
	content, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return map[string]int64{}
	}

	values := map[string]int64{}
	for _, line := range strings.Split(string(content), "\n") {
		key, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			continue
		}
		kb, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			continue
		}
		values[key] = kb
	}
	return values
}

func readLoadAverage() map[string]any {
	content, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return map[string]any{}
	}
	fields := strings.Fields(string(content))
	if len(fields) < 3 {
		return map[string]any{}
	}

	loads := map[string]any{}
	keys := []string{"load1", "load5", "load15"}
	for index, key := range keys {
		value, err := strconv.ParseFloat(fields[index], 64)
		if err == nil {
			loads[key] = value
		}
	}
	return loads
}

func readProcessCount() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return -1
	}
	count := 0
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(entry.Name()); err == nil {
			count++
		}
	}
	return count
}

func readUptimeSeconds() int64 {
	content, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(content))
	if len(fields) == 0 {
		return 0
	}
	value, err := strconv.ParseFloat(fields[0], 64)
	if err != nil {
		return 0
	}
	return int64(value)
}

func roundPercent(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}
