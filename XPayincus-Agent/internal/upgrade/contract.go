package upgrade

import (
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"runtime"
	"strings"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/panel"
)

var versionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$`)

func parseVersion(value string) ([]string, error) {
	parts := versionPattern.FindStringSubmatch(value)
	if parts == nil {
		return nil, fmt.Errorf("invalid release version: %s", value)
	}
	for index, part := range parts[4:] {
		if part == "" {
			continue
		}
		for _, id := range strings.Split(part, ".") {
			if id == "" || (index == 0 && numeric(id) && len(id) > 1 && id[0] == '0') {
				return nil, errors.New("invalid release version identifier")
			}
		}
	}
	return parts[1:5], nil
}

func numeric(value string) bool {
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return value != ""
}

func compareNumber(a, b string) int {
	if len(a) < len(b) {
		return -1
	}
	if len(a) > len(b) {
		return 1
	}
	return strings.Compare(a, b)
}

func compareVersions(a, b string) (int, error) {
	x, err := parseVersion(a)
	if err != nil {
		return 0, err
	}
	y, err := parseVersion(b)
	if err != nil {
		return 0, err
	}
	for i := 0; i < 3; i++ {
		if n := compareNumber(x[i], y[i]); n != 0 {
			return n, nil
		}
	}
	if x[3] == y[3] {
		return 0, nil
	}
	if x[3] == "" {
		return 1, nil
	}
	if y[3] == "" {
		return -1, nil
	}
	xp, yp := strings.Split(x[3], "."), strings.Split(y[3], ".")
	for i, left := range xp {
		if i >= len(yp) {
			return 1, nil
		}
		right := yp[i]
		if left == right {
			continue
		}
		if numeric(left) && numeric(right) {
			return compareNumber(left, right), nil
		}
		if numeric(left) {
			return -1, nil
		}
		if numeric(right) {
			return 1, nil
		}
		return strings.Compare(left, right), nil
	}
	return -1, nil
}

func validateInstruction(instruction panel.UpgradeInstruction, current string) error {
	if instruction.SchemaVersion != nil && *instruction.SchemaVersion != 1 {
		return fmt.Errorf("unsupported upgrade schemaVersion: %d", *instruction.SchemaVersion)
	}
	if instruction.MinimumUpdaterVersion != nil {
		order, err := compareVersions(current, *instruction.MinimumUpdaterVersion)
		if err != nil {
			return err
		}
		if order < 0 {
			return fmt.Errorf("updater %s is below minimumUpdaterVersion %s", current, *instruction.MinimumUpdaterVersion)
		}
	}
	order, err := compareVersions(instruction.Version, current)
	if err != nil {
		return err
	}
	if order < 0 {
		return errors.New("upgrade downgrade rejected")
	}
	if instruction.SchemaVersion != nil && (instruction.Platform == "" || instruction.Arch == "") {
		return errors.New("upgrade platform/arch required for schema 1")
	}
	if (instruction.Platform != "" && instruction.Platform != runtime.GOOS) ||
		(instruction.Arch != "" && instruction.Arch != runtime.GOARCH) {
		return errors.New("upgrade platform/arch mismatch")
	}
	if instruction.Size < 0 {
		return errors.New("invalid upgrade size")
	}
	if len(instruction.SHA256) != 64 {
		return errors.New("invalid upgrade sha256")
	}
	if _, err := hex.DecodeString(instruction.SHA256); err != nil {
		return errors.New("invalid upgrade sha256")
	}
	return nil
}
