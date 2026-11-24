package panel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/config"
	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/protocol"
)

const (
	heartbeatPath = "/api/agent/heartbeat"
	realtimePath  = "/api/agent/monitoring/realtime"
)

type Client struct {
	panelURL       string
	agentID        string
	agentSecret    string
	httpClient     *http.Client
	spoolDir       string
	spoolMaxBytes  int64
	spoolRetention time.Duration
	pendingSamples map[string]string
	monitoring     *Client
}

type HeartbeatResult struct {
	StatusCode int
	Body       string
	OK         bool
	Upgrade    *UpgradeInstruction
	LatencyMs  int64
}

type UpgradeInstruction struct {
	OperationID           string  `json:"operationId,omitempty"`
	SchemaVersion         *int    `json:"schemaVersion,omitempty"`
	MinimumUpdaterVersion *string `json:"minimumUpdaterVersion,omitempty"`
	Platform              string  `json:"platform,omitempty"`
	Arch                  string  `json:"arch,omitempty"`
	Error                 string  `json:"error,omitempty"`
	Available             bool    `json:"available"`
	Version               string  `json:"version"`
	URL                   string  `json:"url"`
	SHA256                string  `json:"sha256"`
	Gzip                  bool    `json:"gzip"`
	Size                  int64   `json:"size"`
}

type heartbeatResponse struct {
	AcceptedSampleIDs []string `json:"acceptedSampleIds"`
	MonitoringAck     *struct {
		SchemaVersion     int      `json:"schemaVersion"`
		AcceptedSampleIDs []string `json:"acceptedSampleIds"`
	} `json:"monitoringAck"`
	Upgrade *UpgradeInstruction `json:"upgrade"`
}

func (instruction *UpgradeInstruction) UnmarshalJSON(data []byte) error {
	type wireInstruction UpgradeInstruction
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for _, key := range []string{"schemaVersion", "minimumUpdaterVersion", "platform", "arch", "size", "gzip", "operationId"} {
		if raw, exists := fields[key]; exists && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("invalid upgrade %s: null", key)
		}
	}
	var value wireInstruction
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*instruction = UpgradeInstruction(value)
	return nil
}

func New(cfg config.Config) *Client {
	if cfg.StateDir == "" {
		cfg.StateDir = "/var/lib/incudal-agent"
	}
	if cfg.SpoolMaxBytes <= 0 {
		cfg.SpoolMaxBytes = 16 * 1024 * 1024
	}
	if cfg.SpoolRetentionHours <= 0 {
		cfg.SpoolRetentionHours = 72
	}
	return &Client{
		monitoring:     &Client{spoolDir: filepath.Join(cfg.StateDir, "monitoring-v2"), spoolMaxBytes: int64(cfg.SpoolMaxBytes), spoolRetention: time.Duration(cfg.SpoolRetentionHours) * time.Hour},
		spoolDir:       filepath.Join(cfg.StateDir, "history"),
		spoolMaxBytes:  int64(cfg.SpoolMaxBytes),
		spoolRetention: time.Duration(cfg.SpoolRetentionHours) * time.Hour,
		panelURL:       strings.TrimRight(cfg.PanelURL, "/"),
		agentID:        cfg.AgentID,
		agentSecret:    cfg.AgentSecret,
		httpClient: &http.Client{
			Timeout: cfg.RequestTimeout,
		},
	}
}

func (client *Client) RealtimeMonitoring(ctx context.Context, payload map[string]any) error {
	body, err := protocol.CanonicalJSON(payload)
	if err != nil {
		return err
	}
	if len(body) > 400*1024 {
		return fmt.Errorf("realtime monitoring payload exceeds limit")
	}
	response, err := client.doSignedRequest(ctx, realtimePath, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, err = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("realtime monitoring failed: status=%d retryable=%t", response.StatusCode, isRetryableStatus(response.StatusCode))
	}
	return nil
}

func (client *Client) Heartbeat(ctx context.Context, payload map[string]any) (HeartbeatResult, error) {
	samples, spoolErr := client.queueSample(payload)
	if spoolErr == nil {
		payload["history"] = map[string]any{"schemaVersion": 1, "samples": samples}
	} else {
		payload["historyStatus"] = "spool-unavailable"
	}
	if client.monitoring != nil {
		if samples, err := client.monitoring.queueMonitoring(payload); err == nil {
			payload["monitoring"] = map[string]any{"schemaVersion": 2, "samples": samples}
		} else {
			payload["monitoringStatus"] = "spool-unavailable"
		}
	}
	body, err := protocol.CanonicalJSON(payload)
	if err != nil {
		return HeartbeatResult{}, err
	}

	startedAt := time.Now()
	response, err := client.doSignedRequest(ctx, heartbeatPath, body)
	if err != nil {
		return HeartbeatResult{}, err
	}
	defer response.Body.Close()

	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024))
	if err != nil {
		return HeartbeatResult{}, err
	}

	result := HeartbeatResult{
		StatusCode: response.StatusCode,
		Body:       string(responseBody),
		OK:         response.StatusCode >= 200 && response.StatusCode < 300,
		LatencyMs:  time.Since(startedAt).Milliseconds(),
	}
	if !result.OK {
		return result, fmt.Errorf("heartbeat failed: status=%d retryable=%t body=%s", response.StatusCode, isRetryableStatus(response.StatusCode), result.Body)
	}

	var parsedResponse heartbeatResponse
	if err := json.Unmarshal(responseBody, &parsedResponse); err != nil {
		return result, fmt.Errorf("invalid heartbeat upgrade response: %w", err)
	}
	result.Upgrade = parsedResponse.Upgrade
	for _, id := range parsedResponse.AcceptedSampleIDs {
		if path, ok := client.pendingSamples[id]; ok {
			_ = os.Remove(path)
		}
	}
	if client.monitoring != nil && parsedResponse.MonitoringAck != nil && parsedResponse.MonitoringAck.SchemaVersion == 2 {
		for _, id := range parsedResponse.MonitoringAck.AcceptedSampleIDs {
			if path, ok := client.monitoring.pendingSamples[id]; ok {
				_ = os.Remove(path)
			}
		}
	}

	var parsed map[string]any
	if err := json.Unmarshal(responseBody, &parsed); err == nil {
		parsed["latencyMs"] = result.LatencyMs
		if compact, err := json.Marshal(parsed); err == nil {
			result.Body = string(compact)
		}
	}
	return result, nil
}

func isRetryableStatus(status int) bool {
	return status == http.StatusBadGateway || status == 530 || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func (client *Client) doSignedRequest(ctx context.Context, path string, body []byte) (*http.Response, error) {
	const maxAttempts = 3
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		timestamp := protocol.NewTimestamp()
		nonce, err := protocol.NewNonce()
		if err != nil {
			return nil, err
		}
		bodyHash := protocol.BodySHA256(body)
		signature := protocol.Signature(client.agentSecret, protocol.SigningPayload(http.MethodPost, path, timestamp, nonce, bodyHash))
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.panelURL+path, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("x-incudal-agent-id", client.agentID)
		request.Header.Set("x-incudal-timestamp", timestamp)
		request.Header.Set("x-incudal-nonce", nonce)
		request.Header.Set("x-incudal-body-sha256", bodyHash)
		request.Header.Set("x-incudal-signature", signature)
		response, requestErr := client.httpClient.Do(request)
		if requestErr != nil {
			lastErr = requestErr
			if ctx.Err() != nil || !isRetryableRequestError(requestErr) || attempt+1 == maxAttempts {
				return nil, requestErr
			}
		} else {
			if !isRetryableStatus(response.StatusCode) || attempt+1 == maxAttempts {
				return response, nil
			}
			response.Body.Close()
			lastErr = fmt.Errorf("request failed: status=%d", response.StatusCode)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 250 * time.Millisecond):
		}
	}
	return nil, lastErr
}

func isRetryableRequestError(err error) bool {
	if err == nil {
		return false
	}
	var networkError net.Error
	return errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout())
}
