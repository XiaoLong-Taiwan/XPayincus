package report

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestInstancePagesCoverMoreThanFiveHundred(t *testing.T) {
	instances := make([]incusInstanceSummary, 1201)
	for i := range instances { instances[i].Name = fmt.Sprintf("instance-%04d", i) }
	seen := map[string]bool{}
	for _, start := range []int{0, 500, 1000} {
		page := instancePage(instances, start)
		if len(page) != 500 { t.Fatalf("page length %d", len(page)) }
		for _, instance := range page { seen[instance.Name] = true }
	}
	if len(seen) != len(instances) { t.Fatalf("unvisited instances: %d", len(instances)-len(seen)) }
	if len(instancePage(nil, 0)) != 0 { t.Fatal("empty inventory returned items") }
}

func TestComponentStatusRejectsStaleSnapshots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zfs.json")
	t.Setenv("INCUDAL_ZFS_STATUS_FILE", path)
	write := func(at time.Time) {
		t.Helper()
		body := fmt.Sprintf(`{"schemaVersion":1,"readOnly":true,"collectedAt":%q,"moduleLoaded":false}`, at.UTC().Format(time.RFC3339Nano))
		if err := os.WriteFile(path, []byte(body), 0600); err != nil { t.Fatal(err) }
	}
	write(time.Now().Add(-10*time.Minute))
	if componentStatus()["zfs"].(map[string]any)["available"] != false { t.Fatal("stale snapshot accepted") }
	write(time.Now())
	if componentStatus()["zfs"].(map[string]any)["available"] != true { t.Fatal("fresh snapshot rejected") }
}
