package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOpenRequest(t *testing.T) {
	var pages, sites []string
	s := &server{
		host:     "127.0.0.1:8293",
		origin:   "http://127.0.0.1:8293",
		openPage: func(u string) { pages = append(pages, u) },
		openSite: func(u string) { sites = append(sites, u) },
	}
	send := func(method, origin, body string) int {
		r := httptest.NewRequest(method, "http://127.0.0.1:8293/api/open", strings.NewReader(body))
		r.Host = "127.0.0.1:8293"
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		return w.Code
	}
	const own = "http://127.0.0.1:8293"
	// Only this program's own page may ask.
	for _, origin := range []string{"", "https://evil.example", "http://localhost:8293", "null", "http://127.0.0.1:8294"} {
		if c := send(http.MethodPost, origin, "https://example.org/"); c != http.StatusForbidden {
			t.Errorf("Origin %q: %d, want 403", origin, c)
		}
	}
	if c := send(http.MethodGet, own, ""); c != http.StatusForbidden {
		t.Errorf("GET: %d, want 403", c)
	}
	// Web addresses only.
	for _, body := range []string{"javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "slynk.me", "https://", "https://u:p@example.org/", "mailto:a@example.org", strings.Repeat("x", 9000)} {
		if c := send(http.MethodPost, own, body); c != http.StatusBadRequest {
			t.Errorf("%.40q: %d, want 400", body, c)
		}
	}
	if len(pages)+len(sites) != 0 {
		t.Fatalf("nothing refused may open anything: %q %q", pages, sites)
	}
	// Its own pages in a Slynk window, other sites in the person's browser.
	if c := send(http.MethodPost, own, "http://127.0.0.1:8293/about/#inbox"); c != http.StatusNoContent {
		t.Fatalf("own page: %d", c)
	}
	if c := send(http.MethodPost, own, " https://xx.network/ "); c != http.StatusNoContent {
		t.Fatalf("another site: %d", c)
	}
	if len(pages) != 1 || pages[0] != "http://127.0.0.1:8293/about/#inbox" || len(sites) != 1 || sites[0] != "https://xx.network/" {
		t.Fatalf("opened %q and %q", pages, sites)
	}
	// A page on another host and port is another site, even on this computer.
	send(http.MethodPost, own, "http://127.0.0.1:9000/")
	if len(sites) != 2 {
		t.Fatalf("127.0.0.1:9000 went to %q", pages)
	}
}
