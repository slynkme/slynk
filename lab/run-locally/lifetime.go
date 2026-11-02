package main

import (
	"io"
	"net/http"
	"sync"
	"time"
)

// Slynk stops on its own once its last window closes:
// the downloads open no Terminal or black window, so there's
// nothing else to close. Each Slynk page holds a connection to /api/alive
// while it's open, and says it's going (/api/bye) as it goes
// (web/src/ui/localLinks.ts). So the program stops:
//   - a little after the last page goes, if it said so: long enough for a
//     reload, or a move to the About page, whose next page connects first;
//   - as soon after the browser it started for Slynk's window ends;
//   - after a long while with no page at all: a page the browser put to
//     sleep, or lost, says nothing and may come back, so that waits longer.
type lifetime struct {
	mu      sync.Mutex
	pages   int       // pages connected now
	saidBye time.Time // when a page last said it was going, or the browser ended
	gen     int       // bumps with every new wait, so an old timer does nothing
	timer   *time.Timer
	soon    time.Duration // after the last page goes, having said so
	idle    time.Duration // with no page at all
	stop    func()
}

// byeCounts is how long a page's goodbye explains its connection closing.
const byeCounts = 5 * time.Second

func newLifetime(soon, idle time.Duration, stop func()) *lifetime {
	l := &lifetime{soon: soon, idle: idle, stop: stop}
	l.mu.Lock()
	l.wait(idle) // no page yet: the window is still opening
	l.mu.Unlock()
	return l
}

// wait starts the wait before stopping, in place of any other. With l.mu held.
func (l *lifetime) wait(d time.Duration) {
	l.gen++
	gen := l.gen
	if l.timer != nil {
		l.timer.Stop()
	}
	l.timer = time.AfterFunc(d, func() {
		l.mu.Lock()
		stop := gen == l.gen && l.pages == 0
		l.mu.Unlock()
		if stop {
			l.stop()
		}
	})
}

func (l *lifetime) connect() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pages++
	l.gen++ // no wait while a page is open
	if l.timer != nil {
		l.timer.Stop()
	}
}

func (l *lifetime) disconnect() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pages--
	if l.pages > 0 {
		return
	}
	if time.Since(l.saidBye) <= byeCounts {
		l.wait(l.soon)
	} else {
		l.wait(l.idle)
	}
}

// bye: a page is going, or the browser that showed Slynk ended.
func (l *lifetime) bye() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.saidBye = time.Now()
	if l.pages == 0 {
		l.wait(l.soon)
	}
}

// alive holds a page's connection open while the page is (an EventSource),
// sending a comment now and then so nothing between closes it. Only Slynk's
// own page counts: another site's can't make the browser say same-origin.
// (A browser that sends no Sec-Fetch-Site could let another site keep the
// program running, which is all it could do.)
func (s *server) alive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	flush, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Can't stream", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	// retry: if the connection drops while the page stays, it's back within 2 s.
	if _, err := io.WriteString(w, "retry: 2000\n\n"); err != nil {
		return
	}
	flush.Flush()
	if s.life != nil {
		s.life.connect()
		defer s.life.disconnect()
	}
	tick := time.NewTicker(25 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
			if _, err := io.WriteString(w, ":\n\n"); err != nil {
				return
			}
			flush.Flush()
		}
	}
}

// byeRequest: a Slynk page is going (closed, reloaded or left). Only this
// program's own page: fetch sends Origin with every POST, and no other site
// can send this one.
func (s *server) byeRequest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost || r.Header.Get("Origin") != s.origin {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}
	if s.life != nil {
		s.life.bye()
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}
