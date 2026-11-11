package panel

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSpoolRetainsUnacknowledgedSamplesAcrossClientRestart(t *testing.T) {
	directory := t.TempDir()
	client := &Client{spoolDir: directory, spoolMaxBytes: 65536, spoolRetention: time.Hour}
	payload := map[string]any{"resources": map[string]any{"cpuTotal": 4}, "metrics": map[string]any{"load1": 1}}
	first, err := client.queueSample(payload)
	if err != nil || len(first) != 1 { t.Fatalf("first sample: %v %#v", err, first) }
	restarted := &Client{spoolDir: directory, spoolMaxBytes: 65536, spoolRetention: time.Hour}
	second, err := restarted.queueSample(payload)
	if err != nil || len(second) != 2 || second[0]["id"] != first[0]["id"] { t.Fatalf("lost queued sample: %v %#v", err, second) }
	if _, exists := second[0]["instances"]; exists { t.Fatal("history must not replay billable instance counters") }
}

func TestSpoolPrunesExpiredAndCorruptSamples(t *testing.T) {
	directory := t.TempDir()
	old := filepath.Join(directory, "00000000000000000001-old.json")
	broken := filepath.Join(directory, "00000000000000000002-broken.json")
	if err := os.WriteFile(old, []byte("{}"), 0600); err != nil { t.Fatal(err) }
	if err := os.WriteFile(broken, []byte("invalid"), 0600); err != nil { t.Fatal(err) }
	past := time.Now().Add(-2*time.Hour)
	if err := os.Chtimes(old, past, past); err != nil { t.Fatal(err) }
	client := &Client{spoolDir: directory, spoolMaxBytes: 65536, spoolRetention: time.Hour}
	samples, err := client.queueSample(map[string]any{})
	if err != nil || len(samples) != 1 { t.Fatalf("corrupt sample blocked queue: %v %#v", err, samples) }
	for _, path := range []string{old, broken} {
		if _, err := os.Stat(path); !os.IsNotExist(err) { t.Fatalf("sample not removed: %s %v", path, err) }
	}
}
