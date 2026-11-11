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
	"strings"
	"time"
)

func (client *Client) queueSample(payload map[string]any) ([]map[string]any, error) {
	if err := os.MkdirAll(client.spoolDir, 0700); err != nil { return nil, err }
	idBytes := make([]byte, 16)
	if _, err := rand.Read(idBytes); err != nil { return nil, err }
	id := hex.EncodeToString(idBytes)
	now := time.Now()
	sample := map[string]any{"id": id, "sampledAt": now.UTC().Format(time.RFC3339Nano), "resources": payload["resources"], "metrics": payload["metrics"]}
	body, err := json.Marshal(sample)
	if err != nil { return nil, err }
	if len(body) > 65536 || int64(len(body)) > client.spoolMaxBytes { return nil, fmt.Errorf("history sample exceeds capacity") }
	entries, err := os.ReadDir(client.spoolDir)
	if err != nil { return nil, err }
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	total := int64(len(body))
	kept := make([]string, 0)
	for index := len(entries)-1; index >= 0; index-- {
		entry := entries[index]
		if !strings.HasSuffix(entry.Name(), ".json") && !strings.HasSuffix(entry.Name(), ".tmp") { continue }
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() { continue }
		entryPath := filepath.Join(client.spoolDir, entry.Name())
		if strings.HasSuffix(entry.Name(), ".tmp") || now.Sub(info.ModTime()) > client.spoolRetention || info.Size() > 65536 || total+info.Size() > client.spoolMaxBytes || len(kept) >= 8191 {
			if err := os.Remove(entryPath); err != nil { return nil, err }
			continue
		}
		total += info.Size()
		kept = append(kept, entryPath)
	}
	path := filepath.Join(client.spoolDir, fmt.Sprintf("%020d-%s.json", now.UnixNano(), id))
	file, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil { return nil, err }
	_, err = file.Write(body)
	if err == nil { err = file.Sync() }
	closeErr := file.Close()
	if err != nil { return nil, err }
	if closeErr != nil { return nil, closeErr }
	if err := os.Rename(path+".tmp", path); err != nil { return nil, err }
	if runtime.GOOS != "windows" {
		directory, err := os.Open(client.spoolDir)
		if err != nil { return nil, err }
		err = directory.Sync()
		directory.Close()
		if err != nil { return nil, err }
	}
	kept = append(kept, path)
	sort.Strings(kept)
	samples := make([]map[string]any, 0, 32)
	client.pendingSamples = map[string]string{}
	for _, entryPath := range kept {
		if len(samples) >= 32 { break }
		data, err := os.ReadFile(entryPath)
		if err != nil { return nil, err }
		var value map[string]any
		if json.Unmarshal(data, &value) != nil {
			if err := os.Remove(entryPath); err != nil { return nil, err }
			continue
		}
		sampleID, ok := value["id"].(string)
		decodedID, decodeErr := hex.DecodeString(sampleID)
		_, timeErr := time.Parse(time.RFC3339Nano, fmt.Sprint(value["sampledAt"]))
		if !ok || decodeErr != nil || len(decodedID) != 16 || timeErr != nil {
			if err := os.Remove(entryPath); err != nil { return nil, err }
			continue
		}
		client.pendingSamples[sampleID] = entryPath
		samples = append(samples, value)
	}
	return samples, nil
}
