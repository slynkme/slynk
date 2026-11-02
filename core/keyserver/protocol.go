// Package keyserver keeps slynk.me's half of each one-time link's key (the
// share S) in memory, and answers the page's requests for it (web/src/burn.ts):
// every answer exactly ResponseBytes of JSON and none sooner than MinResponse.
// Background: docs/findings/one-time-links.md.
//
// How it runs:
//   - Shares live only in this program's memory. At a clean shutdown the
//     records (waiting shares, claims still holding one, tombstones) are
//     written to a file (Save), which the next start reads
//     back and destroys before answering anything (Load). A crash loses them,
//     and for the next MaxTTLHours every answer says so ("r":1), so an opener
//     whose link was lost is told why instead of "used or cancelled".
//   - A map, one lock and an hourly clean-up.
//   - Requests may come as text/plain, so a browser on another origin
//     (slynk.me) sends them without a CORS preflight.
//   - The clean-up's hourly line goes to a status file.
package keyserver

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math/bits"
	"regexp"
	"strconv"
)

// The protocol's sizes and limits. Each matches the constant of the same
// meaning in the page's client (burn.ts, linkv2.ts).
const (
	RequestBytes  = 256
	ResponseBytes = 128
	MaxTTLHours   = 500 // the mixnet keeps data for about 500 hours
	// Seconds past a link's stated expiry that its share is still kept: the
	// put comes just before the upload stamps the link's sent time, and the
	// sender's clock may run a little fast.
	ExpiryGrace = 600
	ClaimRetry  = 600 // seconds a claimer may repeat its claim with the same nonce
	Hold        = 900 // seconds an opener's tap keeps others out
	// The rate limit, for everyone together (no IP addresses): PutsPerMinute
	// on average, up to BurstPuts at once after a quiet spell.
	PutsPerMinute = 60
	BurstPuts     = 600
	PowWindow     = 600 // seconds: a puzzle is solved for this window or the one before
	PowLabel      = "slynk/v1/pow"
	ExpiryStep    = 3600 // expiries are rounded up to the hour
	HoldStep      = 60   // holds' and claims' times, up to the minute
	NamePrefix    = "slynk-burn-v1"

	ModeExpiring = 1
	ModeOneTime  = 2

	reasonUsed      = 1
	reasonCancelled = 2
)

// The fields each operation must have, and no others (besides v, op and p).
var fields = map[string][]string{
	"put":    {"id", "s", "r", "m", "t", "w"},
	"hold":   {"id", "c"},
	"claim":  {"id", "c"},
	"get":    {"id"},
	"done":   {"id", "c"},
	"revoke": {"id", "r"},
}

// request is a parsed, valid request. Byte fields not used by its operation are zero.
type request struct {
	op   string
	id   [16]byte
	s    [32]byte
	r    [16]byte
	c    [16]byte
	w    [8]byte
	mode int
	ttl  int // hours
}

var (
	b64u     = base64.RawURLEncoding
	b64uText = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	dots     = regexp.MustCompile(`^\.*$`)
	// JSON integers as the protocol takes them: no sign, fraction, exponent or leading zero.
	jsonInt = regexp.MustCompile(`^[1-9][0-9]{0,8}$`)
)

// parseRequest reads a request body, and reports false for anything the
// server answers "bad".
func parseRequest(body []byte) (request, bool) {
	var q request
	if len(body) != RequestBytes {
		return q, false
	}
	var j map[string]json.RawMessage
	if json.Unmarshal(body, &j) != nil || j == nil {
		return q, false
	}
	if string(j["v"]) != "1" {
		return q, false
	}
	var op string
	if raw, ok := j["op"]; !ok || json.Unmarshal(raw, &op) != nil {
		return q, false
	}
	want, ok := fields[op]
	if !ok || len(j) != len(want)+3 {
		return q, false
	}
	for _, k := range append([]string{"p"}, want...) {
		if _, ok := j[k]; !ok {
			return q, false
		}
	}
	var p string
	if !bytes.HasPrefix(j["p"], []byte(`"`)) || json.Unmarshal(j["p"], &p) != nil || !dots.MatchString(p) {
		return q, false // must be a string of dots (JSON null would decode to "")
	}
	q.op = op
	if !b64uField(j["id"], q.id[:]) {
		return q, false
	}
	for _, f := range want {
		var ok bool
		switch f {
		case "s":
			ok = b64uField(j[f], q.s[:])
		case "r":
			ok = b64uField(j[f], q.r[:])
		case "c":
			ok = b64uField(j[f], q.c[:])
		case "w":
			ok = b64uField(j[f], q.w[:])
		case "m":
			q.mode, ok = intField(j[f], 1, 2)
		case "t":
			q.ttl, ok = intField(j[f], 1, MaxTTLHours)
		default:
			ok = true // id, done above
		}
		if !ok {
			return q, false
		}
	}
	return q, true
}

// b64uField decodes a JSON string of unpadded base64url into exactly len(out)
// bytes, accepting only its one canonical spelling.
func b64uField(raw json.RawMessage, out []byte) bool {
	var s string
	if json.Unmarshal(raw, &s) != nil || !b64uText.MatchString(s) {
		return false
	}
	b, err := b64u.DecodeString(s)
	if err != nil || len(b) != len(out) || b64u.EncodeToString(b) != s {
		return false
	}
	copy(out, b)
	return true
}

func intField(raw json.RawMessage, lo, hi int) (int, bool) {
	if !jsonInt.Match(raw) {
		return 0, false
	}
	n, err := strconv.Atoi(string(raw))
	return n, err == nil && n >= lo && n <= hi
}

// solved reports whether w solves the puzzle for this ID: SHA-256(PowLabel ||
// id || n || w) starts with at least powBits zero bits, where n is the number
// of PowWindow-second spans since 1970 (4 bytes, big-endian), now's or the
// one before. powBits 0 turns the puzzle off.
func solved(id [16]byte, w [8]byte, now int64, powBits int) bool {
	if powBits <= 0 {
		return true
	}
	window := now / PowWindow
	return solvesWindow(id, w, window, powBits) || solvesWindow(id, w, window-1, powBits)
}

// solvesWindow reports whether w solves the puzzle for this ID in window n.
func solvesWindow(id [16]byte, w [8]byte, n int64, powBits int) bool {
	var msg []byte
	msg = append(msg, PowLabel...)
	msg = append(msg, id[:]...)
	msg = binary.BigEndian.AppendUint32(msg, uint32(n))
	msg = append(msg, w[:]...)
	return zeroBits(sha256.Sum256(msg)) >= powBits
}

func zeroBits(h [32]byte) int {
	n := 0
	for _, b := range h {
		if b != 0 {
			return n + bits.LeadingZeros8(b)
		}
		n += 8
	}
	return n
}

// answer is the body of every response: exactly ResponseBytes of JSON, with
// share (or 32 random bytes) in "s", the cover gap, the puzzle's difficulty,
// this server's time, and whether it restarted without its shares lately.
// It's built in one byte slice, so the caller can wipe the share's copy.
func answer(st string, share *[32]byte, coverGap, powBits int, now int64, restarted bool) []byte {
	var s [32]byte
	if share != nil {
		s = *share
	} else {
		_, _ = rand.Read(s[:])
	}
	r := 0
	if restarted {
		r = 1
	}
	b := make([]byte, 0, ResponseBytes)
	b = append(b, `{"v":1,"st":"`...)
	b = append(b, st...)
	b = append(b, `","s":"`...)
	b = b64u.AppendEncode(b, s[:])
	clear(s[:])
	b = append(b, `","g":`...)
	b = strconv.AppendInt(b, int64(coverGap), 10)
	b = append(b, `,"d":`...)
	b = strconv.AppendInt(b, int64(powBits), 10)
	b = append(b, `,"t":`...)
	b = strconv.AppendInt(b, now, 10)
	b = append(b, `,"r":`...)
	b = strconv.AppendInt(b, int64(r), 10)
	b = append(b, `,"p":"`...)
	for len(b) < ResponseBytes-2 {
		b = append(b, '.')
	}
	return append(b, `"}`...)
}
