package report

import "time"

// HostRealtimeSampler owns the host realtime baselines and is used by one sampling loop.
type HostRealtimeSampler struct {
	cpu       cpuStat
	networkAt time.Time
	network   map[string]hostNetworkCounter
}

func (sampler *HostRealtimeSampler) Sample() map[string]any {
	cpu, _ := readCPUStat()
	memory := readMeminfoKB()
	disk, diskOK := readDiskStats("/")["diskUsagePercent"].(float64)
	network, _ := readHostNetworkCounters()
	return sampler.sample(time.Now(), cpu, memory, disk, diskOK, network)
}

func (sampler *HostRealtimeSampler) sample(now time.Time, cpu cpuStat, memory map[string]int64, disk float64, diskOK bool, network map[string]hostNetworkCounter) map[string]any {
	metrics := make(map[string]any, 7)
	// Linux already includes guest time in user and nice.
	cpu.total -= cpu.guest
	previous := sampler.cpu
	sampler.cpu = cpu
	if previous.total > 0 && cpu.total > previous.total && cpu.idle >= previous.idle {
		totalDelta, idleDelta := cpu.total-previous.total, cpu.idle-previous.idle
		if idleDelta <= totalDelta {
			metrics["cpuPercent"] = roundPercent(float64(totalDelta-idleDelta) / float64(totalDelta) * 100)
		}
	}
	if value, ok := hostUsedPercent(memory, "MemTotal", "MemAvailable"); ok {
		metrics["ramPercent"] = value
	}
	if value, ok := hostUsedPercent(memory, "SwapTotal", "SwapFree"); ok {
		metrics["swapPercent"] = value
	} else if total, exists := memory["SwapTotal"]; exists && total == 0 {
		metrics["swapPercent"] = float64(0)
	}
	if diskOK {
		metrics["diskPercent"] = disk
	}
	rx, tx, ok := sampler.networkRates(now, network)
	if ok {
		metrics["rxBytesPerSecond"] = rx
		metrics["txBytesPerSecond"] = tx
	}
	if len(metrics) == 0 {
		return nil
	}
	metrics["sampledAt"] = now.UTC().Format(time.RFC3339Nano)
	return metrics
}

func hostUsedPercent(memory map[string]int64, totalKey, availableKey string) (float64, bool) {
	total := memory[totalKey]
	available, ok := memory[availableKey]
	if !ok || total <= 0 || available < 0 || available > total {
		return 0, false
	}
	return roundPercent(float64(total-available) / float64(total) * 100), true
}

func (sampler *HostRealtimeSampler) networkRates(now time.Time, current map[string]hostNetworkCounter) (float64, float64, bool) {
	elapsed := now.Sub(sampler.networkAt).Seconds()
	previous := sampler.network
	sampler.networkAt, sampler.network = now, current
	if elapsed <= 0 || len(current) == 0 || len(previous) != len(current) {
		return 0, 0, false
	}

	// Compare each interface before summing so other links cannot hide a counter reset.
	var rx, tx float64
	for name, counters := range current {
		before, exists := previous[name]
		if !exists || counters.rx < before.rx || counters.tx < before.tx {
			return 0, 0, false
		}
		rx += float64(counters.rx - before.rx)
		tx += float64(counters.tx - before.tx)
	}
	return rx / elapsed, tx / elapsed, true
}
