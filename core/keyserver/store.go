package keyserver

import (
	"crypto/sha256"
	"crypto/subtle"
	"math"
	"sync"
)

// record is one share's state: kind W (waiting), C (claimed) or
// T (a tombstone, kept until the link would have expired so its ID can't be
// reused). For C, at and hc are when it was claimed and the claimer's nonce,
// hashed; for W, the latest hold's (at 0: none). hr is the sender's cancel
// token, hashed. flags is a tombstone's reason.
//
// It's compact, 76 bytes, so 2 million fit a 1 GB server: times as uint32
// Unix seconds (enough until 2106), and the hashes (and keyOf) cut to 16
// bytes, which still take about 2^128 tries to match one that's kept.
type record struct {
	kind  byte
	mode  byte
	flags byte
	exp   uint32
	at    uint32
	hr    [16]byte
	s     [32]byte
	hc    [16]byte
}

// Store holds every share in memory. The zero value isn't usable: see NewStore.
type Store struct {
	mu   sync.RWMutex
	recs map[[16]byte]record
	max  int // MaxRecords: new links are refused "full" beyond it

	// The rate limit: tok new links allowed, as of the minute tm.
	tok int64
	tm  int64

	stats stats

	// closed is set by Save: from then on every request is answered "down"
	// and changes nothing, so nothing happens after the snapshot is taken.
	closed bool
}

// NewStore makes an empty store that keeps at most max records.
func NewStore(max int) *Store {
	return &Store{recs: make(map[[16]byte]record), max: max, tok: BurstPuts}
}

// keyOf is the map key for an ID: SHA-256(NamePrefix || id), cut to 16
// bytes.
func keyOf(id [16]byte) [16]byte {
	h := sha256.Sum256(append([]byte(NamePrefix), id[:]...))
	return [16]byte(h[:16])
}

// hash16 is a cancel token's or nonce's hash as a record keeps it: the first 16 bytes of its SHA-256.
func hash16(b [16]byte) [16]byte {
	h := sha256.Sum256(b[:])
	return [16]byte(h[:16])
}

func same(a, b [16]byte) bool { return subtle.ConstantTimeCompare(a[:], b[:]) == 1 }

// u32 is a time as a record keeps it (Unix seconds).
func u32(t int64) uint32 { return uint32(min(max(t, 0), math.MaxUint32)) }

func roundUp(t, step int64) int64 { return (t + step - 1) / step * step }

func tombstone(r record, reason byte) record {
	return record{kind: 'T', mode: r.mode, flags: reason, exp: u32(roundUp(int64(r.exp), ExpiryStep)), hr: r.hr}
}

// clean is a record after the clean-up, and false if it goes: expired shares
// and tombstones go; claims past their retry window become tombstones (or go,
// if expired); lapsed holds are forgotten. A claim stays until its retry
// window ends, even past its expiry, so the claimer can still ask again.
func clean(r record, now int64) (record, bool) {
	switch {
	case r.kind == 'C':
		if now-int64(r.at) >= ClaimRetry {
			if now < int64(r.exp) {
				return tombstone(r, reasonUsed), true
			}
			return record{}, false
		}
	case now >= int64(r.exp):
		return record{}, false
	case r.kind == 'W' && r.at != 0 && now-int64(r.at) >= Hold:
		r.at, r.hc = 0, [16]byte{}
	}
	return r, true
}

// put sets key's record, cleaned; nil removes it. The lock must be held.
// Go's map zeroes a deleted entry's memory, so a deleted share doesn't linger
// there (copies the runtime made elsewhere, as a map grows, may until reused).
func (st *Store) put(key [16]byte, r *record, now int64) {
	if r != nil {
		if c, keep := clean(*r, now); keep {
			st.recs[key] = c
			return
		}
	}
	delete(st.recs, key)
}

// Known reports whether the store has any record for this ID. Every cover
// request asks about an ID nobody has, and is answered "gone" from this
// alone, under a read lock.
func (st *Store) Known(id [16]byte) bool {
	st.mu.RLock()
	defer st.mu.RUnlock()
	_, ok := st.recs[keyOf(id)]
	return ok
}

// Len is how many records the store keeps (waiting shares, claims and tombstones).
func (st *Store) Len() int {
	st.mu.RLock()
	defer st.mu.RUnlock()
	return len(st.recs)
}

// allowance is the rate limit's allowance now: what was left at its minute,
// and PutsPerMinute for each minute since, up to BurstPuts.
func (st *Store) allowance(now int64) int64 {
	return min(BurstPuts, st.tok+PutsPerMinute*max(0, now/60-st.tm))
}

// do runs one request, already parsed and its puzzle checked, and returns its
// outcome and, for a successful claim or get, the share.
func (st *Store) do(q request, now int64, oneTimeOnly bool) (string, *[32]byte) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.closed {
		return "down", nil
	}
	key := keyOf(q.id)
	r, found := st.recs[key]
	var rp *record
	if found {
		rp = &r
	}
	switch q.op {
	case "put":
		return st.opPut(q, key, rp, now, oneTimeOnly), nil
	case "hold":
		return st.opHold(q, key, rp, now), nil
	case "claim":
		return st.opClaim(q, key, rp, now)
	case "get":
		return opGet(rp, now, oneTimeOnly)
	case "done":
		return st.opDone(q, key, rp, now), nil
	case "revoke":
		return st.opRevoke(q, key, rp, now), nil
	}
	return "bad", nil
}

// expired reports whether this record has expired (it goes at the next
// clean-up), and if hr is given, belongs to that cancel token.
func expired(r *record, now int64, hr *[16]byte) bool {
	return r != nil && now >= int64(r.exp) && (hr == nil || same(r.hr, *hr))
}

func gone(r *record, now int64) string {
	if expired(r, now, nil) {
		return "expired"
	}
	return "gone"
}

// heldByOther: a waiting share held by someone else, and not yet lapsed.
func heldByOther(r *record, hc [16]byte, now int64) bool {
	return r.at != 0 && now-int64(r.at) < Hold && !same(r.hc, hc)
}

// ownClaim: a claim this opener made and may still ask for again.
func ownClaim(r *record, hc [16]byte, now int64) bool {
	return r != nil && r.kind == 'C' && same(r.hc, hc) && now-int64(r.at) < ClaimRetry
}

func (st *Store) opPut(q request, key [16]byte, r *record, now int64, oneTimeOnly bool) string {
	if q.mode == ModeExpiring && oneTimeOnly {
		return "bad"
	}
	hr := hash16(q.r)
	// An ID already here adds nothing, so it's answered before the limits and
	// counts towards none: the same solution sent again and again can't use
	// up the rate limit.
	if r != nil {
		if r.kind == 'W' && int(r.mode) == q.mode && subtle.ConstantTimeCompare(r.s[:], q.s[:]) == 1 && same(r.hr, hr) {
			return "ok" // the sender repeating a put whose answer it lost
		}
		return "exists"
	}
	st.tok = st.allowance(now)
	st.tm = now / 60
	if st.tok < 1 {
		st.stats.slow++
		return "slow"
	}
	if len(st.recs) >= st.max {
		st.stats.full++
		return "full"
	}
	st.tok--
	exp := u32(roundUp(now+int64(q.ttl)*3600+ExpiryGrace, ExpiryStep))
	st.put(key, &record{kind: 'W', mode: byte(q.mode), exp: exp, hr: hr, s: q.s}, now)
	st.stats.puts++
	return "ok"
}

func (st *Store) opHold(q request, key [16]byte, r *record, now int64) string {
	hc := hash16(q.c)
	if ownClaim(r, hc, now) {
		return "ok" // this opener has claimed it already: its claim can be repeated
	}
	if r != nil && r.kind == 'W' && r.mode == ModeOneTime {
		if now >= int64(r.exp) {
			return "expired"
		}
		if heldByOther(r, hc, now) {
			return "held"
		}
		held := *r
		held.at, held.hc = u32(roundUp(now, HoldStep)), hc
		st.put(key, &held, now)
		return "ok"
	}
	return gone(r, now)
}

func (st *Store) opClaim(q request, key [16]byte, r *record, now int64) (string, *[32]byte) {
	hc := hash16(q.c)
	if ownClaim(r, hc, now) {
		s := r.s
		return "ok", &s // the claimer asking again after a lost answer
	}
	if r != nil && r.kind == 'W' && r.mode == ModeOneTime {
		if now >= int64(r.exp) {
			return "expired", nil
		}
		if heldByOther(r, hc, now) {
			return "held", nil
		}
		// The claim itself. The lock keeps claims apart, so exactly one finds the share waiting.
		claimed := record{kind: 'C', mode: r.mode, exp: r.exp, at: u32(roundUp(now, HoldStep)), hr: r.hr, s: r.s, hc: hc}
		st.put(key, &claimed, now)
		s := r.s
		return "ok", &s
	}
	return gone(r, now), nil
}

func opGet(r *record, now int64, oneTimeOnly bool) (string, *[32]byte) {
	if r != nil && r.kind == 'W' && r.mode == ModeExpiring && now < int64(r.exp) && !oneTimeOnly {
		s := r.s
		return "ok", &s
	}
	return gone(r, now), nil
}

func (st *Store) opDone(q request, key [16]byte, r *record, now int64) string {
	if r != nil && r.kind == 'C' && same(r.hc, hash16(q.c)) {
		// A tombstone takes its place, unless the link has expired: then the clean-up drops it at once.
		t := tombstone(*r, reasonUsed)
		st.put(key, &t, now)
		return "ok"
	}
	return "gone"
}

func (st *Store) opRevoke(q request, key [16]byte, r *record, now int64) string {
	hr := hash16(q.r)
	if r != nil && r.kind == 'W' && same(r.hr, hr) {
		if now >= int64(r.exp) {
			st.put(key, nil, now)
			return "expired"
		}
		t := tombstone(*r, reasonCancelled)
		st.put(key, &t, now)
		return "ok"
	}
	if r != nil && r.kind == 'T' && same(r.hr, hr) && r.flags == reasonCancelled && now < int64(r.exp) {
		return "ok" // the sender repeating a cancel whose answer it lost
	}
	// A wrong token gets the same answer as a missing share, so it reveals nothing.
	if expired(r, now, &hr) {
		return "expired"
	}
	return "gone"
}

// Sweep runs the clean-up over every record, and returns how many are kept.
func (st *Store) Sweep(now int64) int {
	st.mu.Lock()
	defer st.mu.Unlock()
	for k, r := range st.recs {
		if c, keep := clean(r, now); !keep {
			delete(st.recs, k)
		} else if c != r {
			st.recs[k] = c
		}
	}
	if st.allowance(now) >= BurstPuts {
		st.tok, st.tm = BurstPuts, 0 // the latest new link's minute isn't needed any more
	}
	return len(st.recs)
}
