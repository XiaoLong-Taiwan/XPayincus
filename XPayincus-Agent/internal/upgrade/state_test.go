package upgrade

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/panel"
)

func TestUpgradeHealthRequiresNewProcessAndExplicitConfirmation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.json")
	runner := &Runner{StatePath: path}
	if err := runner.recordOperation("operation", "v2.0.0", "awaiting-health", ""); err != nil { t.Fatal(err) }
	if err := ConfirmHealthy(path, "v2.0.0"); err != nil { t.Fatal(err) }
	state, err := ReadOperation(path, "v2.0.0")
	if err != nil || state.Phase != "awaiting-health" { t.Fatalf("old process confirmed health: %#v %v", state, err) }
	state.ProcessID = "previous-process"
	if err := writeOperation(path, *state); err != nil { t.Fatal(err) }
	if err := ConfirmHealthy(path, "v1.0.0"); err != nil { t.Fatal(err) }
	state, _ = ReadOperation(path, "v1.0.0")
	if state.Phase != "awaiting-health" { t.Fatal("wrong version confirmed health") }
	if err := ConfirmHealthy(path, "v2.0.0"); err != nil { t.Fatal(err) }
	state, err = ReadOperation(path, "v2.0.0")
	if err != nil || state.Phase != "healthy" { t.Fatalf("missing confirmation: %#v %v", state, err) }
}

func TestUpgradeScheduleDeduplicatesAndPersistsTimeout(t *testing.T) {
	runner := &Runner{StatePath: filepath.Join(t.TempDir(), "upgrade.json")}
	instruction := panel.UpgradeInstruction{OperationID: "operation", Version: "v2.0.0"}
	if ok, err := runner.Schedule(instruction, "v1.0.0"); err != nil || !ok { t.Fatalf("schedule: %t %v", ok, err) }
	if ok, err := runner.Schedule(instruction, "v1.0.0"); err != nil || ok { t.Fatalf("duplicate scheduled: %t %v", ok, err) }
	state, _ := ReadOperation(runner.StatePath, "v1.0.0")
	state.UpdatedAt = time.Now().Add(-16*time.Minute).UTC().Format(time.RFC3339Nano)
	if err := writeOperation(runner.StatePath, *state); err != nil { t.Fatal(err) }
	state, err := ReadOperation(runner.StatePath, "v1.0.0")
	if err != nil || state.Phase != "failed" || state.Error == "" { t.Fatalf("timeout lost: %#v %v", state, err) }
}
