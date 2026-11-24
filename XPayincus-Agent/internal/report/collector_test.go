package report

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestIncusCollectionReportsExpiredContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	report := collectIncusInstanceReportContext(ctx)
	if report["available"] != false || report["deadlineExceeded"] != true {
		t.Fatalf("expired collection context was not reported: %#v", report)
	}
}

func TestCollectorPublishesCompletedSnapshotAtomically(t *testing.T) {
	previous := cachedInstances()
	t.Cleanup(func() { replaceCachedInstances(previous) })
	want := map[string]any{"available": true, "items": []any{map[string]any{"name": "vm1"}}}
	publishInstanceReport(want)
	got := cachedInstances()
	if got["available"] != true || len(got["items"].([]any)) != 1 {
		t.Fatalf("collector snapshot was not published: %#v", got)
	}
}

func TestCollectorKeepsPreviousSnapshotWithoutUsableInventory(t *testing.T) {
	previous := cachedInstances()
	t.Cleanup(func() { replaceCachedInstances(previous) })
	publishInstanceReport(map[string]any{"available": true, "items": []any{map[string]any{"name": "vm1"}}})
	tests := []struct {
		name   string
		report map[string]any
	}{
		{name: "unavailable", report: map[string]any{"available": false, "items": []any{}}},
		{name: "deadline exceeded", report: map[string]any{"available": true, "deadlineExceeded": true, "items": []any{}}},
		{name: "invalid item", report: map[string]any{"available": true, "items": []any{"vm1"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			publishInstanceReport(test.report)
			items := cachedInstances()["items"].([]any)
			if len(items) != 1 || items[0].(map[string]any)["name"] != "vm1" {
				t.Fatalf("previous inventory was overwritten: %#v", items)
			}
		})
	}
	publishInstanceReport(map[string]any{"available": true, "items": []any{}})
	if items := cachedInstances()["items"].([]any); len(items) != 0 {
		t.Fatalf("empty inventory did not clear previous instances: %#v", items)
	}
}

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
