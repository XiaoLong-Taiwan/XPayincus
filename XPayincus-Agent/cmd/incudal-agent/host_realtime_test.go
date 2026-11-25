package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/panel"
)

func TestHostRealtimeSlowSenderDoesNotBlockSampling(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	started, stopped, done := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var samples, sends atomic.Int32
	go func() {
		defer close(done)
		runHostRealtime(ctx, 10*time.Millisecond, func() map[string]any {
			samples.Add(1)
			return map[string]any{"ramPercent": 10.0}
		}, func(ctx context.Context, _ map[string]any) error {
			if sends.Add(1) == 1 {
				close(started)
			}
			<-ctx.Done()
			if sends.Load() == 1 {
				close(stopped)
			}
			return ctx.Err()
		})
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("send did not start")
	}
	waitForHostSamples(t, ctx, &samples, 4)
	if got := sends.Load(); got != 1 {
		t.Errorf("sent %d requests while first request was blocked", got)
	}
	cancel()
	for _, ch := range []<-chan struct{}{stopped, done} {
		select {
		case <-ch:
		case <-time.After(time.Second):
			t.Fatal("sampling or sending did not stop after cancellation")
		}
	}
}

func TestHostRealtimeUnsupportedEndpointContinuesSampling(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var samples, sends atomic.Int32
	go runHostRealtime(ctx, 10*time.Millisecond, func() map[string]any {
		samples.Add(1)
		return map[string]any{"ramPercent": 10.0}
	}, func(context.Context, map[string]any) error {
		sends.Add(1)
		return panel.ErrHostRealtimeUnsupported
	})
	waitForHostSamples(t, ctx, &samples, 4)
	if got := sends.Load(); got != 1 {
		t.Errorf("sent %d requests after unsupported response, want 1", got)
	}
}

func waitForHostSamples(t *testing.T, ctx context.Context, samples *atomic.Int32, want int32) {
	t.Helper()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for samples.Load() < want {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatalf("got %d samples, want at least %d", samples.Load(), want)
		}
	}
}
