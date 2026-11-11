package report

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"sync"
	"time"
)

var collector struct {
	sync.RWMutex
	instances map[string]any
}

func StartCollector(ctx context.Context, interval time.Duration) {
	go func() {
		for {
			value := collectIncusInstanceReport()
			collector.Lock()
			collector.instances = value
			collector.Unlock()
			timer := time.NewTimer(interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
}

func cachedInstances() map[string]any {
	collector.RLock()
	defer collector.RUnlock()
	if collector.instances == nil {
		return map[string]any{"available": false, "reportedAt": time.Now().UTC().Format(time.RFC3339), "total": 0, "items": []any{}, "status": "starting"}
	}
	return collector.instances
}

func componentStatus() map[string]any {
	result := map[string]any{}
	for _, name := range []string{"rfw", "zfs"} {
		path := os.Getenv("INCUDAL_" + map[string]string{"rfw": "RFW", "zfs": "ZFS"}[name] + "_STATUS_FILE")
		if path == "" {
			path = "/run/xpayincus/" + name + "-status.json"
		}
		status := map[string]any{"available": false, "source": path, "readOnly": true}
		info, statErr := os.Lstat(path)
		if statErr != nil || !info.Mode().IsRegular() || info.Size() > 65536 {
			result[name] = status
			continue
		}
		file, err := os.Open(path)
		if err == nil {
			info, statErr := file.Stat()
			if statErr == nil && info.Mode().IsRegular() && info.Size() <= 65536 && time.Since(info.ModTime()) >= 0 && time.Since(info.ModTime()) < 5*time.Minute {
				var value map[string]any
				if json.NewDecoder(io.LimitReader(file, 65537)).Decode(&value) == nil && value["schemaVersion"] == float64(1) && (value["readOnly"] == true || (name == "rfw" && value["collectedAtUnix"] != nil)) {
					observed := time.Time{}
					if text, ok := value["collectedAt"].(string); ok { observed, _ = time.Parse(time.RFC3339Nano, text) }
					if seconds, ok := value["collectedAtUnix"].(float64); ok { observed = time.Unix(int64(seconds), 0) }
					if !observed.IsZero() && time.Since(observed) >= -time.Minute && time.Since(observed) < 5*time.Minute {
						status["available"] = true
						status["status"] = value
						status["observedAt"] = observed.UTC().Format(time.RFC3339)
					}
				}
			}
			file.Close()
		}
		result[name] = status
	}
	return result
}
