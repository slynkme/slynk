package main

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// stopper is a lifetime whose stopping is recorded, not done.
func stopper(soon, idle time.Duration) (*lifetime, chan struct{}) {
	stopped := make(chan struct{}, 4)
	return newLifetime(soon, idle, func() { stopped <- struct{}{} }), stopped
}

func stops(t *testing.T, stopped chan struct{}, within time.Duration) {
	t.Helper()
	select {
	case <-stopped:
	case <-time.After(within):
		t.Fatalf("didn't stop within %v", within)
	}
}

func keepsRunning(t *testing.T, stopped chan struct{}, for_ time.Duration) {
	t.Helper()
	select {
	case <-stopped:
		t.Fatal("stopped")
	case <-time.After(for_):
	}
}

func TestLifetimeStopsSoonAfterTheLastWindowCloses(t *testing.T) {
	l, stopped := stopper(50*time.Millisecond, time.Hour)
	l.connect()
	l.bye()
	l.disconnect()
	stops(t, stopped, 2*time.Second)
}

func TestLifetimeGoodbyeAfterTheConnectionCloses(t *testing.T) {
	l, stopped := stopper(50*time.Millisecond, time.Hour)
	l.connect()
	l.disconnect()
	l.bye()
	stops(t, stopped, 2*time.Second)
}

func TestLifetimeReloadOrAboutPageKeepsItRunning(t *testing.T) {
	l, stopped := stopper(300*time.Millisecond, time.Hour)
	l.connect()
	l.bye()
	l.disconnect()
	l.connect() // the next page, well within the wait
	keepsRunning(t, stopped, time.Second)
}

func TestLifetimeWaitsForEveryWindow(t *testing.T) {
	l, stopped := stopper(50*time.Millisecond, time.Hour)
	l.connect()
	l.connect()
	l.bye()
	l.disconnect()
	keepsRunning(t, stopped, 500*time.Millisecond)
	l.bye()
	l.disconnect()
	stops(t, stopped, 2*time.Second)
}

func TestLifetimeASilentPageWaitsLonger(t *testing.T) {
	// A page the browser put to sleep or lost says nothing: it may come back.
	l, stopped := stopper(20*time.Millisecond, 800*time.Millisecond)
	l.connect()
	l.disconnect()
	keepsRunning(t, stopped, 300*time.Millisecond)
	stops(t, stopped, 3*time.Second)
}

func TestLifetimeNoWindowAtAll(t *testing.T) {
	_, stopped := stopper(20*time.Millisecond, 300*time.Millisecond)
	stops(t, stopped, 3*time.Second)
}

func TestLifetimeTheBrowserEnding(t *testing.T) {
	// Before any page connected, or after: either way, soon.
	l, stopped := stopper(50*time.Millisecond, time.Hour)
	l.bye()
	stops(t, stopped, 2*time.Second)
}

func TestAliveAndBye(t *testing.T) {
	s := &server{}
	ts := httptest.NewServer(s)
	defer ts.Close()
	s.host = strings.TrimPrefix(ts.URL, "http://")
	s.origin = ts.URL
	l, stopped := stopper(50*time.Millisecond, time.Hour)
	s.life = l

	// Another site's page can't hold it open.
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/alive", nil)
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-site: %v %v", res, err)
	}

	// Slynk's own page holds it open while it's connected.
	ctx, cancel := context.WithCancel(context.Background())
	req, _ = http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/api/alive", nil)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	res, err := http.DefaultClient.Do(req)
	if err != nil || res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("own page: %v %v", res, err)
	}
	if line, _ := bufio.NewReader(res.Body).ReadString('\n'); line != "retry: 2000\n" {
		t.Fatalf("first line %q", line)
	}
	l.mu.Lock()
	pages := l.pages
	l.mu.Unlock()
	if pages != 1 {
		t.Fatalf("%d pages", pages)
	}

	// Only its own page may say it's going.
	for _, origin := range []string{"", "null", "https://evil.example"} {
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/bye", nil)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusForbidden {
			t.Fatalf("bye from %q: %v %v", origin, res, err)
		}
	}
	keepsRunning(t, stopped, 200*time.Millisecond)
	req, _ = http.NewRequest(http.MethodPost, ts.URL+"/api/bye", nil)
	req.Header.Set("Origin", s.origin)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != http.StatusNoContent {
		t.Fatalf("bye: %v %v", res, err)
	}
	keepsRunning(t, stopped, 200*time.Millisecond) // still connected
	cancel()
	res.Body.Close()
	stops(t, stopped, 2*time.Second)
}
