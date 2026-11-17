package report

import (
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

type storageReportTransport func(*http.Request) (*http.Response, error)

func (transport storageReportTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestStoragePoolReportUsesResourcesAndPreservesFailures(t *testing.T) {
	var paths []string
	var deadline time.Time
	client := &http.Client{Transport: storageReportTransport(func(request *http.Request) (*http.Response, error) {
		paths = append(paths, request.URL.RequestURI())
		currentDeadline, ok := request.Context().Deadline()
		if !ok {
			t.Fatal("storage requests must share a deadline")
		}
		if deadline.IsZero() {
			deadline = currentDeadline
		} else if !deadline.Equal(currentDeadline) {
			t.Fatal("storage request deadline must not reset per pool")
		}
		body := ""
		status := http.StatusOK
		switch request.URL.RequestURI() {
		case "/1.0/storage-pools?recursion=1":
			body = `{"type":"sync","metadata":[{"name":"default","driver":"zfs","space":{"total":1}},{"name":"data","driver":"dir"},{"name":"unavailable","driver":"zfs"}]}`
		case "/1.0/storage-pools/default/resources":
			body = `{"type":"sync","metadata":{"space":{"total":107374182400,"used":21474836480}}}`
		case "/1.0/storage-pools/data/resources":
			body = `{"type":"sync","metadata":{"space":{"total":1073741824000,"used":0}}}`
		case "/1.0/storage-pools/unavailable/resources":
			status = http.StatusServiceUnavailable
		default:
			t.Fatalf("unexpected resource request: %s", request.URL.RequestURI())
		}
		return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	pools := collectIncusStoragePoolsWithClient(client)
	want := []any{
		map[string]any{"name": "default", "driver": "zfs", "space": map[string]any{"total": uint64(107374182400), "used": uint64(21474836480)}},
		map[string]any{"name": "data", "driver": "dir", "space": map[string]any{"total": uint64(1073741824000), "used": uint64(0)}},
		map[string]any{"name": "unavailable", "driver": "zfs"},
	}
	if !reflect.DeepEqual(pools, want) {
		t.Fatalf("storage reports mismatch: got=%#v want=%#v", pools, want)
	}
	if len(paths) != 4 {
		t.Fatalf("storage requests mismatch: %#v", paths)
	}
}
