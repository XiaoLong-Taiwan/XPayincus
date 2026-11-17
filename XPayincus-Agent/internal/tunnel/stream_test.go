package tunnel

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type streamRoundTripFunc func(*http.Request) (*http.Response, error)

func (f streamRoundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestChunkStreamRoundTrip(t *testing.T) {
	data := bytes.Repeat([]byte("stream-data"), 800000)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, err := io.ReadAll(r.Body)
		if err != nil || sha256.Sum256(got) != sha256.Sum256(data) {
			t.Error("upload mismatch")
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(data)
	}))
	defer server.Close()
	client := server.Client()
	client.Transport = streamRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		r.URL.Scheme = "http"
		r.URL.Host = server.Listener.Addr().String()
		return http.DefaultTransport.RoundTrip(r)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	state := &httpStream{input: make(chan Frame, 1), credit: make(chan int, 1)}
	frames := make(chan Frame, 1)
	done := make(chan bool, 1)
	go func() {
		executeStream(ctx, Frame{ID: "fixture", Target: "incus", Method: "POST", Path: "/1.0/instances"}, client, state, func(f Frame) error {
			select {
			case frames <- f:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		done <- true
	}()
	seq := 0
	for offset := 0; offset < len(data); offset += ChunkSize {
		end := offset + ChunkSize
		if end > len(data) {
			end = len(data)
		}
		state.input <- Frame{Type: "http-upload", Seq: seq, Body: base64.StdEncoding.EncodeToString(data[offset:end])}
		select {
		case f := <-frames:
			if f.Type != "http-ack" || f.Seq != seq {
				t.Fatal("missing ack")
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		seq++
	}
	state.input <- Frame{Type: "http-upload-end", Seq: seq}
	if f := <-frames; f.Type != "http-head" || f.Status != 200 {
		t.Fatal("missing headers")
	}
	select {
	case <-frames:
		t.Fatal("response without credit")
	case <-time.After(20 * time.Millisecond):
	}
	hash := sha256.New()
	seq = 0
	for {
		state.credit <- seq
		select {
		case f := <-frames:
			if f.Type == "http-end" {
				if f.Seq != seq {
					t.Fatal("end sequence")
				}
				goto finished
			}
			if f.Type != "http-data" || f.Seq != seq {
				t.Fatalf("invalid frame: %s", f.Type)
			}
			chunk, err := base64.StdEncoding.DecodeString(f.Body)
			if err != nil || len(chunk) > ChunkSize {
				t.Fatal("invalid chunk")
			}
			hash.Write(chunk)
			seq++
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
finished:
	if !bytes.Equal(hash.Sum(nil), sha256Sum(data)) {
		t.Fatal("download mismatch")
	}
	<-done
}

func sha256Sum(data []byte) []byte { sum := sha256.Sum256(data); return sum[:] }
