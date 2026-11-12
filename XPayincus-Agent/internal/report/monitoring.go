package report

import (
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

func parsePressure(content string) map[string]any {
	result := map[string]any{}
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 5 || (fields[0] != "some" && fields[0] != "full") {
			continue
		}
		values := map[string]any{}
		for _, field := range fields[1:] {
			key, raw, ok := strings.Cut(field, "=")
			value, err := strconv.ParseFloat(raw, 64)
			if !ok || err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
				continue
			}
			if key == "total" || ((key == "avg10" || key == "avg60" || key == "avg300") && value <= 100) {
				values[key] = value
			}
		}
		if len(values) == 4 {
			for key, value := range values {
				result[fields[0]+"."+key] = value
			}
		}
	}
	return result
}

func collectPressure() map[string]any {
	result := map[string]any{}
	for _, resource := range []string{"cpu", "memory", "io"} {
		content, err := os.ReadFile("/proc/pressure/" + resource)
		if err != nil {
			continue
		}
		for key, value := range parsePressure(string(content)) {
			result["psi."+resource+"."+key] = value
		}
	}
	return result
}

type performanceSnapshot struct {
	at        time.Time
	pid       int64
	startedAt string
	devices   string
	cpu       uint64
	read      uint64
	write     uint64
	validCPU  bool
	validDisk bool
}

var performanceCache = struct {
	sync.Mutex
	items map[string]performanceSnapshot
}{items: map[string]performanceSnapshot{}}

func performanceMetrics(name string, state incusInstanceState, now time.Time) map[string]any {
	performanceCache.Lock()
	defer performanceCache.Unlock()
	for key, value := range performanceCache.items {
		if now.Sub(value.at) > time.Hour {
			delete(performanceCache.items, key)
		}
	}
	metrics := map[string]any{}
	cpu, cpuErr := strconv.ParseUint(state.CPU.Usage.String(), 10, 64)
	current := performanceSnapshot{at: now, pid: state.PID, startedAt: state.StartedAt, cpu: cpu, validCPU: cpuErr == nil}
	if memory, err := strconv.ParseUint(state.Memory.Usage.String(), 10, 64); err == nil {
		metrics["memoryUsedBytes"] = memory
	}
	if len(state.Disk) > 0 {
		current.validDisk = true
		devices := make([]string, 0, len(state.Disk))
		for name, disk := range state.Disk {
			devices = append(devices, name)
			if disk.Counters == nil {
				current.validDisk = false
				break
			}
			read, readErr := strconv.ParseUint(disk.Counters.ReadBytes.String(), 10, 64)
			write, writeErr := strconv.ParseUint(disk.Counters.WriteBytes.String(), 10, 64)
			if readErr != nil || writeErr != nil || ^uint64(0)-current.read < read || ^uint64(0)-current.write < write {
				current.validDisk = false
				break
			}
			current.read += read
			current.write += write
		}
		sort.Strings(devices)
		current.devices = strings.Join(devices, "\x00")
	}
	previous, exists := performanceCache.items[name]
	elapsed := now.Sub(previous.at).Seconds()
	if exists && elapsed > 0 && elapsed <= 3600 && current.pid > 0 && current.pid == previous.pid && current.startedAt == previous.startedAt {
		metrics["intervalSeconds"] = elapsed
		if current.validCPU && previous.validCPU && current.cpu >= previous.cpu {
			metrics["cpuUsagePercent"] = float64(current.cpu-previous.cpu) / (elapsed * 1e9) * 100
		}
		if current.validDisk && previous.validDisk && current.devices == previous.devices && current.read >= previous.read && current.write >= previous.write {
			metrics["diskReadBytesPerSecond"] = float64(current.read-previous.read) / elapsed
			metrics["diskWriteBytesPerSecond"] = float64(current.write-previous.write) / elapsed
			metrics["diskIOBytesPerSecond"] = (float64(current.read-previous.read) + float64(current.write-previous.write)) / elapsed
		}
	}
	if len(performanceCache.items) < 10000 || exists {
		performanceCache.items[name] = current
	}
	return metrics
}
