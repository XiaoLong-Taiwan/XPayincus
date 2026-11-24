package report

import (
	"regexp"
	"time"
)

const realtimeSampleMaxAge = 2 * time.Minute

var realtimeInstanceNamePattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
var incusUUIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)

var realtimeMetricKeys = []string{"cpuUsagePercent", "memoryUsedBytes", "diskReadBytesPerSecond", "diskWriteBytesPerSecond", "diskIOBytesPerSecond", "rxBytesPerSecond", "txBytesPerSecond"}

func RealtimeInstancePayload(intervalSeconds int) map[string]any {
	return realtimeInstancePayload(intervalSeconds, time.Now())
}

func realtimeInstancePayload(intervalSeconds int, now time.Time) map[string]any {
	instances := cachedInstances()
	items, _ := instances["items"].([]any)
	if len(items) > 500 {
		items = items[:500]
	}
	projected := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, ok := item["name"].(string)
		if !ok || !realtimeInstanceNamePattern.MatchString(name) {
			continue
		}
		performance, _ := item["performance"].(map[string]any)
		metrics := map[string]any{}
		for _, key := range realtimeMetricKeys {
			if value, exists := performance[key]; exists {
				metrics[key] = value
			}
		}
		sampledAt, _ := item["sampledAt"].(string)
		sampledTime, err := time.Parse(time.RFC3339Nano, sampledAt)
		if err != nil || sampledTime.After(now.Add(time.Minute)) || now.Sub(sampledTime) > realtimeSampleMaxAge {
			continue
		}
		projectedItem := map[string]any{
			"name": name, "sampledAt": sampledAt,
			"metrics": metrics,
		}
		if incusID, ok := item["incusId"].(string); ok && incusUUIDPattern.MatchString(incusID) {
			projectedItem["incusId"] = incusID
		}
		projected = append(projected, projectedItem)
	}
	return map[string]any{"schemaVersion": 1, "sampledAt": now.UTC().Format(time.RFC3339Nano), "intervalSeconds": intervalSeconds, "instances": projected}
}
