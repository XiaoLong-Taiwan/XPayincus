package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadClampsMonitoringInterval(t *testing.T) {
	for _, tt := range []struct { name, value string; expected int }{
		{name: "default", value: "", expected: DefaultMonitoringIntervalSeconds},
		{name: "low", value: "0", expected: 1},
		{name: "high", value: "120", expected: 60},
		{name: "valid", value: "5", expected: 5},
	} {
		t.Run(tt.name, func(t *testing.T) {
			path := writeTestConfig(t, "60")
			content, err := os.ReadFile(path)
			if err != nil { t.Fatal(err) }
			content = append(content, []byte("monitoring_interval_seconds: "+tt.value+"\n")...)
			if err := os.WriteFile(path, content, 0600); err != nil { t.Fatal(err) }
			cfg, err := Load(path)
			if err != nil { t.Fatalf("load config: %v", err) }
			if cfg.MonitoringIntervalSeconds != tt.expected { t.Fatalf("monitoring seconds mismatch: got=%d want=%d", cfg.MonitoringIntervalSeconds, tt.expected) }
		})
	}
}

func TestLoadClampsHeartbeatInterval(t *testing.T) {
	tests := []struct {
		name     string
		value    string
		expected int
	}{
		{name: "too low", value: "1", expected: MinHeartbeatIntervalSeconds},
		{name: "too high", value: "7200", expected: MaxHeartbeatIntervalSeconds},
		{name: "valid", value: "60", expected: 60},
		{name: "invalid", value: "invalid", expected: DefaultHeartbeatIntervalSeconds},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			configPath := writeTestConfig(t, tt.value)
			cfg, err := Load(configPath)
			if err != nil {
				t.Fatalf("load config: %v", err)
			}
			if cfg.HeartbeatIntervalSeconds != tt.expected {
				t.Fatalf("heartbeat seconds mismatch: got=%d want=%d", cfg.HeartbeatIntervalSeconds, tt.expected)
			}
			if cfg.HeartbeatInterval != time.Duration(tt.expected)*time.Second {
				t.Fatalf("heartbeat interval mismatch: got=%s want=%s", cfg.HeartbeatInterval, time.Duration(tt.expected)*time.Second)
			}
		})
	}
}

func writeTestConfig(t *testing.T, heartbeatInterval string) string {
	t.Helper()

	path := filepath.Join(t.TempDir(), "config.yaml")
	content := "panel_url: \"https://panel.example\"\n" +
		"agent_id: \"agt_test\"\n" +
		"agent_secret: \"ias_test\"\n" +
		"state_dir: \"" + filepath.Join(t.TempDir(), "state") + "\"\n" +
		"heartbeat_interval_seconds: " + heartbeatInterval + "\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}
