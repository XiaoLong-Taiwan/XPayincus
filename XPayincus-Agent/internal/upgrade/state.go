package upgrade

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/panel"
)

type OperationState struct {
	OperationID string `json:"operationId"`
	TargetVersion string `json:"targetVersion"`
	Phase string `json:"phase"`
	Error string `json:"error,omitempty"`
	UpdatedAt string `json:"updatedAt"`
	ProcessID string `json:"processId,omitempty"`
}

var processID = time.Now().UTC().Format(time.RFC3339Nano)

var operationMu sync.Mutex

func ReadOperation(path string, version string) (*OperationState, error) {
	operationMu.Lock()
	defer operationMu.Unlock()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) { return nil, nil }
	if err != nil { return nil, err }
	var state OperationState
	if err := json.Unmarshal(data, &state); err != nil { return nil, err }
	if state.Phase != "healthy" && state.Phase != "failed" {
		updated, parseErr := time.Parse(time.RFC3339Nano, state.UpdatedAt)
		if parseErr != nil || time.Since(updated) > 15*time.Minute {
			state.Phase, state.Error = "failed", "upgrade interrupted or health confirmation timed out"
			state.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			if err := writeOperation(path, state); err != nil { return nil, err }
		}
	}
	return &state, nil
}

func writeOperation(path string, state OperationState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil { return err }
	data, err := json.Marshal(state)
	if err != nil { return err }
	file, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil { return err }
	_, err = file.Write(data)
	if err == nil { err = file.Sync() }
	closeErr := file.Close()
	if err != nil { return err }
	if closeErr != nil { return closeErr }
	if err := os.Rename(path+".tmp", path); err != nil { return err }
	if runtime.GOOS != "windows" {
		directory, err := os.Open(filepath.Dir(path))
		if err != nil { return err }
		err = directory.Sync()
		directory.Close()
		return err
	}
	return nil
}

func (runner *Runner) recordOperation(id, version, phase, failure string) error {
	if runner.StatePath == "" || id == "" { return nil }
	operationMu.Lock()
	defer operationMu.Unlock()
	return writeOperation(runner.StatePath, OperationState{OperationID: id, TargetVersion: version, Phase: phase, Error: failure, UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano), ProcessID: processID})
}

func ConfirmHealthy(path, version string) error {
	operationMu.Lock()
	defer operationMu.Unlock()
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) { return nil }
	if err != nil { return err }
	var state OperationState
	if err := json.Unmarshal(data, &state); err != nil { return err }
	if state.TargetVersion != version || state.Phase != "awaiting-health" || state.ProcessID == processID { return nil }
	state.Phase = "healthy"
	state.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return writeOperation(path, state)
}

func (runner *Runner) Schedule(instruction panel.UpgradeInstruction, version string) (bool, error) {
	if runner.StatePath == "" { return true, nil }
	state, err := ReadOperation(runner.StatePath, version)
	if err != nil { return false, err }
	if instruction.OperationID != "" && state != nil && state.OperationID == instruction.OperationID { return false, nil }
	if err := runner.recordOperation(instruction.OperationID, instruction.Version, "scheduled", ""); err != nil { return false, err }
	return true, nil
}
