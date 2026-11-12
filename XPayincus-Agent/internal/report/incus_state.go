package report

import "encoding/json"

type incusInstanceState struct {
	Status    string                        `json:"status"`
	Network   map[string]incusNetworkDevice `json:"network"`
	PID       int64                         `json:"pid"`
	StartedAt string                        `json:"started_at"`
	CPU       struct {
		Usage json.Number `json:"usage"`
	} `json:"cpu"`
	Memory struct {
		Usage json.Number `json:"usage"`
	} `json:"memory"`
	Disk map[string]struct {
		Counters *struct {
			ReadBytes  json.Number `json:"bytes_read"`
			WriteBytes json.Number `json:"bytes_written"`
		} `json:"counters"`
	} `json:"disk"`
}

type incusNetworkDevice struct {
	Addresses []incusNetworkAddress `json:"addresses"`
	Hwaddr    string                `json:"hwaddr"`
	Counters  incusNetworkCounters  `json:"counters"`
	State     string                `json:"state"`
}

type incusNetworkAddress struct {
	Family  string `json:"family"`
	Address string `json:"address"`
}

type incusNetworkCounters struct {
	BytesReceived json.Number `json:"bytes_received"`
	BytesSent     json.Number `json:"bytes_sent"`
}
