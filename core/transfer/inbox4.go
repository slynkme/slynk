package transfer

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hpke"
	"crypto/mlkem"
	"crypto/rand"
	"crypto/sha256"
	"slices"
	"sync"
	"time"

	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/xx_network/primitives/id"
)

// An inbox's quantum-safe address (docs/findings/quantum-safety.md; the
// prototype is in lab/pq-inbox). The
// same 12 words make the same inbox as its compact address, with the same
// ed25519 and X25519 keys and mailbox, and an ML-KEM-768 key too, which the
// inbox signs with its ed25519 key:
//
//	address: version(4) ed25519PublicKey(32) mlkem768EncapsulationKey(1184) signature(64)
//
// The signature ties the ML-KEM key to the inbox: without it, anyone could
// put their own ML-KEM key beside a real inbox's ed25519 key (which its
// compact address publishes) and pass the result off as that inbox. Only the
// words can sign, and Ed25519 signs deterministically, so Slynk makes exactly
// one quantum-safe address for an inbox (its owner, and nobody else, could
// make another with a signature of their own making; the page tells inboxes
// apart by their compact address, so it would be the same inbox). The
// ed25519 key's scalar is also the inbox's X25519 key: one key for signing
// and for X25519 key exchange, as Signal's XEdDSA has. Thormarker proved that
// sound for Ed25519 with an X25519 KEM ("On using the same key pair for
// Ed25519 and an X25519 based KEM", IACR ePrint 2021/509), which covers the
// compact notices' DHKEM and, the same way, X-Wing's X25519 half. The key's
// other uses, the reply proof's static-static key and the pairing tag, only
// ever put an X25519 result through a KDF and keep it, so they answer nobody
// anything that could help forge a signature. It can't be otherwise here:
// the signature must check against the key the compact address already has.
// It signs this one thing, under its own label.
//
// A notice to it is sealed with HPKE's MLKEM768-X25519 hybrid (X-Wing; the
// sender's side is in xwing.go, the owner's is Go's crypto/hpke), made of
// that ML-KEM key and the inbox's own X25519 key. It stays safe while either
// half holds: ML-KEM against a future quantum computer, X25519 against a flaw
// found in the much younger ML-KEM. The KDF and AEAD are a compact notice's,
// under its own info string. X-Wing's encapsulated key is ML-KEM's ciphertext
// followed by an X25519 key. The X25519 key is encoded with Elligator 2, as a
// compact notice's is, and the ciphertext with Kemeleon (kemeleon.go), so
// both look random:
//
//	stream: key(32) kem(1252) sealed(plaintext)
//
// That fills two messages' streams, cut in two, but for the pairing tag(8)
// the second one starts with (pairing, below). Both go to the inbox's usual
// mailbox, in the same round (xxDK's SendManyWithAssembler) or a few seconds
// apart, each in a round of its own (apart.go; the website always sends them
// apart, since 2026-10-19). In one round, going in, that's the shape of an xx DM, two
// messages in one round; but a DM's two go to two mailboxes (the partner's
// and the sender's own), and these two to one, which the round's gateways,
// and anyone with the address, can count. Apart, each is one message in its
// round, as any compact notice is.
//
// The ML-KEM key is made from the words with HKDF, so the words stay the only
// secret. The X25519 key is the one compact notices and reply proofs use,
// under other labels; the ML-KEM half has its own key, so the quantum-safe
// half doesn't rest on that reuse.
const (
	inboxAddress4Version = 4
	InboxAddress4Len     = InboxAddressLen + mlkem.EncapsulationKeySize768 + ed25519.SignatureSize // 1281

	// pieces4 is how many cMix messages a quantum-safe notice fills.
	pieces4 = 2
	// keys4Len is the encoded X25519 key and ML-KEM ciphertext, and overhead4
	// those, the pairing tag, the AEAD's tag and the notice's header.
	keys4Len  = keyRepLen + Kem768Len
	overhead4 = keys4Len + pairTagLen + 16 + noticeHeaderLen

	inboxMLKEMInfo    = "slynk/inbox/v4/mlkem768"
	inboxAddress4Info = "slynk/inbox/v4/address"
	inboxNotice4Info  = "slynk/inbox/v4/notice"
	inboxPairInfo     = "slynk/inbox/v4/pair"
)

// MaxNoticeBody4 is the most a quantum-safe notice can carry for messages of
// msgLen bytes.
func MaxNoticeBody4(msgLen int) int {
	return pieces4*noticeStreamLen(msgLen) - overhead4
}

// plaintext4Len is the size of a quantum-safe notice's plaintext.
func plaintext4Len(streamLen int) int {
	return pieces4*streamLen - keys4Len - pairTagLen - 16
}

// inboxKey4 makes an inbox's quantum-safe address and X-Wing key from its
// words' entropy, its ed25519 key, its compact address and its X25519 key.
func inboxKey4(entropy []byte, priv ed25519.PrivateKey, addr *InboxAddress, xpriv *ecdh.PrivateKey) (*InboxAddress, hpke.PrivateKey, error) {
	seed, err := hkdf.Key(sha256.New, entropy, nil, inboxMLKEMInfo, mlkem.SeedSize)
	if err != nil {
		return nil, nil, err
	}
	dk, err := mlkem.NewDecapsulationKey768(seed)
	if err != nil {
		return nil, nil, err
	}
	sk, err := hpke.NewHybridPrivateKey(dk, xpriv)
	if err != nil {
		return nil, nil, err
	}
	ek := dk.EncapsulationKey()
	addr4, err := withMLKEM(addr, ek, ed25519.Sign(priv, address4Signed(ek.Bytes())))
	if err != nil {
		return nil, nil, err
	}
	return addr4, sk, nil
}

// address4Signed is what an inbox signs to make its quantum-safe address: its
// ML-KEM key, under a label of its own.
func address4Signed(ek []byte) []byte {
	return append([]byte(inboxAddress4Info), ek...)
}

// parseInboxAddress4 checks a binary quantum-safe address: the ed25519 key as
// a compact address's, the signature on the ML-KEM key, and the ML-KEM key as
// FIPS 203 asks (crypto/mlkem refuses one whose numbers aren't all below q).
//
// Nothing checks that an ML-KEM key is well made: FIPS 203 has no way to, and
// a key chosen badly on purpose (made of small numbers, say) passes for any
// other. The signature means only the inbox's owner can choose it, and a bad
// one would only weaken their own inbox: what's sent to it would no longer be
// quantum-safe, and could be told from random bytes once it has crossed the
// network, where nothing ties it to its sender more than the round already
// does (on the way in, the network's own encryption covers it). The X25519
// half still keeps it from everyone else today.
func parseInboxAddress4(b []byte) (*InboxAddress, error) {
	a, err := newInboxAddress(ed25519.PublicKey(bytes.Clone(b[1:InboxAddressLen])))
	if err != nil {
		return nil, err
	}
	ekBytes := b[InboxAddressLen : InboxAddressLen+mlkem.EncapsulationKeySize768]
	sig := b[InboxAddressLen+mlkem.EncapsulationKeySize768:]
	if !ed25519.Verify(a.pub, address4Signed(ekBytes), sig) {
		return nil, ErrInboxAddress
	}
	ek, err := mlkem.NewEncapsulationKey768(ekBytes)
	if err != nil {
		return nil, ErrInboxAddress
	}
	return withMLKEM(a, ek, bytes.Clone(sig))
}

func withMLKEM(a *InboxAddress, ek *mlkem.EncapsulationKey768, sig []byte) (*InboxAddress, error) {
	pk, err := hpke.NewHybridPublicKey(ek, a.xpub)
	if err != nil {
		return nil, ErrInboxAddress
	}
	return &InboxAddress{pub: a.pub, xpub: a.xpub, mailbox: a.mailbox, ek: ek, sig: sig, pk4: pk}, nil
}

// pairTag is the tag a quantum-safe notice's second message starts with,
// worked out from X-Wing's X25519 shared secret: only the sender and the
// inbox's owner can work it out, and to anyone else it's as random as the
// rest. It lets the owner find which message pairs with which by looking it
// up, rather than trying every pair, as xx's end-to-end messages carry a
// fingerprint only the two ends can work out. Anyone who could later break
// X25519 could tell which two messages pair, which the round already shows;
// what they say stays behind ML-KEM.
func pairTag(ssT []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, ssT, nil, inboxPairInfo, pairTagLen)
}

// sealPlaintext4 seals pt to a quantum-safe address with a fresh X-Wing
// encapsulation, encoded so all of it looks random, and gives the pieces4
// streams of streamLen bytes it fills: the stream cut in two, the second
// starting with the pairing tag. The encoded keys and the tag are the AEAD's
// associated data, so a re-encoded copy won't open. prove, if given,
// finishes pt once they're known.
func sealPlaintext4(to *InboxAddress, pt []byte, prove func(aad []byte), streamLen int) ([][]byte, error) {
	if len(pt) != plaintext4Len(streamLen) {
		return nil, errors.Errorf("plaintext is %d bytes, need %d", len(pt), plaintext4Len(streamLen))
	}
	// A one-time X25519 key Elligator can encode, as for a compact notice:
	// about half are, and one that isn't is dropped, never re-encoded.
	var skE *ecdh.PrivateKey
	var rep []byte
	for range 128 {
		k, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		r, ok, err := hideKey(k.PublicKey().Bytes())
		if err != nil {
			return nil, err
		}
		if ok {
			skE, rep = k, r
			break
		}
	}
	if skE == nil {
		return nil, errors.New("couldn't encode a one-time key")
	}
	ssT, err := skE.ECDH(to.xpub)
	if err != nil {
		return nil, err
	}
	// An ML-KEM encapsulation Kemeleon can encode: about 77% are. A rejected
	// one means encapsulating again: encoding the same one again would bias
	// which ones get sent. (Keeping the X25519 key meanwhile biases nothing:
	// it's chosen apart from the ciphertext, and used once.)
	var ssPQ, kem []byte
	for range 64 {
		ss, ct := to.ek.Encapsulate()
		k, err := kemeleonEncode768(ct)
		if errors.Is(err, errKemeleonReject) {
			continue
		}
		if err != nil {
			return nil, err
		}
		ssPQ, kem = ss, k
		break
	}
	if kem == nil {
		return nil, errors.New("couldn't encode the ML-KEM ciphertext")
	}
	aead, nonce, err := hpkeContext(xwingSuite, hpkeModeBase, xwingSecret(ssPQ, ssT, skE.PublicKey().Bytes(), to.xpub.Bytes()), []byte(inboxNotice4Info), nil, nil)
	if err != nil {
		return nil, err
	}
	tag, err := pairTag(ssT)
	if err != nil {
		return nil, err
	}
	aad := slices.Concat(rep, kem, tag)
	if prove != nil {
		prove(aad)
	}
	stream := slices.Concat(rep, kem, aead.Seal(nil, nonce, pt, aad))
	return [][]byte{stream[:streamLen], slices.Concat(tag, stream[streamLen:])}, nil
}

// half is a message as the owner tries it: its stream; the X25519 key its
// first 32 bytes reveal (nil if they reveal none), worked out once however
// many ways it's tried; X25519 of that and the inbox's key, worked out once
// for a reply and the pairing tag alike; and, once it has failed as a compact
// notice, the pairing tag its second half would start with if it's a first
// half (want).
type half struct {
	stream []byte
	ctT    []byte
	dh     []byte
	dhDone bool // whether dh has been worked out (it stays nil if it can't be)
	want   [pairTagLen]byte
	wants  bool // whether want is set

	// round is the round it came in, at that round's time (as shown), and
	// start when it started (its QUEUED time, zero if not known), for pairing.
	round id.Round
	at    time.Time
	start time.Time
	// inFirsts and inSeconds say where it's held for pairing, if anywhere.
	inFirsts, inSeconds bool
}

func newHalf(stream []byte) *half {
	if len(stream) < keyRepLen {
		return &half{stream: stream}
	}
	ctT, err := revealKey(stream[:keyRepLen])
	if err != nil {
		ctT = nil
	}
	return &half{stream: stream, ctT: ctT}
}

// tag is the pairing tag m starts with if it's a second half.
func (m *half) tag() (t [pairTagLen]byte) {
	copy(t[:], m.stream)
	return t
}

// shared is X25519 of the inbox's key and the revealed key, as the sender
// worked it out from the other side, or nil if there's none. It's worked out
// the first time it's asked for, before m is held, by whoever made m.
func (m *half) shared(key *InboxKey) []byte {
	if m.dhDone {
		return m.dh
	}
	m.dhDone = true
	if m.ctT == nil {
		return nil
	}
	pub, err := ecdh.X25519().NewPublicKey(m.ctT)
	if err != nil {
		return nil
	}
	if m.dh, err = key.xpriv.ECDH(pub); err != nil {
		m.dh = nil
	}
	return m.dh
}

// findWant works out want, from the shared X25519 result.
func (m *half) findWant(key *InboxKey) {
	ss := m.shared(key)
	if ss == nil {
		return
	}
	tag, err := pairTag(ss)
	if err != nil {
		return
	}
	copy(m.want[:], tag)
	m.wants = true
}

// openNotice4 tries first and second as the two halves of a quantum-safe
// notice, in that order. The tag second starts with is associated data, so
// a pair that isn't one won't open, whether or not the tags matched.
func openNotice4(key *InboxKey, first *half, second []byte) (opened, error) {
	if first.ctT == nil || len(second) < pairTagLen {
		return opened{}, errors.New("not a pair")
	}
	stream := append(bytes.Clone(first.stream), second[pairTagLen:]...)
	if len(stream) < keys4Len+16 {
		return opened{}, errors.New("too short")
	}
	ctPQ, err := kemeleonDecode768(stream[keyRepLen:keys4Len])
	if err != nil {
		return opened{}, err
	}
	r, err := hpke.NewRecipient(append(ctPQ, first.ctT...), key.sk4, noticeKDF, noticeAEAD, []byte(inboxNotice4Info))
	if err != nil {
		return opened{}, err
	}
	aad := slices.Concat(stream[:keys4Len], second[:pairTagLen])
	pt, err := r.Open(aad, stream[keys4Len:])
	if err != nil {
		return opened{}, err
	}
	o, err := readPlaintext(key, aad, pt, modeQS)
	if err != nil {
		return opened{}, err
	}
	o.quantum = true
	return o, nil
}

const (
	// pairKeep is how long what's held of a round is kept after its last
	// message came. A notice sent whole brings both halves in one round, so
	// they come in the same pickup, moments apart; one sent apart, its second
	// within apartRounds of its first (apart.go), in a pickup of its own,
	// which the network may fail to hand over and xxDK tries again after
	// seconds, minutes or longer. A look-back reads past days newest first,
	// and a day's rounds oldest first (the xxdk-client patch in cmix/
	// follow.go), so the two come moments apart there too, unless the
	// mailbox's daily label changed between them: then a day's reading or
	// more apart. What's held is bounded by pairHeld, not by time, so an hour
	// costs nothing more.
	pairKeep = time.Hour
	// pairTagLen is the pairing tag's size: a pair that isn't one matches by
	// chance one time in 2^64.
	pairTagLen = 8
	// Messages that don't open as compact notices or replies are held, up to
	// pairPerRound of a round's, for the ones after them; pairHeld bounds
	// what's held in all (about 1 KB a message, so about 13 MB, only ever
	// under a flood): more than a flood can put between two halves sent
	// apart, which go at most about 90 rounds apart (a minute's pause and
	// the first's confirmation; apart.go), at pairPerRound a round. Honest
	// rounds bring a mailbox one or two messages. A tag matches at most pairPerTag
	// held messages each way: a notice's tag is its own, so one is all it
	// needs, and a message crafted to match held ones (by someone who made
	// its key, and so knows its tag) costs one try, about what a notice costs
	// to open.
	pairPerRound = 128
	pairHeld     = 12288
	pairPerTag   = 1
)

// pairing holds the messages that didn't open as compact notices or replies,
// to be matched with the ones that come after them: each message as a
// possible first half, by the tag its second half would start with, and as a
// possible second half, by the tag it starts with. Each costs one X25519
// multiplication and a lookup, whatever else came, and only a matching pair
// in rounds no more than apartRounds apart is tried.
//
// A pair that opens is a notice if it was sealed for the round of its two
// that started first (startsBefore; the same round, for a notice sent
// whole): the first half to go is sealed for its own round, and the second
// goes in a round that starts after that one has finished (apart.go). Anyone
// with the inbox's address can fetch its messages and send one again, so a
// pair that opens but was sealed for another round is a copy, and neither
// half is let go of, since the other may still pair with the message that
// was copied. For the same reason, when a tag's place is taken, a message
// whose round started first takes it from the held one whose round started
// last: a copy's round always starts after the round of what it copies has
// finished. (Round numbers aren't in that order.)
//
// To stop a notice from pairing, a flood would need more than pairPerRound
// messages in a round before a half it brought, or pairHeld between its
// halves: more than pairPerRound a round can bring between two sent apart,
// though fewer a round can do it the further apart they come (a second half
// retried after a failed round, after another pause, or one whose pickup
// the network failed and xxDK tries again minutes later); and in
// every round, since nobody can tell which round a notice is in, or its tag.
// (A client modified to send a copy into a round still taking messages after
// a later-scheduled one had finished could make it look earlier: stock xxDK
// doesn't send into a round past its start.)
// A look-back reads a day's rounds in order, as they came, so it costs a
// flood the same.
type pairing struct {
	mu      sync.Mutex
	firsts  map[[pairTagLen]byte][]*half // by the tag their second half would start with
	seconds map[[pairTagLen]byte][]*half // by the tag they start with
	rounds  map[id.Round]*heldRound      // what's held of each round
	held    int
	tries   int // pairs tried: one a notice, and what crafted messages cost
}

type heldRound struct {
	halves []*half
	last   time.Time // when its last message came
}

// startsBefore reports whether a's round started before b's, by the start
// time in the round's info from the network (only the owner's own gateway
// could change it on the way, and it could as well hold back messages), and
// by number when that's the same or not known.
// Round numbers alone aren't in that order: a round's number is given when
// it's made, and some take longer to get ready (withinApart, apart.go). A
// message, or a copy of one, can only go in a round that hasn't started, so a
// notice's second half, sent once its first's round has finished, and a copy,
// made from a message once its round has finished, always start later.
func startsBefore(a, b *half) bool {
	if !a.start.IsZero() && !b.start.IsZero() && !a.start.Equal(b.start) {
		return a.start.Before(b.start)
	}
	return a.round < b.round
}

// nearRounds reports whether two rounds are close enough for their messages
// to be a notice's two halves.
func nearRounds(a, b id.Round) bool {
	if a > b {
		a, b = b, a
	}
	return b-a <= apartRounds
}

// pair tries m with the messages that came before it, both ways round, and
// holds it for the ones after it if no notice opens. It gives the notice and
// the half it paired with.
func (s *InboxSession) pair(m *half) (opened, *half, bool) {
	m.findWant(s.key) // outside the lock: it's the costly part (if openReply hasn't done it already)
	p := &s.pairs
	p.mu.Lock()
	defer p.mu.Unlock()
	now := time.Now()
	p.sweep(now)
	if p.rounds == nil {
		p.rounds = map[id.Round]*heldRound{}
		p.firsts = map[[pairTagLen]byte][]*half{}
		p.seconds = map[[pairTagLen]byte][]*half{}
	}
	s.count(&s.others, 1) // until it pairs
	try := func(first, second *half) (opened, bool) {
		if !nearRounds(first.round, second.round) {
			return opened{}, false
		}
		p.tries++
		o, err := openNotice4(s.key, first, second.stream)
		if err != nil {
			return opened{}, false
		}
		sealed := first
		if startsBefore(second, first) {
			sealed = second
		}
		if o.round != uint32(sealed.round) {
			s.count(&s.copies, 1)
			jww.WARN.Printf("[Slynk] A quantum-safe message paired with a copy of one of its halves sent again")
			return opened{}, false
		}
		return o, true
	}
	if m.wants {
		for _, h := range p.seconds[m.want] {
			if o, ok := try(m, h); ok {
				p.release(h)
				s.count(&s.others, -2) // both were counted
				return o, h, true
			}
		}
	}
	for _, h := range p.firsts[m.tag()] {
		if o, ok := try(h, m); ok {
			p.release(h)
			s.count(&s.others, -2)
			return o, h, true
		}
	}
	b := p.rounds[m.round]
	if b == nil {
		b = &heldRound{}
	}
	b.last = now
	// Every round has room for pairPerRound of its own, made by letting go of
	// the rounds that heard from last longest ago: their halves have rarely
	// a partner still to come.
	for len(b.halves) < pairPerRound && p.held >= pairHeld && p.evictOldest(m.round) {
	}
	if len(b.halves) < pairPerRound && p.held < pairHeld {
		if m.wants {
			m.inFirsts = p.index(p.firsts, m.want, m, func(h *half) { h.inFirsts = false })
		}
		m.inSeconds = p.index(p.seconds, m.tag(), m, func(h *half) { h.inSeconds = false })
		if m.inFirsts || m.inSeconds {
			b.halves = append(b.halves, m)
			p.held++
		}
	}
	if len(b.halves) > 0 {
		p.rounds[m.round] = b
	}
	return opened{}, nil, false
}

// index holds m under t, if the tag has room, or else in place of the held
// message whose round started last if m's started before it; out marks one
// put out.
func (p *pairing) index(index map[[pairTagLen]byte][]*half, t [pairTagLen]byte, m *half, out func(*half)) bool {
	hs := index[t]
	if len(hs) < pairPerTag {
		index[t] = append(hs, m)
		return true
	}
	latest := 0
	for i, h := range hs {
		if startsBefore(hs[latest], h) {
			latest = i
		}
	}
	old := hs[latest]
	if !startsBefore(m, old) {
		return false
	}
	hs[latest] = m
	out(old)
	if !old.inFirsts && !old.inSeconds {
		p.drop(old)
	}
	return true
}

// unindex takes h out of index, under t.
func unindex(index map[[pairTagLen]byte][]*half, t [pairTagLen]byte, h *half) {
	if i := slices.Index(index[t], h); i >= 0 {
		if index[t] = slices.Delete(index[t], i, i+1); len(index[t]) == 0 {
			delete(index, t)
		}
	}
}

// release lets go of h, held, which has found its other half.
func (p *pairing) release(h *half) {
	if h.inFirsts {
		unindex(p.firsts, h.want, h)
		h.inFirsts = false
	}
	if h.inSeconds {
		unindex(p.seconds, h.tag(), h)
		h.inSeconds = false
	}
	p.drop(h)
}

// drop takes h, no longer under any tag, out of its round's.
func (p *pairing) drop(h *half) {
	b := p.rounds[h.round]
	if b == nil {
		return
	}
	if i := slices.Index(b.halves, h); i >= 0 {
		b.halves = slices.Delete(b.halves, i, i+1)
		p.held--
	}
	if len(b.halves) == 0 {
		delete(p.rounds, h.round)
	}
}

// evictRound lets go of everything held of round r.
func (p *pairing) evictRound(r id.Round) {
	b := p.rounds[r]
	if b == nil {
		return
	}
	for _, h := range slices.Clone(b.halves) {
		p.release(h)
	}
	delete(p.rounds, r)
}

// sweep lets go of rounds nothing has come for in pairKeep.
func (p *pairing) sweep(now time.Time) {
	for r, b := range p.rounds {
		if now.Sub(b.last) > pairKeep {
			p.evictRound(r)
		}
	}
}

// evictOldest lets go of the round holding messages that heard from last
// longest ago, other than keep, reporting whether there was one.
func (p *pairing) evictOldest(keep id.Round) bool {
	var oldest *heldRound
	var at id.Round
	for r, b := range p.rounds {
		if r != keep && len(b.halves) > 0 && (oldest == nil || b.last.Before(oldest.last)) {
			oldest, at = b, r
		}
	}
	if oldest == nil {
		return false
	}
	p.evictRound(at)
	return true
}
