package panel

import (
	"encoding/json"
	"testing"
)

func TestUpgradeInstructionWireContract(t *testing.T) {
	for _, payload := range []string{
		`{"schemaVersion":null}`, `{"schemaVersion":"1"}`, `{"minimumUpdaterVersion":null}`,
		`{"size":null}`, `{"size":"10"}`, `{"platform":null}`, `{"gzip":null}`,
	} {
		var instruction UpgradeInstruction
		if err := json.Unmarshal([]byte(payload), &instruction); err == nil {
			t.Fatalf("accepted malformed instruction: %s", payload)
		}
	}
	for _, payload := range []string{`{"available":true}`, `{"schemaVersion":1,"futureOptionalField":true}`} {
		var instruction UpgradeInstruction
		if err := json.Unmarshal([]byte(payload), &instruction); err != nil {
			t.Fatal(err)
		}
	}
}
