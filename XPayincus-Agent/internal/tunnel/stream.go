package tunnel

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

const ChunkSize = 64 * 1024

type httpStream struct {
	input  chan Frame
	credit chan int
}

func executeStream(parent context.Context, f Frame, client *http.Client, state *httpStream, send func(Frame) error) {
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	defer cancel()
	fail := func() { _ = send(Frame{Type: "http-error", ID: f.ID, Error: "STREAM_FAILED_OUTCOME_UNKNOWN"}) }
	if ValidatePath(f.Target, f.Path, false) != nil || !strings.Contains("|GET|POST|PUT|PATCH|DELETE|HEAD|", "|"+f.Method+"|") || f.Method == "" {
		fail()
		return
	}
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	req, err := http.NewRequestWithContext(ctx, f.Method, "http://localhost"+f.Path, reader)
	if err != nil {
		fail()
		return
	}
	for k, v := range f.Headers {
		name := strings.ToLower(k)
		if len(v) > 4096 || strings.ContainsAny(v, "\r\n") || !strings.Contains("|content-type|x-incus-name|x-incus-pool|x-incus-uid|x-incus-gid|x-incus-mode|x-incus-type|x-incus-write|", "|"+name+"|") {
			fail()
			return
		}
		req.Header.Set(name, v)
	}
	go func() {
		seq := 0
		defer writer.Close()
		for {
			select {
			case <-ctx.Done():
				writer.CloseWithError(ctx.Err())
				return
			case chunk := <-state.input:
				if chunk.Seq != seq {
					writer.CloseWithError(errors.New("stream sequence"))
					cancel()
					return
				}
				if chunk.Type == "http-upload-end" {
					return
				}
				data, err := base64.StdEncoding.Strict().DecodeString(chunk.Body)
				if err != nil || len(data) > ChunkSize || len(data) == 0 {
					writer.CloseWithError(errors.New("stream chunk"))
					cancel()
					return
				}
				if _, err = writer.Write(data); err != nil {
					cancel()
					return
				}
				if send(Frame{Type: "http-ack", ID: f.ID, Seq: seq}) != nil {
					cancel()
					return
				}
				seq++
			}
		}
	}()
	response, err := client.Do(req)
	if err != nil {
		fail()
		return
	}
	defer response.Body.Close()
	headers := map[string]string{}
	for _, name := range []string{"Content-Type", "Content-Length", "X-Incus-Uid", "X-Incus-Gid", "X-Incus-Mode", "X-Incus-Type"} {
		if value := response.Header.Get(name); value != "" && len(value) <= 4096 {
			headers[strings.ToLower(name)] = value
		}
	}
	if send(Frame{Type: "http-head", ID: f.ID, Status: response.StatusCode, Headers: headers}) != nil {
		return
	}
	buffer := make([]byte, ChunkSize)
	seq := 0
	for {
		select {
		case <-ctx.Done():
			fail()
			return
		case credit := <-state.credit:
			if credit != seq {
				fail()
				return
			}
		}
		n, err := response.Body.Read(buffer)
		if n > 0 {
			if send(Frame{Type: "http-data", ID: f.ID, Seq: seq, Body: base64.StdEncoding.EncodeToString(buffer[:n])}) != nil {
				return
			}
			seq++
		}
		if err == io.EOF {
			_ = send(Frame{Type: "http-end", ID: f.ID, Seq: seq})
			return
		}
		if err != nil {
			fail()
			return
		}
	}
}
