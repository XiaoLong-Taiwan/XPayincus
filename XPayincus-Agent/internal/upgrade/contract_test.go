package upgrade

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/panel"
)

func TestInstructionContract(t *testing.T) {
	one, two := 1, 2
	minimum := "v2.0.0"
	base := panel.UpgradeInstruction{Available: true, Version: "v1.1.0", SHA256: sha256Hex([]byte("binary"))}
	if err := validateInstruction(base, "v1.0.3"); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*panel.UpgradeInstruction){
		func(i *panel.UpgradeInstruction) { i.SchemaVersion = &two },
		func(i *panel.UpgradeInstruction) { i.MinimumUpdaterVersion = &minimum },
		func(i *panel.UpgradeInstruction) { i.Version = "v0.9.0" },
		func(i *panel.UpgradeInstruction) { i.Version = "v01.1.0" },
		func(i *panel.UpgradeInstruction) { i.SchemaVersion = &one },
		func(i *panel.UpgradeInstruction) { i.Platform = "unsupported" },
		func(i *panel.UpgradeInstruction) { i.Arch = "unsupported" },
	} {
		value := base
		mutate(&value)
		if err := validateInstruction(value, "v1.0.3"); err == nil {
			t.Fatalf("accepted incompatible instruction: %+v", value)
		}
	}
	base.SchemaVersion, base.Platform, base.Arch = &one, runtime.GOOS, runtime.GOARCH
	if err := validateInstruction(base, "v1.0.3"); err != nil {
		t.Fatal(err)
	}
	for _, pair := range [][2]string{{"v1.10.0", "v1.9.0"}, {"v1.0.0", "v1.0.0-rc.2"}, {"v1.0.0-rc.10", "v1.0.0-rc.2"}} {
		order, err := compareVersions(pair[0], pair[1])
		if err != nil || order <= 0 {
			t.Fatalf("invalid ordering %v: %d %v", pair, order, err)
		}
	}
}

func TestDownloadRejectsCrossOriginRedirect(t *testing.T) {
	visited := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { visited = true }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer source.Close()
	runner := Runner{AllowedBaseURL: source.URL, HTTPClient: source.Client()}
	if _, err := runner.download(context.Background(), source.URL); err == nil {
		t.Fatal("accepted redirect")
	}
	if visited {
		t.Fatal("contacted redirect target")
	}
}

func TestRejectedDownloadPreservesBinary(t *testing.T) {
	for _, size := range []int64{1, 100} {
		t.Run(string(rune(size)), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "agent")
			if err := os.WriteFile(path, []byte("old"), 0755); err != nil {
				t.Fatal(err)
			}
			payload := []byte("payload")
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(payload) }))
			defer server.Close()
			runner := Runner{BinaryPath: path, LockPath: filepath.Join(dir, "lock"), AllowedBaseURL: server.URL, MaxDownloadBytes: size}
			err := runner.Apply(context.Background(), panel.UpgradeInstruction{Available: true, Version: "v1.1.0", URL: server.URL, SHA256: sha256Hex(payload), Size: 2}, "v1.0.3")
			if err == nil {
				t.Fatal("accepted oversized or wrong-size download")
			}
			body, _ := os.ReadFile(path)
			if string(body) != "old" {
				t.Fatal("changed binary on rejected download")
			}
		})
	}
}
