package keyserver

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"
)

const testBits = 8 // low, so puts are quick, but never 0, so every solution is checked

// clock is a settable test clock (Unix seconds).
type clock struct{ t atomic.Int64 }

func (c *clock) now() time.Time      { return time.Unix(c.t.Load(), 0) }
func (c *clock) add(d time.Duration) { c.t.Add(int64(d / time.Second)) }

type harness struct {
	t     *testing.T
	clock *clock
	store *Store
	srv   *Server
	http  *httptest.Server
}

func newHarness(t *testing.T, edit func(*Config, *int)) *harness {
	t.Helper()
	c := &clock{}
	c.t.Store(1_800_000_000) // a fixed, round-ish moment
	cfg := DefaultConfig()
	cfg.PowBits, cfg.MinResponse, cfg.Now = testBits, 0, c.now
	maxRecords := 1000
	if edit != nil {
		edit(&cfg, &maxRecords)
	}
	st := NewStore(maxRecords)
	s := NewServer(cfg, st, 0)
	h := &harness{t: t, clock: c, store: st, srv: s, http: httptest.NewServer(s)}
	t.Cleanup(h.http.Close)
	return h
}

func rnd(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b64u.EncodeToString(b)
}

// body is a request body as burn.ts builds it: the fields in order, padded with dots in "p".
func body(op string, kv ...any) string {
	var b strings.Builder
	b.WriteString(`{"v":1,"op":"` + op + `"`)
	for i := 0; i < len(kv); i += 2 {
		v, _ := json.Marshal(kv[i+1])
		fmt.Fprintf(&b, `,"%s":%s`, kv[i], v)
	}
	b.WriteString(`,"p":"`)
	return b.String() + strings.Repeat(".", RequestBytes-b.Len()-2) + `"}`
}

// work solves the puzzle for this ID in the window of time now, and only that window.
func work(id string, now int64, bits int) string {
	idb, _ := b64u.DecodeString(id)
	var i16 [16]byte
	copy(i16[:], idb)
	for n := uint64(0); ; n++ {
		var w [8]byte
		binary.BigEndian.PutUint64(w[:], n)
		if solvesWindow(i16, w, now/PowWindow, bits) {
			return b64u.EncodeToString(w[:])
		}
	}
}

type reply struct {
	status int
	st     string
	s      string
	r      int
	header http.Header
	raw    string
}

func (h *harness) send(method, ctype, payload string) reply {
	h.t.Helper()
	req, _ := http.NewRequest(method, h.http.URL+"/", strings.NewReader(payload))
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	rep := reply{status: res.StatusCode, header: res.Header, raw: string(raw)}
	if method == http.MethodHead {
		return rep
	}
	if len(raw) != ResponseBytes {
		h.t.Fatalf("answer is %d bytes, not %d: %s", len(raw), ResponseBytes, raw)
	}
	var j struct {
		V  int    `json:"v"`
		St string `json:"st"`
		S  string `json:"s"`
		G  int    `json:"g"`
		D  int    `json:"d"`
		T  int64  `json:"t"`
		R  int    `json:"r"`
		P  string `json:"p"`
	}
	if err := json.Unmarshal(raw, &j); err != nil {
		h.t.Fatalf("answer isn't JSON: %s", raw)
	}
	if !strings.HasPrefix(string(raw), `{"v":1,"st":"`) || !strings.Contains(string(raw), `,"r":`) {
		h.t.Fatalf("answer's fields out of order: %s", raw)
	}
	if s, err := b64u.DecodeString(j.S); err != nil || len(s) != 32 {
		h.t.Fatalf(`"s" must always be 32 bytes, real or filler: %s`, raw)
	}
	if j.G != h.srv.cfg.CoverGap || j.D != h.srv.cfg.PowBits || j.T != h.clock.t.Load() {
		h.t.Fatalf("answer's g, d or t is wrong: %s", raw)
	}
	rep.st, rep.s, rep.r = j.St, j.S, j.R
	return rep
}

// call sends a request as the page does (text/plain), with a put's puzzle solved.
func (h *harness) call(op string, kv ...any) reply {
	h.t.Helper()
	if op == "put" {
		kv = append(kv, "w", work(kv[1].(string), h.clock.t.Load(), testBits))
	}
	return h.send(http.MethodPost, "text/plain;charset=UTF-8", body(op, kv...))
}

type share struct{ id, s, r string }

func newShare() share { return share{rnd(16), rnd(32), rnd(16)} }

func (h *harness) put(sh share, mode, ttl int) reply {
	return h.call("put", "id", sh.id, "s", sh.s, "r", sh.r, "m", mode, "t", ttl)
}

func expect(t *testing.T, got reply, st string) {
	t.Helper()
	if got.st != st {
		t.Fatalf("got %q, want %q", got.st, st)
	}
	if got.status != http.StatusOK {
		t.Fatalf("HTTP %d: every POST is answered 200, the outcome only in the body", got.status)
	}
}

func TestOneTime(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	c1, c2 := rnd(16), rnd(16)
	got := h.call("claim", "id", sh.id, "c", c1)
	expect(t, got, "ok")
	if got.s != sh.s {
		t.Fatal("the claim must hand out S")
	}
	again := h.call("claim", "id", sh.id, "c", c1)
	expect(t, again, "ok")
	if again.s != sh.s {
		t.Fatal("the same nonce may ask again (a lost answer)")
	}
	expect(t, h.call("claim", "id", sh.id, "c", c2), "gone")
	expect(t, h.call("hold", "id", sh.id, "c", c2), "gone")
	expect(t, h.call("done", "id", sh.id, "c", c2), "gone")
	expect(t, h.call("done", "id", sh.id, "c", c1), "ok")
	expect(t, h.call("claim", "id", sh.id, "c", c1), "gone")
	expect(t, h.put(sh, ModeOneTime, 24), "exists") // its tombstone keeps the ID taken
	expect(t, h.call("get", "id", sh.id), "gone")   // and a one-time share never comes out through get
}

func TestHold(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	a, b := rnd(16), rnd(16)
	expect(t, h.call("hold", "id", sh.id, "c", a), "ok")
	expect(t, h.call("hold", "id", sh.id, "c", a), "ok") // the same opener may hold it again
	expect(t, h.call("hold", "id", sh.id, "c", b), "held")
	expect(t, h.call("claim", "id", sh.id, "c", b), "held")
	h.clock.add(Hold*time.Second + time.Minute) // a hold lapses (its time is rounded up to the minute)
	expect(t, h.call("hold", "id", sh.id, "c", b), "ok")
	expect(t, h.call("claim", "id", sh.id, "c", a), "held")
	got := h.call("claim", "id", sh.id, "c", b)
	expect(t, got, "ok")
	expect(t, h.call("hold", "id", sh.id, "c", b), "ok") // its own claim: may be repeated
	expect(t, h.call("hold", "id", sh.id, "c", a), "gone")
}

func TestExpiring(t *testing.T) {
	h := newHarness(t, func(c *Config, _ *int) { c.OneTimeOnly = false })
	sh := newShare()
	expect(t, h.put(sh, ModeExpiring, 24), "ok")
	for i := 0; i < 3; i++ {
		got := h.call("get", "id", sh.id)
		expect(t, got, "ok")
		if got.s != sh.s {
			t.Fatal("get must hand out S, again and again")
		}
	}
	expect(t, h.call("claim", "id", sh.id, "c", rnd(16)), "gone") // never burnt by a claim
	expect(t, h.call("revoke", "id", sh.id, "r", sh.r), "ok")
	expect(t, h.call("get", "id", sh.id), "gone")
}

func TestOneTimeOnlyRule(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeExpiring, 24), "bad")
	if h.store.Len() != 0 {
		t.Fatal("an expiring put must store nothing under the rule")
	}
}

func TestRevoke(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	expect(t, h.call("revoke", "id", sh.id, "r", rnd(16)), "gone") // a wrong token learns nothing
	expect(t, h.call("revoke", "id", sh.id, "r", sh.r), "ok")
	expect(t, h.call("revoke", "id", sh.id, "r", sh.r), "ok") // repeating it is safe
	expect(t, h.call("claim", "id", sh.id, "c", rnd(16)), "gone")
	expect(t, h.call("hold", "id", sh.id, "c", rnd(16)), "gone")

	used := newShare()
	expect(t, h.put(used, ModeOneTime, 24), "ok")
	c := rnd(16)
	expect(t, h.call("claim", "id", used.id, "c", c), "ok")
	expect(t, h.call("revoke", "id", used.id, "r", used.r), "gone") // too late to cancel
	expect(t, h.call("claim", "id", used.id, "c", c), "ok")         // and the claimer still has it
}

func TestPutRetryAndTakenID(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	expect(t, h.put(sh, ModeOneTime, 24), "ok") // the same put again: a safe retry
	other := sh
	other.s = rnd(32)
	expect(t, h.put(other, ModeOneTime, 24), "exists")
	other = sh
	other.r = rnd(16)
	expect(t, h.put(other, ModeOneTime, 24), "exists")
}

func TestConcurrentClaims(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	var wins atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if h.call("claim", "id", sh.id, "c", rnd(16)).s == sh.s {
				wins.Add(1)
			}
		}()
	}
	wg.Wait()
	if wins.Load() != 1 {
		t.Fatalf("%d claims got S; exactly one must", wins.Load())
	}
}

func TestClaimRacingCancel(t *testing.T) {
	for i := 0; i < 20; i++ {
		h := newHarness(t, nil)
		sh := newShare()
		expect(t, h.put(sh, ModeOneTime, 24), "ok")
		var claim, cancel reply
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); claim = h.call("claim", "id", sh.id, "c", rnd(16)) }()
		go func() { defer wg.Done(); cancel = h.call("revoke", "id", sh.id, "r", sh.r) }()
		wg.Wait()
		if (claim.st == "ok") == (cancel.st == "ok") {
			t.Fatalf("claim %q, cancel %q: exactly one must win", claim.st, cancel.st)
		}
	}
}

func TestExpiry(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	start := h.clock.t.Load()
	expect(t, h.put(sh, ModeOneTime, 1), "ok")
	exp := roundUp(start+3600+ExpiryGrace, ExpiryStep)
	h.clock.t.Store(exp - 1)
	expect(t, h.call("hold", "id", sh.id, "c", rnd(16)), "ok")
	h.clock.t.Store(exp)
	expect(t, h.call("claim", "id", sh.id, "c", rnd(16)), "expired")
	h.store.Sweep(h.clock.t.Load())
	expect(t, h.call("claim", "id", sh.id, "c", rnd(16)), "gone")
	expect(t, h.put(sh, ModeOneTime, 1), "ok") // swept: the ID is free again
}

func TestClaimRetryWindow(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	c := rnd(16)
	expect(t, h.call("claim", "id", sh.id, "c", c), "ok")
	h.clock.add(ClaimRetry*time.Second - 2*time.Minute)
	expect(t, h.call("claim", "id", sh.id, "c", c), "ok")
	h.clock.add(2 * time.Minute)
	expect(t, h.call("claim", "id", sh.id, "c", c), "gone")
	h.store.Sweep(h.clock.t.Load())
	if r := h.store.recs[keyOf(id16(sh.id))]; r.kind != 'T' || r.s != ([32]byte{}) {
		t.Fatal("an old claim becomes a tombstone, without S")
	}
}

func id16(s string) [16]byte {
	b, _ := b64u.DecodeString(s)
	var out [16]byte
	copy(out[:], b)
	return out
}

func TestRateLimit(t *testing.T) {
	h := newHarness(t, func(_ *Config, max *int) { *max = 10_000 })
	ok := 0
	for i := 0; i < BurstPuts+5; i++ {
		if h.put(newShare(), ModeOneTime, 24).st == "ok" {
			ok++
		}
	}
	if ok != BurstPuts {
		t.Fatalf("%d puts at once got through; the burst allows %d", ok, BurstPuts)
	}
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "slow")
	h.clock.add(time.Minute)
	ok = 0
	for i := 0; i < PutsPerMinute+5; i++ {
		if h.put(newShare(), ModeOneTime, 24).st == "ok" {
			ok++
		}
	}
	if ok != PutsPerMinute {
		t.Fatalf("%d puts in the next minute; %d allowed", ok, PutsPerMinute)
	}
}

func TestRepeatedPutCountsNothing(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	before := h.store.tok
	for i := 0; i < 5; i++ {
		expect(t, h.put(sh, ModeOneTime, 24), "ok")
	}
	if h.store.tok != before {
		t.Fatal("a put for an ID already here must count towards no limit")
	}
}

func TestFull(t *testing.T) {
	h := newHarness(t, func(_ *Config, max *int) { *max = 3 })
	for i := 0; i < 3; i++ {
		expect(t, h.put(newShare(), ModeOneTime, 24), "ok")
	}
	expect(t, h.put(newShare(), ModeOneTime, 24), "full")
}

func TestSweep(t *testing.T) {
	h := newHarness(t, nil)
	waiting, held, claimed := newShare(), newShare(), newShare()
	for _, sh := range []share{waiting, held, claimed} {
		expect(t, h.put(sh, ModeOneTime, 1), "ok")
	}
	expect(t, h.call("hold", "id", held.id, "c", rnd(16)), "ok")
	expect(t, h.call("claim", "id", claimed.id, "c", rnd(16)), "ok")
	h.clock.add(Hold*time.Second + time.Minute)
	if n := h.store.Sweep(h.clock.t.Load()); n != 3 {
		t.Fatalf("kept %d, want 3", n)
	}
	if r := h.store.recs[keyOf(id16(held.id))]; r.at != 0 || r.hc != ([16]byte{}) {
		t.Fatal("a lapsed hold must be forgotten")
	}
	if r := h.store.recs[keyOf(id16(claimed.id))]; r.kind != 'T' {
		t.Fatal("a claim past its retry window must become a tombstone")
	}
	h.clock.add(2 * time.Hour)
	if n := h.store.Sweep(h.clock.t.Load()); n != 0 {
		t.Fatalf("expired shares and tombstones must go; %d kept", n)
	}
}

func TestUnknownIDsChangeNothing(t *testing.T) {
	h := newHarness(t, nil)
	for _, op := range []string{"hold", "claim", "done"} {
		expect(t, h.call(op, "id", rnd(16), "c", rnd(16)), "gone")
	}
	expect(t, h.call("revoke", "id", rnd(16), "r", rnd(16)), "gone")
	expect(t, h.call("get", "id", rnd(16)), "gone")
	if h.store.Len() != 0 || h.store.tok != BurstPuts {
		t.Fatal("cover requests must store and count nothing")
	}
}

func TestMalformed(t *testing.T) {
	h := newHarness(t, nil)
	id, c := rnd(16), rnd(16)
	good := body("hold", "id", id, "c", c)
	expect(t, h.send(http.MethodPost, "text/plain", good), "gone") // well-formed: the baseline
	expect(t, h.send(http.MethodPost, "application/json", good), "gone")
	// resize keeps a body at RequestBytes by taking dots from (or adding them to) its padding.
	resize := func(s string) string {
		head, tail := s[:len(s)-2], s[len(s)-2:]
		for len(head)+2 > RequestBytes && strings.HasSuffix(head, ".") {
			head = head[:len(head)-1]
		}
		for len(head)+2 < RequestBytes {
			head += "."
		}
		return head + tail
	}
	stdID := b64u.EncodeToString(append([]byte{0xfb, 0xff, 0xbf}, make([]byte, 13)...)) // spelt with - and _
	pad := func(s string) string {                                                      // to the right size, if it fits
		if len(s) < RequestBytes {
			return s[:len(s)-1] + strings.Repeat(" ", RequestBytes-len(s)) + "}"
		}
		return s
	}
	cases := map[string]string{
		"short":                  good[:RequestBytes-1],
		"long":                   good + " ",
		"not JSON":               strings.Repeat("x", RequestBytes),
		"a JSON list":            pad(`[1]`),
		"v 2":                    strings.Replace(good, `"v":1`, `"v":2`, 1),
		"v 1.0":                  resize(strings.Replace(good, `"v":1,`, `"v":1.0,`, 1)),
		"unknown op":             strings.Replace(good, `"hold"`, `"hodl"`, 1),
		"missing field":          pad(`{"v":1,"op":"hold","id":"` + id + `","p":""}`),
		"extra field":            pad(`{"v":1,"op":"hold","id":"` + id + `","c":"` + c + `","x":1,"p":""}`),
		"base64 padded":          pad(`{"v":1,"op":"hold","id":"` + id + `==","c":"` + c + `","p":""}`),
		"base64 standard":        pad(`{"v":1,"op":"hold","id":"` + strings.NewReplacer("-", "+", "_", "/").Replace(stdID) + `","c":"` + c + `","p":""}`),
		"base64 newline":         pad(`{"v":1,"op":"hold","id":"` + id + `\n","c":"` + c + `","p":""}`),
		"short ID":               pad(`{"v":1,"op":"hold","id":"` + rnd(15) + `","c":"` + c + `","p":""}`),
		"padding not dots":       pad(`{"v":1,"op":"hold","id":"` + id + `","c":"` + c + `","p":"x"}`),
		"padding with a newline": pad(`{"v":1,"op":"hold","id":"` + id + `","c":"` + c + `","p":".\n"}`),
		"nested":                 pad(`{"v":1,"op":"hold","id":"` + id + `","c":{"a":1},"p":""}`),
		"padding null":           pad(`{"v":1,"op":"hold","id":"` + id + `","c":"` + c + `","p":null}`),
		"ttl too long":           body("put", "id", id, "s", rnd(32), "r", rnd(16), "m", 2, "t", 501, "w", rnd(8)),
		"ttl 0":                  body("put", "id", id, "s", rnd(32), "r", rnd(16), "m", 2, "t", 0, "w", rnd(8)),
		"ttl as text":            body("put", "id", id, "s", rnd(32), "r", rnd(16), "m", 2, "t", "24", "w", rnd(8)),
		"ttl 24.0":               resize(strings.Replace(body("put", "id", id, "s", rnd(32), "r", rnd(16), "m", 2, "t", 24, "w", rnd(8)), `"t":24,`, `"t":24.0,`, 1)),
		"mode 3":                 body("put", "id", id, "s", rnd(32), "r", rnd(16), "m", 3, "t", 24, "w", rnd(8)),
		"put without w":          body("put", "id", id, "s", rnd(32), "r", rnd(16), "m", 2, "t", 24),
	}
	for name, b := range cases {
		if len(b) != RequestBytes && name != "short" && name != "long" {
			t.Fatalf("%s: test body is %d bytes", name, len(b))
		}
		if got := h.send(http.MethodPost, "text/plain", b); got.st != "bad" || got.status != 200 {
			t.Errorf("%s: got %d %q, want 200 bad", name, got.status, got.st)
		}
	}
	// Only the media type counts, whatever follows it.
	for _, ct := range []string{"text/plain;charset=UTF-8", "TEXT/PLAIN", "text/plain; charset", `application/json; x="`} {
		if got := h.send(http.MethodPost, ct, good); got.st != "gone" {
			t.Errorf("Content-Type %q: got %q, want gone", ct, got.st)
		}
	}
	for _, ct := range []string{"", "text/html", "application/x-www-form-urlencoded", "multipart/form-data"} {
		if got := h.send(http.MethodPost, ct, good); got.st != "bad" {
			t.Errorf("Content-Type %q: got %q, want bad", ct, got.st)
		}
	}
	// Without a Content-Length, the body itself must be the right size.
	for _, n := range []int{RequestBytes - 1, RequestBytes + 1, 2 << 20} {
		req, _ := http.NewRequest(http.MethodPost, h.http.URL, io.MultiReader(strings.NewReader(good), bytes.NewReader(make([]byte, max(0, n-RequestBytes)))))
		if n < RequestBytes {
			req, _ = http.NewRequest(http.MethodPost, h.http.URL, io.MultiReader(strings.NewReader(good[:n])))
		}
		req.ContentLength = -1
		req.Header.Set("Content-Type", "text/plain")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if !strings.Contains(string(raw), `"st":"bad"`) || len(raw) != ResponseBytes {
			t.Errorf("chunked body of %d bytes: %s", n, raw)
		}
	}
}

func TestOnlyPost(t *testing.T) {
	h := newHarness(t, nil)
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete, http.MethodOptions, http.MethodHead} {
		got := h.send(m, "text/plain", body("hold", "id", rnd(16), "c", rnd(16)))
		if got.status != http.StatusMethodNotAllowed || got.header.Get("Allow") != "POST" {
			t.Errorf("%s: HTTP %d, want 405 with Allow: POST", m, got.status)
		}
		if m != http.MethodHead && got.st != "method" {
			t.Errorf("%s: got %q", m, got.st)
		}
	}
}

func TestHeaders(t *testing.T) {
	h := newHarness(t, nil)
	got := h.call("hold", "id", rnd(16), "c", rnd(16))
	want := map[string]string{
		"Content-Type":                "application/json",
		"Cache-Control":               "no-store, no-transform",
		"Content-Length":              fmt.Sprint(ResponseBytes),
		"X-Content-Type-Options":      "nosniff",
		"Access-Control-Allow-Origin": "https://slynk.me",
		"Vary":                        "Origin",
	}
	for k, v := range want {
		if g := got.header.Get(k); g != v {
			t.Errorf("%s: %q, want %q", k, g, v)
		}
	}
	for _, k := range []string{"Set-Cookie", "Server", "X-Powered-By", "Content-Encoding"} {
		if got.header.Get(k) != "" {
			t.Errorf("%s must not be sent", k)
		}
	}
}

func TestPuzzle(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	now := h.clock.t.Load()
	put := func(w string) reply {
		return h.send(http.MethodPost, "text/plain", body("put", "id", sh.id, "s", sh.s, "r", sh.r, "m", 2, "t", 24, "w", w))
	}
	expect(t, put(work(rnd(16), now, testBits)), "work") // another ID's solution
	expect(t, put(work(sh.id, now-2*PowWindow, testBits)), "work")
	if h.store.Len() != 0 || h.store.tok != BurstPuts {
		t.Fatal("a refused put must store and count nothing")
	}
	expect(t, put(work(sh.id, now-PowWindow, testBits)), "ok") // the window before is still taken

	// Difficulty 0 turns it off: any well-formed w is taken.
	h = newHarness(t, func(c *Config, _ *int) { c.PowBits = 0 })
	expect(t, h.send(http.MethodPost, "text/plain", body("put", "id", sh.id, "s", sh.s, "r", sh.r, "m", 2, "t", 24, "w", rnd(8))), "ok")
}

func TestMinResponse(t *testing.T) {
	h := newHarness(t, func(c *Config, _ *int) { c.MinResponse = 80 * time.Millisecond })
	for _, op := range []string{"hold", "claim"} {
		start := time.Now()
		h.call(op, "id", rnd(16), "c", rnd(16))
		if d := time.Since(start); d < 80*time.Millisecond {
			t.Errorf("%s answered in %v, sooner than MinResponse", op, d)
		}
	}
}

func TestSaveAndLoad(t *testing.T) {
	h := newHarness(t, nil)
	waiting, claimed, cancelled := newShare(), newShare(), newShare()
	for _, sh := range []share{waiting, claimed, cancelled} {
		expect(t, h.put(sh, ModeOneTime, 24), "ok")
	}
	c := rnd(16)
	expect(t, h.call("claim", "id", claimed.id, "c", c), "ok")
	expect(t, h.call("revoke", "id", cancelled.id, "r", cancelled.r), "ok")
	now := h.clock.t.Load()
	path := filepath.Join(t.TempDir(), "shutdown")
	if err := h.store.Save(path, 0, now); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if !bytes.Contains(raw, mustB64(waiting.s)) {
		t.Fatal("the shutdown file must hold the waiting share")
	}
	if len(raw) != saveHead+3*slotBytes+sha256.Size || !bytes.HasPrefix(raw, []byte(saveMagic)) {
		t.Fatalf("the shutdown file is %d bytes, not in the compact format", len(raw))
	}

	st, restartedAt, err := Load(path, 1000, now+60)
	if err != nil {
		t.Fatal(err)
	}
	if restartedAt != 0 {
		t.Fatal("after a clean shutdown, nothing was lost")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the shutdown file must be destroyed as soon as it's read")
	}
	if st.Len() != 3 || st.tok != h.store.tok {
		t.Fatalf("restored %d records, tok %d", st.Len(), st.tok)
	}
	h2 := &harness{t: t, clock: h.clock, store: st, srv: NewServer(h.srv.cfg, st, restartedAt)}
	h2.http = httptest.NewServer(h2.srv)
	defer h2.http.Close()
	h2.clock.add(time.Minute)
	got := h2.call("claim", "id", waiting.id, "c", rnd(16))
	expect(t, got, "ok")
	if got.s != waiting.s || got.r != 0 {
		t.Fatal("a waiting share survives a clean restart, and nothing says it was lost")
	}
	expect(t, h2.call("claim", "id", claimed.id, "c", c), "ok") // a claim may still be repeated
	expect(t, h2.call("claim", "id", cancelled.id, "c", rnd(16)), "gone")
	expect(t, h2.put(cancelled, ModeOneTime, 24), "exists") // and tombstones still keep IDs taken
}

func mustB64(s string) []byte { b, _ := b64u.DecodeString(s); return b }

func TestLoadWithoutShares(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shutdown")
	now := int64(1_800_000_000)

	// No file: a first start, or after a crash.
	st, restartedAt, err := Load(path, 10, now)
	if err != nil || st.Len() != 0 || restartedAt != now {
		t.Fatalf("no file: %v %d %d", err, st.Len(), restartedAt)
	}

	// A damaged or half-written file is destroyed and counts as a crash.
	good := NewStore(10)
	good.recs[keyOf(id16(rnd(16)))] = record{kind: 'W', mode: ModeOneTime, exp: uint32(now + 3600)}
	if err := good.Save(path, 0, now); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	raw[len(raw)/2] ^= 1
	_ = os.WriteFile(path, raw, 0o600)
	_ = os.WriteFile(path+".tmp", []byte("left by a crash"), 0o600)
	st, restartedAt, err = Load(path, 10, now)
	if err != nil || st.Len() != 0 || restartedAt != now {
		t.Fatalf("damaged file: %v %d %d", err, st.Len(), restartedAt)
	}
	for _, p := range []string{path, path + ".tmp"} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s must be destroyed", filepath.Base(p))
		}
	}
}

func TestRestartedFlag(t *testing.T) {
	h := newHarness(t, nil)
	now := h.clock.t.Load()
	h.srv.restartedAt.Store(now)
	if got := h.call("hold", "id", rnd(16), "c", rnd(16)); got.r != 1 {
		t.Fatal(`after a start without shares, answers say so ("r":1)`)
	}
	h.clock.add((MaxTTLHours*3600 + ExpiryGrace + ExpiryStep) * time.Second)
	if got := h.call("hold", "id", rnd(16), "c", rnd(16)); got.r != 0 {
		t.Fatal("once no link from before could still be waiting, they stop")
	}
	// A clean restart carries the flag over, so a crash shortly before still shows.
	path := filepath.Join(t.TempDir(), "shutdown")
	if err := h.store.Save(path, now, now+10); err != nil {
		t.Fatal(err)
	}
	if _, at, _ := Load(path, 10, now+20); at != now {
		t.Fatal("the start without shares must survive a clean restart")
	}
}

func TestOverload(t *testing.T) {
	h := newHarness(t, func(c *Config, _ *int) { c.MaxInFlight, c.MinResponse = 1, 300*time.Millisecond })
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); h.call("hold", "id", rnd(16), "c", rnd(16)) }()
	time.Sleep(100 * time.Millisecond)
	start := time.Now()
	expect(t, h.call("hold", "id", rnd(16), "c", rnd(16)), "down")
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("beyond MaxInFlight, the answer comes at once")
	}
	wg.Wait()
}

func TestAnswerSize(t *testing.T) {
	for _, st := range []string{"ok", "bad", "work", "exists", "gone", "expired", "held", "slow", "full", "down", "method"} {
		if b := answer(st, nil, 3600, 63, 1<<40, true); len(b) != ResponseBytes || !json.Valid(b) {
			t.Errorf("%s: %d bytes: %s", st, len(b), b)
		}
	}
}

func TestReport(t *testing.T) {
	h := newHarness(t, nil)
	now := h.clock.t.Load()
	line := h.store.Report(now)
	if !strings.HasPrefix(line, "keyserver: Done at ") || !strings.Contains(line, "under 1,000 links kept; under 60 new in the last hour (usual under 60).") {
		t.Fatalf("quiet hour: %s", line)
	}
	h.store.stats.slow = 3
	line = h.store.Report(now + 3600)
	if !strings.Contains(line, "WARNING: busy in the hour to ") || !strings.Contains(line, "3 refused") {
		t.Fatalf("refused links must warn: %s", line)
	}
	line = h.store.Report(now + 7200)
	if !strings.Contains(line, "WARNING: busy") {
		t.Fatalf("a busy hour stays in the line for %d days: %s", warnDays, line)
	}
	if num(1234567) != "1,234,567" || pc(1, 2000) != "0.05%" || pc(800, 1000) != "80%" {
		t.Fatal("number formatting")
	}
}

func TestOtherOrigins(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	b := body("put", "id", sh.id, "s", sh.s, "r", sh.r, "m", 2, "t", 24, "w", work(sh.id, h.clock.t.Load(), testBits))
	send := func(origin string) (st, allow string) {
		req, _ := http.NewRequest(http.MethodPost, h.http.URL, strings.NewReader(b))
		req.Header.Set("Content-Type", "text/plain")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var j struct{ St string }
		_ = json.NewDecoder(res.Body).Decode(&j)
		if v := res.Header.Get("Vary"); v != "Origin" {
			t.Errorf("Vary: %q, want Origin", v)
		}
		return j.St, res.Header.Get("Access-Control-Allow-Origin")
	}
	for _, o := range []string{
		"https://evil.example", "http://localhost:4173", "null", "https://www.slynk.me", "http://slynk.me",
		// A downloaded copy is let in at its one address only.
		"http://localhost:8293", "http://127.0.0.1:8294", "https://127.0.0.1:8293", "http://127.0.0.1", "http://[::1]:8293",
		// Near misses a looser match (a prefix, a part of the name) would let in.
		"https://slynk.me.evil.example", "https://slynk.meevil.example", "https://slynk.me:8443", "http://127.0.0.1:82930",
	} {
		if st, allow := send(o); st != "bad" || allow != "https://slynk.me" {
			t.Errorf("a browser on %s: got %q naming %q, want bad naming slynk.me", o, st, allow)
		}
	}
	if h.store.Len() != 0 || h.store.tok != BurstPuts {
		t.Fatal("a refused origin must change nothing")
	}
	if st, allow := send("https://slynk.me"); st != "ok" || allow != "https://slynk.me" {
		t.Fatalf("slynk.me's own page: %q naming %q", st, allow)
	}
	// The same put again, which is answered as the first was.
	if st, allow := send("http://127.0.0.1:8293"); st != "ok" || allow != "http://127.0.0.1:8293" {
		t.Fatalf("a downloaded copy: %q naming %q", st, allow)
	}
	if st, _ := send(""); st != "ok" { // as a script without an Origin sends it
		t.Fatalf("no Origin: %q", st)
	}
}

func TestOriginsOff(t *testing.T) {
	// The dev server's proxy passes the page's Origin on, so with no list it
	// must be served, not refused.
	h := newHarness(t, func(c *Config, _ *int) { c.AllowOrigins = nil })
	req, _ := http.NewRequest(http.MethodPost, h.http.URL, strings.NewReader(body("hold", "id", rnd(16), "c", rnd(16))))
	req.Header.Set("Content-Type", "text/plain")
	req.Header.Set("Origin", "http://localhost:5173")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var j struct{ St string }
	_ = json.NewDecoder(res.Body).Decode(&j)
	if j.St != "gone" {
		t.Fatalf("with no list, a browser's request: %q, want gone", j.St)
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "" || res.Header.Get("Vary") != "" {
		t.Fatal("with no origins, no CORS headers")
	}
}

func TestParseOrigins(t *testing.T) {
	got, err := ParseOrigins(" https://slynk.me, http://127.0.0.1:8293,https://slynk.me,")
	if err != nil || !slices.Equal(got, []string{"https://slynk.me", "http://127.0.0.1:8293"}) {
		t.Fatalf("got %q, %v", got, err)
	}
	if got, err := ParseOrigins(""); err != nil || got != nil {
		t.Fatalf("empty: %q, %v", got, err)
	}
	for _, o := range []string{"http://[::1]:8293", "http://[2001:db8::1]", "https://xn--bcher-kva.example", "https://k.example.org:8443", "http://203.0.113.7:1"} {
		if got, err := ParseOrigins(o); err != nil || len(got) != 1 {
			t.Errorf("%s: %q, %v", o, got, err)
		}
	}
	for _, blank := range []string{" ", ",", " , "} {
		if _, err := ParseOrigins(blank); err == nil {
			t.Errorf("%q names no origin, so it must be refused rather than mean no check", blank)
		}
	}
	for _, o := range []string{
		"null", "*", "https://*.slynk.me", "http://127.0.0.1:*", "https://slynk.me/", "https://slynk.me/x",
		"https://Slynk.me", "HTTPS://slynk.me", "slynk.me", "ftp://slynk.me", "https://slynk.me?x", "https://slynk.me#x",
		"https://u@slynk.me", "https://slynk.me:443", "http://127.0.0.1:80", "https://", "file:///x",
		// Written otherwise than browsers write them, so they'd never match.
		"http://127.0.0.1:08293", "http://127.0.0.1:", "http://127.0.0.1:0", "http://127.0.0.1:65536", "http://127.0.0.1:+80",
		"http://[0:0::1]:8293", "http://[::FFFF]", "http://[::ffff:127.0.0.1]", "http://[fe80::1%25eth0]", "http://[::1",
		"http://2130706433", "http://1.2.3", "http://127.000.0.1", "http://example.123", "http://example.0x7f",
		"http://exämple.org", "http://a_b.org", "http://-a.org", "http://a-.org", "http://a..org", "http://a.org.",
		"https://slynk.me;x", "https://slynk.me\\x",
	} {
		if _, err := ParseOrigins("https://slynk.me," + o); err == nil {
			t.Errorf("%q must be refused", o)
		}
	}
}

func TestClosedAfterSave(t *testing.T) {
	h := newHarness(t, nil)
	sh := newShare()
	expect(t, h.put(sh, ModeOneTime, 24), "ok")
	if err := h.store.Save(filepath.Join(t.TempDir(), "shutdown"), 0, h.clock.t.Load()); err != nil {
		t.Fatal(err)
	}
	expect(t, h.call("claim", "id", sh.id, "c", rnd(16)), "down")
	expect(t, h.put(newShare(), ModeOneTime, 24), "down")
	if r := h.store.recs[keyOf(id16(sh.id))]; r.kind != 'W' {
		t.Fatal("after the snapshot, nothing may change")
	}
}

func TestSlowBodyTakesNoSlot(t *testing.T) {
	h := newHarness(t, func(c *Config, _ *int) { c.MaxInFlight = 1 })
	conn, err := net.Dial("tcp", strings.TrimPrefix(h.http.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// Headers and a sliver of the body, then nothing: it waits for the rest.
	fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\nContent-Length: %d\r\n\r\n{\"v\":1,", RequestBytes)
	time.Sleep(50 * time.Millisecond)
	expect(t, h.call("hold", "id", rnd(16), "c", rnd(16)), "gone")
}

func TestLoadTruncated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "shutdown")
	now := int64(1_800_000_000)
	st := NewStore(10)
	st.recs[keyOf(id16(rnd(16)))] = record{kind: 'W', mode: ModeOneTime, exp: uint32(now + 3600)}
	if err := st.Save(path, 0, now); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	for _, cut := range []int{len(raw) - 1, len(raw) - 32, saveHead + 10, 4} {
		_ = os.WriteFile(path, raw[:cut], 0o600)
		got, restartedAt, err := Load(path, 10, now)
		if err != nil || got.Len() != 0 || restartedAt != now {
			t.Fatalf("cut at %d: %v %d %d", cut, err, got.Len(), restartedAt)
		}
	}
	_ = os.WriteFile(path, append(raw, 0), 0o600) // a byte too many
	if got, _, _ := Load(path, 10, now); got.Len() != 0 {
		t.Fatal("bytes after the checksum: not a file Save wrote")
	}
}

func TestCompactRecords(t *testing.T) {
	// 76 bytes, and 16 for the key: 2 million records fit a 1 GB server.
	if n := unsafe.Sizeof(record{}); n != 76 {
		t.Fatalf("a record is %d bytes in memory, not 76", n)
	}
	if recordBytes != 75 || slotBytes != 91 {
		t.Fatal("the shutdown file's records changed size")
	}
}

func fill16(n byte) (b [16]byte) {
	for i := range b {
		b[i] = n
	}
	return
}

func fill32(n byte) (b [32]byte) {
	for i := range b {
		b[i] = n
	}
	return
}

// testdata/shutdown-v1 was written by the program before compact records,
// at oldNow+30, after these requests at oldNow: the
// key server's first start after its update reads one like it.
const oldNow = 1_800_000_000

func oldRequests(t *testing.T, st *Store) {
	t.Helper()
	do := func(q request, oneTimeOnly bool) {
		if got, _ := st.do(q, oldNow, oneTimeOnly); got != "ok" {
			t.Fatalf("%s %x: %s", q.op, q.id[0], got)
		}
	}
	for n := byte(1); n <= 5; n++ {
		do(request{op: "put", id: fill16(n), s: fill32(0x40 + n), r: fill16(0x80 + n), mode: ModeOneTime, ttl: 24}, true)
	}
	do(request{op: "put", id: fill16(6), s: fill32(0x46), r: fill16(0x86), mode: ModeExpiring, ttl: 500}, false)
	do(request{op: "hold", id: fill16(2), c: fill16(0xc2)}, true)   // 2: held
	do(request{op: "claim", id: fill16(3), c: fill16(0xc3)}, true)  // 3: claimed
	do(request{op: "revoke", id: fill16(4), r: fill16(0x84)}, true) // 4: cancelled
	do(request{op: "claim", id: fill16(5), c: fill16(0xc5)}, true)  // 5: used
	do(request{op: "done", id: fill16(5), c: fill16(0xc5)}, true)
}

func copyOldFile(t *testing.T) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "shutdown-v1"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "shutdown")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadFormatBefore(t *testing.T) {
	path := copyOldFile(t)
	now := int64(oldNow + 60)
	st, restartedAt, err := Load(path, 1000, now)
	if err != nil {
		t.Fatal(err)
	}
	if restartedAt != 0 {
		t.Fatal("the format before is a clean shutdown too: nothing was lost")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("the shutdown file must be destroyed as soon as it's read")
	}
	// Exactly the records, rate limit and counts this version makes from the same requests.
	want := NewStore(1000)
	oldRequests(t, want)
	if !maps.Equal(st.recs, want.recs) || st.tok != want.tok || st.tm != want.tm {
		t.Fatalf("restored %d records, tok %d, tm %d; want %d, %d, %d", st.Len(), st.tok, st.tm, want.Len(), want.tok, want.tm)
	}
	wantStats := stats{rep: oldNow / 3600 * 3600, puts: 6, slow: 7, full: 8, usual: 12.5, wat: oldNow - 7200, wn: 10, wr: 11, wu: 3}
	if st.stats != wantStats {
		t.Fatalf("restored counts %+v", st.stats)
	}

	// And through the protocol.
	h := newHarness(t, func(c *Config, _ *int) { c.OneTimeOnly = false })
	h.clock.t.Store(now)
	h2 := &harness{t: t, clock: h.clock, store: st, srv: NewServer(h.srv.cfg, st, restartedAt)}
	h2.http = httptest.NewServer(h2.srv)
	defer h2.http.Close()
	b := func(x []byte) string { return b64u.EncodeToString(x) }
	id := func(n byte) string { x := fill16(n); return b(x[:]) }
	s := func(n byte) string { x := fill32(0x40 + n); return b(x[:]) }
	c := func(n byte) string { x := fill16(0xc0 + n); return b(x[:]) }
	r := func(n byte) string { x := fill16(0x80 + n); return b(x[:]) }
	claim := func(n byte, nonce, st, share string) {
		t.Helper()
		got := h2.call("claim", "id", id(n), "c", nonce)
		expect(t, got, st)
		if (share != "" && got.s != share) || got.r != 0 {
			t.Fatalf("claim %d: s %s, r %d", n, got.s, got.r)
		}
	}
	claim(1, rnd(16), "ok", s(1))
	claim(2, rnd(16), "held", "")
	claim(2, c(2), "ok", s(2))
	claim(3, c(3), "ok", s(3)) // a claim may still be repeated
	expect(t, h2.call("done", "id", id(3), "c", c(3)), "ok")
	claim(3, c(3), "gone", "")
	expect(t, h2.call("revoke", "id", id(4), "r", r(4)), "ok") // repeating a cancel
	claim(4, rnd(16), "gone", "")
	expect(t, h2.put(share{id(5), s(5), r(5)}, ModeOneTime, 24), "exists") // a used link's ID stays taken
	if got := h2.call("get", "id", id(6)); got.st != "ok" || got.s != s(6) {
		t.Fatalf("get 6: %s %s", got.st, got.s)
	}

	// Saved again, it's in the compact format, and comes back the same.
	saved := maps.Clone(st.recs)
	if err := st.Save(path, 0, now); err != nil {
		t.Fatal(err)
	}
	if raw, _ := os.ReadFile(path); !bytes.HasPrefix(raw, []byte(saveMagic)) || len(raw) != saveHead+len(saved)*slotBytes+sha256.Size {
		t.Fatal("saved again: not in the compact format")
	}
	st, _, _ = Load(path, 1000, now)
	if !maps.Equal(st.recs, saved) {
		t.Fatal("saved again and loaded: not the same records")
	}
}

func TestLoadFormatBeforeDamaged(t *testing.T) {
	for _, damage := range []func([]byte) []byte{
		func(raw []byte) []byte { raw[len(raw)/2] ^= 1; return raw },
		func(raw []byte) []byte { return raw[:len(raw)-1] },
		func(raw []byte) []byte { raw[len(saveMagic)-1] = 3; return raw }, // a version this one doesn't know
	} {
		path := copyOldFile(t)
		raw, _ := os.ReadFile(path)
		_ = os.WriteFile(path, damage(raw), 0o600)
		st, restartedAt, err := Load(path, 1000, oldNow+60)
		if err != nil || st.Len() != 0 || restartedAt != oldNow+60 {
			t.Fatalf("damaged: %v %d %d", err, st.Len(), restartedAt)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatal("a damaged file must be destroyed too")
		}
	}
}
