package keyserver

import (
	"errors"
	"io"
	"net/http"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Config is the server's settings. Zero values are not defaults: see DefaultConfig.
type Config struct {
	// OneTimeOnly is slynk.me's rule: every link opens once only, so expiring
	// shares are neither stored nor handed out. A copy of Slynk may turn it
	// off (with ONE_TIME_ONLY in web/src/site.ts).
	OneTimeOnly bool
	// PowBits is the puzzle's difficulty in zero bits; each 1 more doubles
	// the work. Every answer announces it ("d") and pages follow it. 0 turns
	// the puzzle off.
	PowBits int
	// CoverGap is the mean gap, in seconds, between one tab's cover requests.
	// Every answer carries it ("g") and every open tab follows the latest.
	CoverGap int
	// AllowOrigins are the pages that may use the key server from a browser.
	// A request from one of them gets it back as Access-Control-Allow-Origin,
	// so that page can read the answer; a request a browser sends from any
	// other origin (another site's page, a local test build) is answered
	// "bad", changing nothing, and names the first. A request without an
	// Origin (a script's) is answered as ever. Empty: no header, no check
	// (the page on the same origin). Exact origins only: see ParseOrigins.
	AllowOrigins []string
	// MinResponse is the least time every answer takes, whatever the request
	// and its outcome, so timing can't tell them apart.
	MinResponse time.Duration
	// MaxInFlight caps the requests being answered at once, once their bodies
	// have arrived; beyond it, "down" at once, changing nothing. Each holds a
	// goroutine (a few KB) for MinResponse, not a worker.
	MaxInFlight int
	// Now is the clock (tests set it).
	Now func() time.Time
}

// DefaultConfig is slynk.me's settings.
func DefaultConfig() Config {
	return Config{
		OneTimeOnly: true,
		PowBits:     20,
		CoverGap:    25,
		// slynk.me, and the copy of it people download and run on their own
		// computer, which serves the page there at this one address
		// (127.0.0.1 is every computer's own; lab/run-locally).
		AllowOrigins: []string{"https://slynk.me", "http://127.0.0.1:8293"},
		MinResponse:  100 * time.Millisecond,
		MaxInFlight:  4096,
		Now:          time.Now,
	}
}

// Server answers key-share requests over HTTP.
type Server struct {
	cfg      Config
	store    *Store
	inFlight chan struct{}
	// restartedAt is when this server last started without its shares (Unix
	// seconds; 0: not within memory). For MaxTTLHours after it, answers say so.
	restartedAt atomic.Int64
}

// NewServer serves store with cfg. restartedAt is as Load returned it.
func NewServer(cfg Config, store *Store, restartedAt int64) *Server {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	s := &Server{cfg: cfg, store: store, inFlight: make(chan struct{}, max(1, cfg.MaxInFlight))}
	s.restartedAt.Store(restartedAt)
	return s
}

// RestartedAt is when this server last started without its shares, or 0.
func (s *Server) RestartedAt() int64 { return s.restartedAt.Load() }

// restarted reports whether a link made before the latest start without its
// shares could still be waiting: within its longest life, grace and rounding.
func (s *Server) restarted(now int64) bool {
	at := s.restartedAt.Load()
	return at != 0 && now-at < MaxTTLHours*3600+ExpiryGrace+ExpiryStep
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	origin := r.Header.Get("Origin")
	code, st, share := http.StatusOK, "bad", (*[32]byte)(nil)
	var q request
	ok := false
	switch {
	case r.Method != http.MethodPost:
		w.Header().Set("Allow", "POST")
		code, st = http.StatusMethodNotAllowed, "method"
	case origin != "" && len(s.cfg.AllowOrigins) > 0 && !s.allowed(origin):
		// a browser on another site: "bad"
	default:
		q, ok = s.read(r) // before taking a slot, so slow bodies can't fill them
	}
	select {
	case s.inFlight <- struct{}{}:
		defer func() { <-s.inFlight }()
	default:
		s.write(w, origin, http.StatusOK, "down", nil) // overloaded: answered at once, nothing changed
		return
	}
	if ok {
		now := s.cfg.Now().Unix()
		switch {
		case q.op == "put" && !solved(q.id, q.w, now, s.cfg.PowBits):
			st = "work" // an unsolved put costs a hash or two, nothing more
		case q.op != "put" && !s.store.Known(q.id):
			// Every cover request, and any other request about an ID with no
			// record, gets the answer the operation would give, under a read
			// lock and changing nothing.
			st = "gone"
		default:
			st, share = s.store.do(q, now, s.cfg.OneTimeOnly)
		}
	}
	if left := s.cfg.MinResponse - time.Since(start); left > 0 {
		time.Sleep(left)
	}
	s.write(w, origin, code, st, share)
	if share != nil {
		*share = [32]byte{}
	}
}

// read checks the request's type and size, and parses its body.
func (s *Server) read(r *http.Request) (request, bool) {
	// The media type before any parameters: only it counts.
	t, _, _ := strings.Cut(r.Header.Get("Content-Type"), ";")
	if t = strings.ToLower(strings.TrimSpace(t)); t != "text/plain" && t != "application/json" {
		return request{}, false
	}
	if r.ContentLength >= 0 && r.ContentLength != RequestBytes {
		return request{}, false
	}
	// One byte more than allowed, so a longer body is caught even without a length.
	body, err := io.ReadAll(io.LimitReader(r.Body, RequestBytes+1))
	if err != nil {
		return request{}, false
	}
	return parseRequest(body)
}

// allowed reports whether a browser on origin may use the key server.
func (s *Server) allowed(origin string) bool {
	return slices.Contains(s.cfg.AllowOrigins, origin)
}

func (s *Server) write(w http.ResponseWriter, origin string, code int, st string, share *[32]byte) {
	now := s.cfg.Now().Unix()
	body := answer(st, share, s.cfg.CoverGap, s.cfg.PowBits, now, s.restarted(now))
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "no-store, no-transform")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	if len(s.cfg.AllowOrigins) > 0 {
		if !s.allowed(origin) {
			origin = s.cfg.AllowOrigins[0]
		}
		h.Set("Access-Control-Allow-Origin", origin)
		h.Set("Vary", "Origin")
	}
	w.WriteHeader(code)
	_, _ = w.Write(body)
	clear(body)
}

// ParseOrigins reads -allow-origin's comma-separated list. Each must be an
// exact origin, written as a browser sends it, since only an exact match is
// let in: "http://" or "https://", then a lower-case ASCII host name
// (punycode for any other), a dotted IPv4 address or a bracketed IPv6 one in
// its shortest form, and perhaps a port that isn't the scheme's default.
// Never a pattern, and never "null", which every file:// page and every
// sandboxed frame on any website sends. "" is none (no check); a value that
// isn't empty but names none is refused.
func ParseOrigins(list string) ([]string, error) {
	var out []string
	for _, o := range strings.Split(list, ",") {
		if o = strings.TrimSpace(o); o == "" {
			continue
		}
		if !exactOrigin(o) {
			return nil, errors.New("not an origin as browsers send it (scheme://host[:port], lower case, no default port, nothing after): " + o)
		}
		if !slices.Contains(out, o) {
			out = append(out, o)
		}
	}
	if len(out) == 0 && list != "" {
		return nil, errors.New(`no origin in -allow-origin (give "" for no check): ` + strconv.Quote(list))
	}
	return out, nil
}

// exactOrigin reports whether o is written as a browser writes an origin.
func exactOrigin(o string) bool {
	scheme, rest, ok := strings.Cut(o, "://")
	if !ok || (scheme != "https" && scheme != "http") {
		return false
	}
	host := rest
	if i := strings.LastIndexByte(rest, ':'); i >= 0 && !strings.HasSuffix(rest, "]") {
		host = rest[:i]
		port := rest[i+1:]
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 || strconv.Itoa(n) != port ||
			(scheme == "https" && n == 443) || (scheme == "http" && n == 80) {
			return false
		}
	}
	if inner, ok := strings.CutPrefix(host, "["); ok {
		inner, ok = strings.CutSuffix(inner, "]")
		a, err := netip.ParseAddr(inner)
		return ok && err == nil && a.Is6() && !a.Is4In6() && a.Zone() == "" && a.String() == inner
	}
	if a, err := netip.ParseAddr(host); err == nil {
		return a.Is4() && a.String() == host
	}
	labels := strings.Split(host, ".")
	if len(host) > 253 {
		return false
	}
	for _, l := range labels {
		if l == "" || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return false
		}
		for _, c := range l {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return false
			}
		}
	}
	// A last part that's a number (or 0x...) makes browsers read the whole
	// host as an IPv4 address, which they'd send in another form.
	last := labels[len(labels)-1]
	return strings.Trim(last, "0123456789") != "" && !strings.HasPrefix(last, "0x")
}
