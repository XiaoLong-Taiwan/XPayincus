package tunnel

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/config"
	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/protocol"
	"github.com/gorilla/websocket"
)

const Path = "/api/agent/tunnel"
const MaxBody = 512 * 1024
const MaxFrame = 768 * 1024
const MaxWSData = 64 * 1024
const MaxConcurrent = 8
const IncusSocket = "/var/lib/incus/unix.socket"
const CaddyAddress = "127.0.0.1:2019"

type Frame struct {
	Type    string            `json:"type"`
	ID      string            `json:"id,omitempty"`
	Target  string            `json:"target,omitempty"`
	Method  string            `json:"method,omitempty"`
	Path    string            `json:"path,omitempty"`
	Body    string            `json:"body,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Status  int               `json:"status,omitempty"`
	Error   string            `json:"error,omitempty"`
	Timeout int               `json:"timeout,omitempty"`
	Binary  bool              `json:"binary,omitempty"`
	Version int               `json:"version,omitempty"`
	Seq     int               `json:"seq"`
}

var operationWS = regexp.MustCompile(`^/1\.0/operations/[A-Za-z0-9-]+/websocket$`)
var requestID = regexp.MustCompile(`^[a-f0-9-]{36}$`)

func ValidatePath(target, path string, ws bool) error {
	if len(path) > 8192 || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\\r\n#") {
		return errors.New("invalid path")
	}
	u, err := url.ParseRequestURI(path)
	if err != nil || u.IsAbs() || u.Host != "" {
		return errors.New("invalid path")
	}
	for _, part := range strings.Split(u.Path, "/") {
		if part == "." || part == ".." {
			return errors.New("invalid path")
		}
	}
	if ws {
		if target != "incus" || !operationWS.MatchString(u.Path) || len(u.Query()["secret"]) != 1 || len(u.Query()) != 1 || len(u.Query().Get("secret")) < 8 {
			return errors.New("invalid websocket path")
		}
	} else if target == "incus" {
		if u.Path != "/1.0" && !strings.HasPrefix(u.Path, "/1.0/") {
			return errors.New("invalid incus path")
		}
	} else if target == "caddy" {
		if u.Path != "/config/" && !strings.HasPrefix(u.Path, "/config/") && !strings.HasPrefix(u.Path, "/id/") {
			return errors.New("invalid caddy path")
		}
	} else {
		return errors.New("invalid target")
	}
	return nil
}

func localClient(target string) *http.Client {
	transport := &http.Transport{DisableKeepAlives: true, ResponseHeaderTimeout: 30 * time.Second, MaxResponseHeaderBytes: 16384}
	transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
		dialer := net.Dialer{Timeout: 5 * time.Second}
		if target == "incus" {
			return dialer.DialContext(ctx, "unix", IncusSocket)
		}
		return dialer.DialContext(ctx, "tcp", CaddyAddress)
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func Execute(ctx context.Context, f Frame, client *http.Client) Frame {
	result := Frame{Type: "response", ID: f.ID}
	if ValidatePath(f.Target, f.Path, false) != nil || !strings.Contains("|GET|POST|PUT|PATCH|DELETE|HEAD|", "|"+f.Method+"|") || f.Method == "" {
		result.Error = "INVALID_REQUEST"
		return result
	}
	body, err := base64.StdEncoding.Strict().DecodeString(f.Body)
	if err != nil || len(body) > MaxBody {
		result.Error = "BODY_LIMIT"
		return result
	}
	timeout := f.Timeout
	if timeout < 1 || timeout > 120000 {
		result.Error = "INVALID_TIMEOUT"
		return result
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, f.Method, "http://localhost"+f.Path, bytes.NewReader(body))
	if err != nil {
		result.Error = "INVALID_REQUEST"
		return result
	}
	if f.Target == "caddy" {
		req.Host = CaddyAddress
	}
	for k, v := range f.Headers {
		name := strings.ToLower(k)
		if len(v) > 4096 || strings.ContainsAny(v, "\r\n") || (name != "content-type" && name != "x-incus-name" && name != "x-incus-pool") {
			result.Error = "INVALID_HEADERS"
			return result
		}
		req.Header.Set(name, v)
	}
	response, err := client.Do(req)
	if err != nil {
		result.Error = "LOCAL_REQUEST_FAILED_OUTCOME_UNKNOWN"
		return result
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxBody+1))
	if err != nil || len(data) > MaxBody {
		result.Error = "RESPONSE_LIMIT_OR_READ_FAILED_OUTCOME_UNKNOWN"
		return result
	}
	result.Status = response.StatusCode
	result.Body = base64.StdEncoding.EncodeToString(data)
	result.Headers = map[string]string{"content-type": response.Header.Get("Content-Type")}
	return result
}

func endpoint(cfg config.Config) (string, error) {
	u, err := url.Parse(cfg.PanelURL)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", errors.New("tunnel requires HTTPS panel origin")
	}
	u.Scheme = "wss"
	u.Path = Path
	return u.String(), nil
}

func Run(ctx context.Context, cfg config.Config) {
	endpointURL, err := endpoint(cfg)
	if err != nil {
		log.Print("agent tunnel unavailable: requires HTTPS panel origin")
		return
	}
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err = connect(ctx, cfg, endpointURL)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			log.Print("agent tunnel disconnected; in-flight operations are not replayed")
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		jitter, _ := rand.Int(rand.Reader, big.NewInt(int64(backoff)))
		delay := backoff
		if jitter != nil {
			delay += time.Duration(jitter.Int64())
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		if backoff < 30*time.Second {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}

func connect(parent context.Context, cfg config.Config, endpointURL string) error {
	nonce, err := protocol.NewNonce()
	if err != nil {
		return err
	}
	timestamp := protocol.NewTimestamp()
	hash := protocol.BodySHA256(nil)
	headers := http.Header{}
	headers.Set("x-incudal-agent-id", cfg.AgentID)
	headers.Set("x-incudal-timestamp", timestamp)
	headers.Set("x-incudal-nonce", nonce)
	headers.Set("x-incudal-body-sha256", hash)
	headers.Set("x-incudal-signature", protocol.Signature(cfg.AgentSecret, protocol.SigningPayload("GET", Path, timestamp, nonce, hash)))
	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, Subprotocols: []string{"xpayincus-tunnel-v1"}}
	conn, response, err := dialer.DialContext(parent, endpointURL, headers)
	if response != nil && response.Body != nil {
		response.Body.Close()
	}
	if err != nil {
		return errors.New("tunnel handshake failed")
	}
	defer conn.Close()
	if conn.Subprotocol() != "xpayincus-tunnel-v1" {
		return errors.New("tunnel protocol mismatch")
	}
	return serveConnection(parent, conn, map[string]*http.Client{"incus": localClient("incus"), "caddy": localClient("caddy")})
}

func serveConnection(parent context.Context, conn *websocket.Conn, clients map[string]*http.Client) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	conn.SetReadLimit(MaxFrame)
	conn.SetReadDeadline(time.Now().Add(70 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(70 * time.Second)) })
	var writer sync.Mutex
	send := func(f Frame) error {
		writer.Lock()
		defer writer.Unlock()
		conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		return conn.WriteJSON(f)
	}
	var mu sync.Mutex
	active := map[string]context.CancelFunc{}
	streams := map[string]*websocket.Conn{}
	wsAcks := map[string]chan bool{}
	httpStreams := map[string]*httpStream{}
	defer func() {
		mu.Lock()
		defer mu.Unlock()
		for _, stop := range active {
			stop()
		}
		for _, stream := range streams {
			stream.Close()
		}
	}()
	go func() {
		ticker := time.NewTicker(25 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				conn.Close()
				return
			case <-ticker.C:
				writer.Lock()
				err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second))
				writer.Unlock()
				if err != nil {
					conn.Close()
					return
				}
			}
		}
	}()
	seen := map[string]bool{}
	for {
		var f Frame
		if err := conn.ReadJSON(&f); err != nil {
			return err
		}
		conn.SetReadDeadline(time.Now().Add(70 * time.Second))
		if f.Type == "hello" && f.Version == 1 {
			continue
		}
		if !requestID.MatchString(f.ID) {
			return errors.New("invalid request id")
		}
		if f.Type == "ws-ack" {
			mu.Lock()
			ack := wsAcks[f.ID]
			mu.Unlock()
			if ack != nil {
				select {
				case ack <- true:
				default:
					return errors.New("websocket ack overflow")
				}
			}
			continue
		}
		if f.Type == "http-upload" || f.Type == "http-upload-end" || f.Type == "http-credit" {
			mu.Lock()
			state := httpStreams[f.ID]
			mu.Unlock()
			if state == nil {
				continue
			}
			if f.Type == "http-credit" {
				select {
				case state.credit <- f.Seq:
				default:
					return errors.New("stream credit overflow")
				}
			} else {
				if len(f.Body) > ((ChunkSize+2)/3)*4 {
					return errors.New("stream chunk limit")
				}
				select {
				case state.input <- f:
				default:
					return errors.New("stream upload overflow")
				}
			}
			continue
		}
		if f.Type == "cancel" || f.Type == "ws-close" {
			mu.Lock()
			if stop := active[f.ID]; stop != nil {
				stop()
			}
			if stream := streams[f.ID]; stream != nil {
				stream.Close()
			}
			mu.Unlock()
			continue
		}
		if f.Type == "ws-data" {
			data, err := base64.StdEncoding.Strict().DecodeString(f.Body)
			if err != nil || len(data) > MaxWSData {
				return errors.New("invalid websocket data")
			}
			mu.Lock()
			stream := streams[f.ID]
			mu.Unlock()
			if stream != nil {
				kind := websocket.TextMessage
				if f.Binary {
					kind = websocket.BinaryMessage
				}
				stream.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if stream.WriteMessage(kind, data) != nil {
					stream.Close()
				}
				if send(Frame{Type: "ws-ack", ID: f.ID}) != nil {
					return errors.New("websocket ack failed")
				}
			}
			continue
		}
		if f.Type != "request" && f.Type != "ws-open" && f.Type != "http-open" {
			return errors.New("invalid frame type")
		}
		if seen[f.ID] || len(seen) >= 100000 {
			return errors.New("duplicate id or session rotation required")
		}
		seen[f.ID] = true
		mu.Lock()
		if len(active) >= MaxConcurrent {
			mu.Unlock()
			responseType := "response"
			if f.Type == "http-open" {
				responseType = "http-error"
			}
			if send(Frame{Type: responseType, ID: f.ID, Error: "CAPACITY"}) != nil {
				return errors.New("write failed")
			}
			continue
		}
		requestCtx, stop := context.WithCancel(ctx)
		active[f.ID] = stop
		var state *httpStream
		if f.Type == "http-open" {
			state = &httpStream{input: make(chan Frame, 1), credit: make(chan int, 1)}
			httpStreams[f.ID] = state
		}
		mu.Unlock()
		go func(f Frame) {
			defer func() {
				stop()
				mu.Lock()
				delete(active, f.ID)
				delete(streams, f.ID)
				delete(wsAcks, f.ID)
				delete(httpStreams, f.ID)
				mu.Unlock()
			}()
			if f.Type == "http-open" {
				client := clients[f.Target]
				if client == nil {
					_ = send(Frame{Type: "http-error", ID: f.ID, Error: "INVALID_TARGET"})
					return
				}
				executeStream(requestCtx, f, client, state, send)
				return
			}
			if f.Type == "request" {
				client := clients[f.Target]
				if client == nil {
					if send(Frame{Type: "response", ID: f.ID, Error: "INVALID_TARGET"}) != nil {
						conn.Close()
					}
					return
				}
				if send(Execute(requestCtx, f, client)) != nil {
					conn.Close()
				}
				return
			}
			if ValidatePath(f.Target, f.Path, true) != nil {
				if send(Frame{Type: "response", ID: f.ID, Error: "INVALID_WS_PATH"}) != nil {
					conn.Close()
				}
				return
			}
			wsDialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second, NetDialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", IncusSocket)
			}}
			stream, resp, err := wsDialer.DialContext(requestCtx, "ws://localhost"+f.Path, nil)
			if resp != nil && resp.Body != nil {
				resp.Body.Close()
			}
			if err != nil {
				if send(Frame{Type: "response", ID: f.ID, Error: "LOCAL_WS_FAILED"}) != nil {
					conn.Close()
				}
				return
			}
			defer stream.Close()
			stream.SetReadLimit(MaxWSData)
			mu.Lock()
			streams[f.ID] = stream
			ack := make(chan bool, 1)
			wsAcks[f.ID] = ack
			mu.Unlock()
			go func() { <-requestCtx.Done(); stream.Close() }()
			if send(Frame{Type: "ws-opened", ID: f.ID}) != nil {
				conn.Close()
				return
			}
			for {
				kind, data, err := stream.ReadMessage()
				if err != nil {
					if send(Frame{Type: "ws-close", ID: f.ID}) != nil {
						conn.Close()
					}
					return
				}
				if send(Frame{Type: "ws-data", ID: f.ID, Body: base64.StdEncoding.EncodeToString(data), Binary: kind == websocket.BinaryMessage}) != nil {
					conn.Close()
					return
				}
				timer := time.NewTimer(10 * time.Second)
				select {
				case <-ack:
					timer.Stop()
				case <-requestCtx.Done():
					timer.Stop()
					return
				case <-timer.C:
					_ = send(Frame{Type: "ws-close", ID: f.ID})
					return
				}
			}
		}(f)
	}
}
