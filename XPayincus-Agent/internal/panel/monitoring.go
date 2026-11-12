package panel

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"time"
)

func semanticComponent(value any) any {
	switch item := value.(type) {
	case map[string]any:
		result := map[string]any{}
		for key, child := range item {
			switch key {
			case "collectedAt", "collectedAtUnix", "observedAt", "reportedAt", "timestamp", "source":
				continue
			}
			result[key] = semanticComponent(child)
		}
		return result
	case []any:
		result := make([]any, len(item))
		for index, child := range item {
			result[index] = semanticComponent(child)
		}
		sort.SliceStable(result, func(i, j int) bool {
			left, _ := json.Marshal(result[i])
			right, _ := json.Marshal(result[j])
			return string(left) < string(right)
		})
		return result
	default:
		return value
	}
}

func selectFields(value any, keys ...string) map[string]any {
	object, _ := value.(map[string]any)
	result := map[string]any{}
	for _, key := range keys {
		if child, ok := object[key]; ok {
			result[key] = child
		}
	}
	return result
}

func componentSummary(value map[string]any) map[string]any {
	result := map[string]any{}
	for _, name := range []string{"rfw", "zfs"} {
		wrapper, _ := value[name].(map[string]any)
		status, _ := wrapper["status"].(map[string]any)
		summary := selectFields(wrapper, "available")
		if name == "rfw" {
			summary["status"] = selectFields(status, "actualXdpAttached", "rfwGeneration", "ownership")
		} else {
			stable := selectFields(status, "kernel", "moduleLoaded", "moduleVersion")
			stable["nextKernel"] = selectFields(status["nextKernel"], "kernel", "ready", "loadTested", "moduleVersion", "vermagic")
			pools := []any{}
			if items, ok := status["pools"].([]any); ok {
				for _, raw := range items {
					pool, _ := raw.(map[string]any)
					item := selectFields(pool, "name", "health", "errors", "devices")
					item["scan"] = selectFields(pool["scan"], "scrub", "resilver", "inProgress")
					pools = append(pools, item)
				}
			}
			stable["pools"] = pools
			summary["status"] = stable
		}
		result[name] = summary
	}
	return result
}

type componentCheckpoint struct {
	SchemaVersion int             `json:"schemaVersion"`
	Components    json.RawMessage `json:"components"`
	Pending       map[string]any  `json:"pending,omitempty"`
}

func writeComponentCheckpoint(path string, checkpoint componentCheckpoint) error {
	body, err := json.Marshal(checkpoint)
	if err != nil {
		return err
	}
	if len(body) > 256*1024 {
		return fmt.Errorf("component checkpoint exceeds capacity")
	}
	file, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(body)
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		directory, err := os.Open(filepath.Dir(path))
		if err != nil {
			return err
		}
		defer directory.Close()
		return directory.Sync()
	}
	return nil
}

func (client *Client) queueComponentChange(components map[string]any) error {
	if err := os.MkdirAll(client.spoolDir, 0700); err != nil {
		return err
	}
	path := filepath.Join(client.spoolDir, "components.state")
	checkpoint := componentCheckpoint{SchemaVersion: 2}
	previous, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if len(previous) > 256*1024 {
		return fmt.Errorf("component checkpoint exceeds capacity")
	}
	if len(previous) > 0 {
		if err := json.Unmarshal(previous, &checkpoint); err != nil {
			return err
		}
		if checkpoint.SchemaVersion != 2 {
			checkpoint = componentCheckpoint{SchemaVersion: 2, Components: previous}
		}
	}
	flush := func() error {
		if checkpoint.Pending == nil {
			return nil
		}
		if _, err := client.queueRecord(checkpoint.Pending, 256*1024, 384*1024); err != nil {
			return err
		}
		checkpoint.Pending = nil
		return writeComponentCheckpoint(path, checkpoint)
	}
	if err := flush(); err != nil {
		return err
	}
	semantic := semanticComponent(componentSummary(components))
	encoded, err := json.Marshal(semantic)
	if err != nil {
		return err
	}
	if string(checkpoint.Components) == string(encoded) {
		return nil
	}
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil {
		return err
	}
	id := hex.EncodeToString(idBytes)
	at := time.Now().UTC().Format(time.RFC3339Nano)
	checkpoint.Components = encoded
	event := map[string]any{"id": id, "sampledAt": at, "type": "component-state", "components": semantic}
	checkpoint.Pending = map[string]any{"id": id, "sampledAt": at, "events": []any{event}}
	if err := writeComponentCheckpoint(path, checkpoint); err != nil {
		return err
	}
	return flush()
}

func (client *Client) queueMonitoring(payload map[string]any) ([]map[string]any, error) {
	components, _ := payload["components"].(map[string]any)
	if err := client.queueComponentChange(components); err != nil {
		return nil, err
	}
	instanceReport, _ := payload["instances"].(map[string]any)
	items, _ := instanceReport["items"].([]any)
	instances := make([]any, 0, len(items))
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if performance, ok := item["performance"].(map[string]any); ok {
			instances = append(instances, map[string]any{"name": item["name"], "sampledAt": item["sampledAt"], "intervalSeconds": performance["intervalSeconds"], "metrics": selectFields(performance, "cpuUsagePercent", "memoryUsedBytes", "diskReadBytesPerSecond", "diskWriteBytesPerSecond", "diskIOBytesPerSecond")})
		}
	}
	return client.queueRecord(map[string]any{
		"resources": payload["resources"], "metrics": payload["metrics"],
		"instances": instances,
	}, 256*1024, 384*1024)
}
