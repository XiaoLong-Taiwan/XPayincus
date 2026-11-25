package main

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/XiaoLong-Taiwan/XPayincus-Agent/internal/panel"
)

func runHostRealtime(ctx context.Context, interval time.Duration, sample func() map[string]any, send func(context.Context, map[string]any) error) {
	const (
		requestTimeout           = 2500 * time.Millisecond
		unsupportedRetryInterval = 5 * time.Minute
		failureLogInterval       = time.Minute
	)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	result := make(chan error, 1)
	var inFlight bool
	var nextProbe, lastFailureLog time.Time
	collect := func() {
		if ctx.Err() != nil {
			return
		}
		payload := sample()
		if len(payload) == 0 || inFlight || time.Now().Before(nextProbe) {
			return
		}
		inFlight = true
		go func() {
			requestCtx, cancel := context.WithTimeout(ctx, requestTimeout)
			defer cancel()
			result <- send(requestCtx, payload)
		}()
	}

	collect()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			collect()
		case err := <-result:
			inFlight = false
			if ctx.Err() != nil {
				return
			}
			now := time.Now()
			if errors.Is(err, panel.ErrHostRealtimeUnsupported) {
				if nextProbe.IsZero() {
					log.Print("host realtime monitoring endpoint unavailable, retrying periodically")
				}
				nextProbe = now.Add(unsupportedRetryInterval)
			} else {
				nextProbe = time.Time{}
				if err != nil && now.Sub(lastFailureLog) >= failureLogInterval {
					lastFailureLog = now
					log.Printf("host realtime monitoring failed: %v", err)
				}
			}
		}
	}
}
