package transfer

import (
	"bytes"
	"compress/flate"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/mlkem"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	mrand "math/rand/v2"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/primitives/id"
)

// msgLen is the contents size of a cMix message on mainnet's 4096-bit group,
// and streamLen what a notice fills of one, with the fingerprint and MAC.
const (
	msgLen    = 926
	streamLen = msgLen + 62
)

var testSent = time.Date(2026, 10, 14, 17, 0, 0, 0, time.UTC)

func testKey(t *testing.T, fill byte) *InboxKey {
	t.Helper()
	k, err := inboxKeyFromEntropy(bytes.Repeat([]byte{fill}, inboxEntropyLen))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func goldenKey(t *testing.T) *InboxKey {
	t.Helper()
	k, err := InboxKeyFromPhrase(strings.Repeat("abandon ", 11) + "about")
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// sealer makes a notice's sealer, failing the test if it's refused.
func sealer(t *testing.T, to *InboxAddress, kind byte, body []byte, from *From) noticeSealer {
	t.Helper()
	s, err := newNoticeSealer(to, kind, body, from, nil, msgLen)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// seal seals a notice for round: one stream, or two for a quantum-safe
// address.
func seal(t *testing.T, to *InboxAddress, kind byte, body []byte, from *From, round uint32) [][]byte {
	t.Helper()
	streams, err := sealer(t, to, kind, body, from)(round)
	if err != nil {
		t.Fatal(err)
	}
	return streams
}

// openNotice opens one message's stream as a compact notice, as Process
// does first.
func openNotice(key *InboxKey, stream []byte) (opened, error) {
	return openCompact(key, newHalf(stream))
}

// openSealed reverses sealPlaintext.
func openSealed(key *InboxKey, sealed []byte) ([]byte, error) {
	if len(sealed) < hpkeOverhead {
		return nil, errors.New("too short")
	}
	enc, err := revealKey(sealed[:keyRepLen])
	if err != nil {
		return nil, err
	}
	return openSealedWith(key, sealed, enc)
}

// open opens a notice's streams, whichever kind.
func open(key *InboxKey, streams [][]byte) (opened, error) {
	if len(streams) == 1 {
		return openNotice(key, streams[0])
	}
	return openNotice4(key, newHalf(streams[0]), streams[1])
}

func deflated(t *testing.T, text string) []byte {
	t.Helper()
	var b bytes.Buffer
	w, err := flate.NewWriter(&b, flate.BestCompression)
	if err != nil {
		t.Fatal(err)
	}
	w.Write([]byte(text))
	w.Close()
	return b.Bytes()
}

// The derivation from words to addresses and mailbox must never change:
// published addresses and posters depend on it.
func TestInboxGoldenVector(t *testing.T) {
	k := goldenKey(t)
	const (
		addr    = "03398330eaeb0a19e6abcfe411c31a0f2c3ef90a5b3cb7511a67177161bd919955"
		mailbox = "394504d5dd18d3d23a2658eba1065219d4e1dce14ac4d42d7534c84a06e57b6703"
		// The quantum-safe address: its SHA-256 and first 40 bytes. All
		// but its signature is as the lab prototype made it (lab/pq-inbox,
		// 2026-10-18), whose SHA-256 is addr4LabHash.
		addr4Hash    = "2266f69c646e625e1350fcd187ba48dd36130746142523a9e98891192b3b99b6"
		addr4LabHash = "5badbc7982c33799ec14388481abac53c93e9fa334f151b3bfefab65d538d1d7"
		addr4Start   = "04398330eaeb0a19e6abcfe411c31a0f2c3ef90a5b3cb7511a67177161bd919955280b491f50121e"
	)
	if got := hex.EncodeToString(k.Address.Bytes()); got != addr {
		t.Errorf("address %s, want %s", got, addr)
	}
	if got := hex.EncodeToString(k.Address.mailbox[:]); got != mailbox {
		t.Errorf("mailbox %s, want %s", got, mailbox)
	}
	if k.Address.mailbox.GetType() != id.User {
		t.Errorf("mailbox type %v, want User", k.Address.mailbox.GetType())
	}
	a4 := k.Address4.Bytes()
	if h := sha256.Sum256(a4); hex.EncodeToString(h[:]) != addr4Hash || hex.EncodeToString(a4[:40]) != addr4Start {
		t.Errorf("quantum-safe address %x…, hash %x", a4[:40], h)
	}
	unsigned := a4[:InboxAddressLen+mlkem.EncapsulationKeySize768]
	if h := sha256.Sum256(unsigned); hex.EncodeToString(h[:]) != addr4LabHash {
		t.Errorf("the quantum-safe address's keys differ from the lab prototype's: hash %x", h)
	}
	if len(a4) != InboxAddress4Len || InboxAddress4Len != 1281 || !k.Address4.QuantumSafe() || k.Address.QuantumSafe() {
		t.Fatalf("quantum-safe address is %d bytes", len(a4))
	}
	// Its last 64 bytes are the inbox's signature on its ML-KEM key, which
	// only the words can make.
	if !ed25519.Verify(k.Address.pub, append([]byte("slynk/inbox/v4/address"), unsigned[InboxAddressLen:]...), a4[len(unsigned):]) {
		t.Fatal("the quantum-safe address isn't signed by its inbox")
	}
	// Both addresses are the same inbox and mailbox.
	if !bytes.Equal(k.Address4.Compact().Bytes(), k.Address.Bytes()) || !k.Address4.mailbox.Cmp(k.Address.mailbox) {
		t.Fatal("the quantum-safe address isn't the same inbox")
	}
	parsed, err := ParseInboxAddress(a4)
	if err != nil || !bytes.Equal(parsed.Bytes(), a4) || !parsed.QuantumSafe() || !parsed.mailbox.Cmp(k.Address.mailbox) {
		t.Fatalf("the quantum-safe address doesn't round-trip: %v", err)
	}
	if k.Address.Compact() != k.Address {
		t.Fatal("a compact address's compact form isn't itself")
	}
}

// What an owner's page keeps on their device is encrypted and named with a
// secret worked out from the words. It must never change,
// or kept inboxes would stop opening, and it must differ for every inbox and
// from everything else the words give.
func TestInboxStoreSecret(t *testing.T) {
	k := goldenKey(t)
	const golden = "7af7023f3f5dbdd2e40bcee35cc27b771415503ab036c54f5af2ec4f3618065d8110de99d8786acd8c2329f8658e53a3"
	s := k.StoreSecret()
	if got := hex.EncodeToString(s); got != golden {
		t.Errorf("store secret %s, want %s", got, golden)
	}
	if len(s) != InboxStoreLen {
		t.Errorf("store secret is %d bytes, want %d", len(s), InboxStoreLen)
	}
	s[0] ^= 1 // the caller's copy: the key's own must stay as it was
	if hex.EncodeToString(k.StoreSecret()) != golden {
		t.Error("StoreSecret handed out the key's own bytes")
	}
	if bytes.Equal(testKey(t, 1).StoreSecret(), testKey(t, 2).StoreSecret()) {
		t.Error("two inboxes share a store secret")
	}
	if bytes.Contains(s, k.Address.pub[:16]) || bytes.Contains(s, k.Address.mailbox[:16]) {
		t.Error("the store secret overlaps the public key or mailbox")
	}
}

// Notices sealed by an earlier build must still open the same way: this pins
// the HPKE suites, the info strings, the keys' encodings, the header layout
// and how a stream fills a message. (Sealing is randomised, so only the
// opening side can be pinned here; TestHideKeyKnownAnswer pins the X25519
// key's encoding on the sealing side, and kemeleon_test.go the ML-KEM
// ciphertext's.)
func TestNoticeKnownAnswer(t *testing.T) {
	for name, c := range map[string]struct {
		hex  string
		want string
		qs   bool
	}{
		"compact":      {knownTextNotice, "Known-answer test: a text message.", false},
		"quantum-safe": {knownTextNotice4, "Known-answer test: a quantum-safe message.", true},
		"compressed":   {knownDeflatedNotice, strings.Repeat("Known-answer test: a compressed message. ", 20), false},
	} {
		b, err := hex.DecodeString(c.hex)
		if err != nil {
			t.Fatal(err)
		}
		streams := [][]byte{b}
		if c.qs {
			streams = [][]byte{b[:streamLen], b[streamLen:]}
		}
		o, err := open(goldenKey(t), streams)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if o.kind != NoticeText || string(o.body) != c.want || o.round != knownRound || o.quantum != c.qs || o.from != nil || o.name != "" {
			t.Fatalf("%s: got %+v", name, o)
		}
		// And found as an inbox finds it, which for a quantum-safe notice
		// pins the pairing tag: the owner must work out the one it starts
		// with, in either order.
		orders := [][]int{{0}}
		if c.qs {
			orders = [][]int{{0, 1}, {1, 0}}
		}
		for _, order := range orders {
			var got []Notice
			s := testSession(goldenKey(t), func(n Notice) { got = append(got, n) })
			for _, i := range order {
				s.Process(cmixMessage(t, streams[i]), nil, nil, receptionID.EphemeralIdentity{}, roundAt(knownRound, testSent))
			}
			if len(got) != 1 || string(got[0].Body) != c.want {
				t.Fatalf("%s: an inbox found %d notices", name, len(got))
			}
		}
	}
}

func TestInboxPhrase(t *testing.T) {
	for i := 0; i < 20; i++ {
		phrase, err := NewInboxPhrase()
		if err != nil {
			t.Fatal(err)
		}
		if n := len(strings.Fields(phrase)); n != 12 {
			t.Fatalf("%d words", n)
		}
		k, err := InboxKeyFromPhrase(phrase)
		if err != nil {
			t.Fatal(err)
		}
		// Case and spacing are forgiven.
		messy := "  " + strings.ToUpper(strings.ReplaceAll(phrase, " ", " \t\n ")) + "\n"
		k2, err := InboxKeyFromPhrase(messy)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(k.Address.Bytes(), k2.Address.Bytes()) {
			t.Fatal("messy words gave a different inbox")
		}
		parsed, err := ParseInboxAddress(k.Address.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		if !parsed.mailbox.Cmp(k.Address.mailbox) || !bytes.Equal(parsed.xpub.Bytes(), k.xpriv.PublicKey().Bytes()) {
			t.Fatal("a parsed address doesn't match its key")
		}
		if !bytes.Equal(k.Address4.Bytes(), k2.Address4.Bytes()) {
			t.Fatal("messy words gave a different quantum-safe address")
		}
	}

	for _, bad := range []string{
		"",
		strings.Repeat("abandon ", 12),                 // checksum is wrong
		strings.Repeat("abandon ", 10) + "about",       // 11 words
		strings.Repeat("abandon ", 11) + "slynk",       // not a word
		strings.Repeat("abandon ", 23) + "art",         // 24 words: valid, but not an inbox
		strings.Repeat("abandon ", 11) + "about extra", // 13 words
	} {
		if _, err := InboxKeyFromPhrase(bad); err != ErrInboxPhrase {
			t.Errorf("%q: got %v, want ErrInboxPhrase", bad, err)
		}
	}
}

func TestParseInboxAddressRejects(t *testing.T) {
	good := testKey(t, 7).Address.Bytes()
	mustHex := func(s string) []byte {
		b, err := hex.DecodeString(s)
		if err != nil {
			t.Fatal(err)
		}
		return append([]byte{inboxAddressVersion}, b...)
	}
	for name, b := range map[string][]byte{
		"empty":    nil,
		"short":    good[:InboxAddressLen-1],
		"long":     append(bytes.Clone(good), 0),
		"link v1":  append([]byte{linkVersion1}, good[1:]...),
		"link v2":  append([]byte{2}, good[1:]...),
		"identity": mustHex("0100000000000000000000000000000000000000000000000000000000000000"),
		"order 2":  mustHex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
		"order 4":  mustHex("0000000000000000000000000000000000000000000000000000000000000000"),
		"order 8":  mustHex("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"),
		// y = 2 has no point on the curve.
		"off curve": mustHex("0200000000000000000000000000000000000000000000000000000000000000"),
		// y = p+3: a valid point of large order, encoded non-canonically.
		"noncanonical": mustHex("f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
	} {
		if _, err := ParseInboxAddress(b); err != ErrInboxAddress {
			t.Errorf("%s: got %v, want ErrInboxAddress", name, err)
		}
	}
	// The same point encoded canonically (y = 3) is accepted, so the case
	// above fails only for being non-canonical.
	if _, err := ParseInboxAddress(mustHex("0300000000000000000000000000000000000000000000000000000000000000")); err != nil {
		t.Errorf("canonical y = 3: %v", err)
	}

	// A quantum-safe address: the same checks on its ed25519 key, the
	// inbox's signature on its ML-KEM key, and the ML-KEM key checked as FIPS
	// 203 asks.
	good4 := testKey(t, 7).Address4.Bytes()
	ekAt, sigAt := InboxAddressLen, InboxAddressLen+mlkem.EncapsulationKeySize768
	with := func(f func(b []byte) []byte) []byte { return f(bytes.Clone(good4)) }
	// signed puts a signature by priv on the address's ML-KEM key, under
	// the label unless bare.
	signed := func(priv ed25519.PrivateKey, bare bool) func(b []byte) []byte {
		return func(b []byte) []byte {
			msg := append([]byte(inboxAddress4Info), b[ekAt:sigAt]...)
			if bare {
				msg = b[ekAt:sigAt]
			}
			copy(b[sigAt:], ed25519.Sign(priv, msg))
			return b
		}
	}
	mine, theirs := signingKey(t, 7), signingKey(t, 8)
	theirs4 := testKey(t, 8).Address4.Bytes()
	for name, b := range map[string][]byte{
		"short":            good4[:InboxAddress4Len-1],
		"long":             append(bytes.Clone(good4), 0),
		"unsigned":         good4[:sigAt], // as 8j first had it
		"compact version":  with(func(b []byte) []byte { b[0] = inboxAddressVersion; return b }),
		"version 5":        with(func(b []byte) []byte { b[0] = 5; return b }),
		"compact's length": append([]byte{inboxAddress4Version}, good4[1:InboxAddressLen]...),
		"small order":      with(func(b []byte) []byte { copy(b[1:InboxAddressLen], make([]byte, 32)); return b }),
		"noncanonical": with(func(b []byte) []byte {
			copy(b[1:InboxAddressLen], mustHex("f0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")[1:])
			return b
		}),
		// The review's forgery: this inbox's ed25519 key with someone
		// else's ML-KEM key, and their signature on it, or none.
		"their ML-KEM key, their signature": with(func(b []byte) []byte { copy(b[ekAt:], theirs4[ekAt:]); return b }),
		"their ML-KEM key, signed by them":  with(func(b []byte) []byte { copy(b[ekAt:], theirs4[ekAt:sigAt]); return signed(theirs, false)(b) }),
		"their ML-KEM key, no signature":    with(func(b []byte) []byte { copy(b[ekAt:], theirs4[ekAt:sigAt]); clear(b[sigAt:]); return b }),
		"their ed25519 key":                 with(func(b []byte) []byte { copy(b[1:ekAt], theirs4[1:ekAt]); return b }),
		"signature changed":                 with(func(b []byte) []byte { b[sigAt+10] ^= 1; return b }),
		"signature's S + order": with(func(b []byte) []byte {
			// The same signature with S made non-canonical (S + the group
			// order): Ed25519 must refuse it, or one address would have two
			// forms.
			s := new(big.Int).SetBytes(reversed(b[sigAt+32:])) // little-endian
			s.Add(s, ed25519Order)
			copy(b[sigAt+32:], reversed(s.FillBytes(make([]byte, 32))))
			return b
		}),
		"signed without the label": with(signed(mine, true)),
		// The ML-KEM key checked even when signed by the right inbox.
		"ML-KEM number q, signed": with(func(b []byte) []byte {
			b[ekAt], b[ekAt+1] = 0x01, 0x0d // 3329
			return signed(mine, false)(b)
		}),
		"ML-KEM all ones, signed": with(func(b []byte) []byte {
			copy(b[ekAt:], bytes.Repeat([]byte{0xff}, 384))
			return signed(mine, false)(b)
		}),
	} {
		if _, err := ParseInboxAddress(b); err != ErrInboxAddress {
			t.Errorf("quantum-safe, %s: got %v, want ErrInboxAddress", name, err)
		}
	}
	// Re-signed by the right inbox, an untouched key is accepted, so the
	// cases above fail for what they change.
	if _, err := ParseInboxAddress(with(signed(mine, false))); err != nil {
		t.Errorf("re-signed by its own inbox: %v", err)
	}
}

// signingKey is testKey(fill)'s ed25519 key, which signs its quantum-safe
// address.
func signingKey(t *testing.T, fill byte) ed25519.PrivateKey {
	t.Helper()
	seed, err := hkdf.Key(sha256.New, bytes.Repeat([]byte{fill}, inboxEntropyLen), nil, inboxKeyInfo, ed25519.SeedSize)
	if err != nil {
		t.Fatal(err)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func reversed(b []byte) []byte {
	c := slices.Clone(b)
	slices.Reverse(c)
	return c
}

// ed25519Order is the order of the ed25519 group, ℓ.
var ed25519Order, _ = new(big.Int).SetString("7237005577332262213973186563042994240857116359379907606001950938285454250989", 10)

func TestNoticeRoundTrip(t *testing.T) {
	k := testKey(t, 1)
	if got := MaxNoticeBody(msgLen); got != 924 {
		t.Fatalf("MaxNoticeBody = %d, want 924", got)
	}
	if got := MaxNoticeBody4(msgLen); got != 652 {
		t.Fatalf("MaxNoticeBody4 = %d, want 652", got)
	}
	link := append([]byte{linkVersion1}, bytes.Repeat([]byte{9}, linkLen-1)...)
	for _, to := range []*InboxAddress{k.Address, k.Address4} {
		max := to.MaxBody(msgLen)
		pieces := to.pieces()
		for _, c := range []struct {
			kind byte
			body []byte
			want []byte // the body as opened, if not body
		}{
			{NoticeText, []byte("hello"), nil},
			{NoticeText, nil, nil},
			{NoticeText, bytes.Repeat([]byte{0}, max), nil}, // trailing zeros are body, not padding
			{NoticeText, bytes.Repeat([]byte{'x'}, max), nil},
			{NoticeText | NoticeDeflate, deflated(t, "hello, compressed"), []byte("hello, compressed")},
			{NoticeText | NoticeDeflate, deflated(t, strings.Repeat("y", MaxNoticeText)), bytes.Repeat([]byte{'y'}, MaxNoticeText)},
			{NoticeLink, link, nil},
			{NoticeLink, append(bytes.Clone(link), "with a note"...), nil},
		} {
			want := c.body
			if c.want != nil {
				want = c.want
			}
			s := sealer(t, to, c.kind, c.body, nil)
			first, err := s(456090129)
			if err != nil {
				t.Fatal(err)
			}
			again, err := s(456090131) // a retry in a later round
			if err != nil {
				t.Fatal(err)
			}
			if len(first) != pieces || len(again) != pieces {
				t.Fatalf("sealed %d and %d messages, want %d", len(first), len(again), pieces)
			}
			for _, m := range append(first, again...) {
				if len(m) != streamLen {
					t.Fatalf("a message's stream is %d bytes, want %d", len(m), streamLen)
				}
			}
			o, err := open(k, first)
			if err != nil {
				t.Fatal(err)
			}
			o2, err := open(k, again)
			if err != nil {
				t.Fatal(err)
			}
			if o.kind != c.kind&^NoticeDeflate || !bytes.Equal(o.body, want) || o.from != nil || o.quantum != to.QuantumSafe() {
				t.Fatalf("got %+v", o)
			}
			if o.round != 456090129 || o2.round != 456090131 {
				t.Fatalf("rounds %d and %d, want each try's own", o.round, o2.round)
			}
			// Every try at one notice carries the same id; another notice's
			// differs.
			if o.id != o2.id {
				t.Fatal("two tries at one notice have different ids")
			}
			if other, _ := open(k, seal(t, to, c.kind, c.body, nil, 456090129)); other.id == o.id {
				t.Fatal("two notices share an id")
			}
		}

		// Nothing the owner would discard is ever sealed.
		for name, c := range map[string]struct {
			kind byte
			body []byte
			want error
		}{
			"too long":          {NoticeText, make([]byte, max+1), ErrNoticeSize},
			"unpacks too long":  {NoticeText | NoticeDeflate, deflated(t, strings.Repeat("y", MaxNoticeText+1)), ErrNoticeSize},
			"not compressed":    {NoticeText | NoticeDeflate, []byte("plain text"), nil},
			"compressed link":   {NoticeLink | NoticeDeflate, deflated(t, string(link)), nil},
			"from flag":         {NoticeText | noticeFrom, []byte("hi"), nil},
			"kind 0":            {0, []byte("hi"), nil},
			"kind 3":            {3, []byte("hi"), nil},
			"short link":        {NoticeLink, link[:linkLen-1], nil},
			"v2 link":           {NoticeLink, append([]byte{2}, link[1:]...), nil},
			"compressed, empty": {NoticeText | NoticeDeflate, nil, nil},
		} {
			_, err := newNoticeSealer(to, c.kind, c.body, nil, nil, msgLen)
			if err == nil || (c.want != nil && err != c.want) {
				t.Errorf("%s: got %v", name, err)
			}
		}
	}
}

// A small compressed text that would unpack to far more than MaxNoticeText
// (a "zip bomb": about 1 MB from 1 KB) is refused without being unpacked
// whole.
func TestInflateBounded(t *testing.T) {
	bomb := deflated(t, strings.Repeat("y", 1<<20))
	if len(bomb) > 2048 {
		t.Fatalf("the bomb is %d bytes", len(bomb))
	}
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	_, err := inflateText(bomb)
	runtime.ReadMemStats(&after)
	if err != ErrNoticeSize {
		t.Fatalf("got %v, want ErrNoticeSize", err)
	}
	if grew := after.TotalAlloc - before.TotalAlloc; grew > 256<<10 {
		t.Fatalf("unpacking it allocated %d bytes", grew)
	}
	// Not DEFLATE at all, cut short, or with anything after its end:
	// refused, so each text has one encoding.
	hello := deflated(t, "hello")
	for _, bad := range [][]byte{[]byte("plain text"), bomb[:len(bomb)/2], {},
		append(bytes.Clone(hello), "JUNK"...), append(bytes.Clone(hello), 0), append(bytes.Clone(hello), hello...)} {
		if _, err := inflateText(bad); err == nil {
			t.Errorf("%x unpacked", bad[:min(8, len(bad))])
		}
	}
	// What the page sends: fflate's deflateSync at level 9 (web/src/inbox/
	// pack.ts), made on 2026-10-18 from these texts, unpacks whole.
	for want, packed := range map[string]string{
		"Known-answer test: fflate, as the page packs it.": "f3cecb2fcfd34dcc2b2e4f2d5228492d2eb152484bcb492c49d551482c5628c9485528484c0711c9d9c50a99257a00",
		strings.Repeat("a", 2000):                          "4b1c05a360148c8251300a46c1900700",
		strings.Repeat("\U0001F600", 40) + " emoji":        "fb307f46c360c60aa9b9f9599900",
		"x": "ab0000",
	} {
		b, err := hex.DecodeString(packed)
		if err != nil {
			t.Fatal(err)
		}
		if text, err := inflateText(b); err != nil || string(text) != want {
			t.Errorf("fflate's %s… unpacked to %.20q, %v", packed[:8], text, err)
		}
	}
}

// Messages carry a stream in their fingerprint, MAC and contents, keeping
// the first byte of each of the first two random with its top bit clear, as
// the network needs.
func TestMessageStream(t *testing.T) {
	stream := counterBytes("stream", streamLen)
	tops := map[byte]bool{}
	for range 64 {
		fp, mac, contents, err := splitStream(stream, msgLen)
		if err != nil {
			t.Fatal(err)
		}
		if fp[0]&0x80 != 0 || mac[0]&0x80 != 0 || len(contents) != msgLen {
			t.Fatalf("fp %x, mac %x, %d bytes of contents", fp[0], mac[0], len(contents))
		}
		tops[fp[0]] = true
		m := format.NewMessage(512)
		m.SetKeyFP(fp)
		m.SetMac(mac)
		m.SetContents(contents)
		if !bytes.Equal(messageStream(m), stream) {
			t.Fatal("a message's stream didn't come back the same")
		}
	}
	if len(tops) < 16 {
		t.Fatalf("the fingerprint's first byte took only %d values", len(tops))
	}
	if _, _, _, err := splitStream(stream[1:], msgLen); err == nil {
		t.Fatal("split a short stream")
	}
}

func TestNoticeRejects(t *testing.T) {
	k, other := testKey(t, 1), testKey(t, 2)
	for _, to := range []*InboxAddress{k.Address, k.Address4} {
		streams := seal(t, to, NoticeText, []byte("hello"), nil, 7)
		if _, err := open(other, streams); err == nil {
			t.Error("another inbox opened the notice")
		}
		// One bit changed anywhere: refused.
		for m := range streams {
			for _, i := range []int{0, 31, 32, 61, 62, streamLen / 2, streamLen - 1} {
				tampered := [][]byte{bytes.Clone(streams[0])}
				if len(streams) == 2 {
					tampered = append(tampered, bytes.Clone(streams[1]))
				}
				tampered[m][i] ^= 1
				if _, err := open(k, tampered); err == nil {
					t.Errorf("a notice with byte %d of message %d changed opened", i, m)
				}
			}
		}
		if len(streams) == 2 {
			if _, err := open(k, [][]byte{streams[1], streams[0]}); err == nil {
				t.Error("a quantum-safe notice opened with its halves swapped")
			}
			if _, err := openNotice(k, streams[0]); err == nil {
				t.Error("half a quantum-safe notice opened as a compact one")
			}
			// Halves of two notices: refused.
			other := seal(t, to, NoticeText, []byte("hello"), nil, 7)
			if _, err := open(k, [][]byte{streams[0], other[1]}); err == nil {
				t.Error("halves of two notices opened together")
			}
		} else if _, err := open(k, [][]byte{streams[0], streams[0]}); err == nil {
			t.Error("a compact notice opened as half of a quantum-safe one")
		}
		// A notice for the other address of the same inbox opens only as
		// what it is.
		if _, err := openNotice(k, seal(t, to.Compact(), NoticeText, []byte("hi"), nil, 7)[0]); err != nil {
			t.Error("the compact address's notice didn't open")
		}
	}

	// The one-time key has other encodings: other top bits, the other
	// representative, other torsion points. All give the same key, but a
	// notice re-encoded with one mustn't open, or it would be a second
	// message.
	for _, to := range []*InboxAddress{k.Address, k.Address4} {
		streams := seal(t, to, NoticeText, []byte("hello"), nil, 7)
		enc, err := revealKey(streams[0][:keyRepLen])
		if err != nil {
			t.Fatal(err)
		}
		variants := 0
		for pick := range 256 {
			rep, ok, err := hideKeyWith(enc, byte(pick))
			if err != nil {
				t.Fatal(err)
			}
			if !ok || bytes.Equal(rep, streams[0][:keyRepLen]) {
				continue
			}
			if again, err := revealKey(rep); err != nil || !bytes.Equal(again, enc) {
				t.Fatal("a re-encoded key didn't reveal the same key")
			}
			variants++
			re := [][]byte{append(rep, streams[0][keyRepLen:]...)}
			re = append(re, streams[1:]...)
			if _, err = open(k, re); err == nil {
				t.Fatalf("a notice re-encoded with pick %#x opened", pick)
			}
		}
		if variants == 0 {
			t.Fatal("no re-encodings tried")
		}
	}
	// So has the ML-KEM ciphertext: other widenings and top bits. A
	// re-encoded copy mustn't open either.
	streams := seal(t, k.Address4, NoticeText, []byte("hello"), nil, 7)
	tag := streams[1][:pairTagLen]
	whole := append(bytes.Clone(streams[0]), streams[1][pairTagLen:]...)
	ct, err := kemeleonDecode768(whole[keyRepLen:keys4Len])
	if err != nil {
		t.Fatal(err)
	}
	reencoded := 0
	for reencoded < 5 {
		kem, err := kemeleonEncode768(ct)
		if err != nil || bytes.Equal(kem, whole[keyRepLen:keys4Len]) {
			continue
		}
		reencoded++
		re := append(append(bytes.Clone(whole[:keyRepLen]), kem...), whole[keys4Len:]...)
		if again, _ := kemeleonDecode768(kem); !bytes.Equal(again, ct) {
			t.Fatal("a re-encoding decoded differently")
		}
		if _, err := open(k, [][]byte{re[:streamLen], append(bytes.Clone(tag), re[streamLen:]...)}); err == nil {
			t.Fatal("a notice with its ML-KEM ciphertext re-encoded opened")
		}
	}

	// Well-sealed plaintexts at and around the format's limits.
	for _, to := range []*InboxAddress{k.Address, k.Address4} {
		ptLen := streamLen - hpkeOverhead
		if to.QuantumSafe() {
			ptLen = plaintext4Len(streamLen)
		}
		sealPT := func(pt []byte) [][]byte {
			if to.QuantumSafe() {
				s, err := sealPlaintext4(to, pt, nil, streamLen)
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			s, err := sealPlaintext(to, pt, nil)
			if err != nil {
				t.Fatal(err)
			}
			return [][]byte{s}
		}
		plain := func(version, kind byte, n int, body []byte) []byte {
			pt := make([]byte, ptLen)
			pt[0], pt[1] = version, kind
			binary.BigEndian.PutUint16(pt[2:4], uint16(n))
			copy(pt[noticeHeaderLen:], body)
			return pt
		}
		full := bytes.Repeat([]byte{'x'}, ptLen-noticeHeaderLen)
		link := append([]byte{linkVersion1}, bytes.Repeat([]byte{9}, linkLen-1)...)
		padded := plain(noticeVersion, NoticeText, 2, []byte("hi"))
		padded[len(padded)-1] = 1
		bomb := deflated(t, strings.Repeat("y", MaxNoticeText+1))
		hello := deflated(t, "hello")

		for name, c := range map[string]struct {
			pt []byte
			ok bool
		}{
			"longest body":           {plain(noticeVersion, NoticeText, len(full), full), true},
			"length one over":        {plain(noticeVersion, NoticeText, len(full)+1, full), false},
			"length far over":        {plain(noticeVersion, NoticeText, 0xffff, full), false},
			"shortest link":          {plain(noticeVersion, NoticeLink, linkLen, link), true},
			"link one short":         {plain(noticeVersion, NoticeLink, linkLen-1, link), false},
			"not a link":             {plain(noticeVersion, NoticeLink, linkLen, make([]byte, linkLen)), false},
			"compressed":             {plain(noticeVersion, NoticeText|NoticeDeflate, len(hello), hello), true},
			"compressed, cut short":  {plain(noticeVersion, NoticeText|NoticeDeflate, len(hello)-1, hello), false},
			"compressed, too much":   {plain(noticeVersion, NoticeText|NoticeDeflate, len(bomb), bomb), false},
			"compressed link":        {plain(noticeVersion, NoticeLink|NoticeDeflate, linkLen, link), false},
			"the old version":        {plain(1, NoticeText, 2, []byte("hi")), false},
			"version 3":              {plain(3, NoticeText, 2, []byte("hi")), false},
			"kind":                   {plain(noticeVersion, 3, 2, []byte("hi")), false},
			"padding":                {padded, false},
			"shorter than header":    {[]byte{noticeVersion, NoticeText, 0, 0, 0, 0, 0, 0}, false},
			"empty":                  {nil, false},
			"just short of a header": {plain(noticeVersion, NoticeText, 0, nil)[:noticeHeaderLen-1], false},
		} {
			if !to.QuantumSafe() || len(c.pt) == ptLen {
				o, err := open(k, sealPT(c.pt))
				if c.ok && (err != nil || len(o.body) == 0) {
					t.Errorf("%s: should open, got %v", name, err)
				}
				if !c.ok && err == nil {
					t.Errorf("%s: a malformed notice opened", name)
				}
			}
		}
	}
}

// cmixMessage is how a stream arrives: in a message's fingerprint, MAC and
// contents.
func cmixMessage(t *testing.T, stream []byte) format.Message {
	t.Helper()
	m := format.NewMessage(512)
	if m.ContentsSize() != msgLen {
		t.Fatalf("contents size %d", m.ContentsSize())
	}
	fp, mac, contents, err := splitStream(stream, msgLen)
	if err != nil {
		t.Fatal(err)
	}
	m.SetKeyFP(fp)
	m.SetMac(mac)
	m.SetContents(contents)
	return m
}

func roundAt(rid id.Round, at time.Time) rounds.Round {
	return rounds.Round{ID: rid, Timestamps: map[states.Round]time.Time{states.QUEUED: at}}
}

func testSession(key *InboxKey, found func(Notice)) *InboxSession {
	return newInboxSession(key, found)
}

// The inbox session passes each notice on once, with its round's time, drops
// copies sent again in other rounds, and counts other people's messages that
// share its labels.
func TestInboxSessionProcess(t *testing.T) {
	k := testKey(t, 1)
	var got []Notice
	s := testSession(k, func(n Notice) { got = append(got, n) })
	none := receptionID.EphemeralIdentity{}

	helloSeal := sealer(t, k.Address, NoticeText, []byte("hello"), nil)
	hello, err := helloSeal(42)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := helloSeal(43) // xxDK tried round 43 too, and both arrived
	if err != nil {
		t.Fatal(err)
	}
	theirs := seal(t, testKey(t, 2).Address, NoticeText, []byte("not yours"), nil, 46)
	s.Process(cmixMessage(t, hello[0]), nil, nil, none, roundAt(42, testSent.Add(20*time.Second)))
	s.Process(cmixMessage(t, hello[0]), nil, nil, none, roundAt(42, testSent.Add(20*time.Second))) // found again
	s.Process(cmixMessage(t, retry[0]), nil, nil, none, roundAt(43, testSent.Add(21*time.Second)))
	// A copy sent again later by someone else, in another round: dropped.
	s.Process(cmixMessage(t, hello[0]), nil, nil, none, roundAt(44, testSent.Add(time.Hour)))
	s.Process(cmixMessage(t, bytes.Repeat([]byte{5}, streamLen)), nil, nil, none, roundAt(45, testSent))
	s.Process(cmixMessage(t, theirs[0]), nil, nil, none, roundAt(46, testSent))
	compressed := seal(t, k.Address, NoticeText|NoticeDeflate, deflated(t, "packed"), nil, 47)
	s.Process(cmixMessage(t, compressed[0]), nil, nil, none, roundAt(47, testSent))

	if len(got) != 2 {
		t.Fatalf("got %d notices, want 2: %+v", len(got), got)
	}
	if n := got[0]; string(n.Body) != "hello" || n.Round != 42 || !n.RoundTime.Equal(testSent.Add(20*time.Second)) || n.QuantumSafe {
		t.Errorf("first notice: %+v", n)
	}
	if n := got[1]; string(n.Body) != "packed" || n.Kind != NoticeText {
		t.Errorf("a compressed notice came as %+v", n)
	}
	// The ID is the same whenever the message is found, and differs between
	// messages.
	o, _ := openNotice(k, hello[0])
	if want := sha256.Sum256(append([]byte(inboxIDInfo), o.id[:]...)); !bytes.Equal(got[0].ID[:], want[:16]) {
		t.Errorf("first notice's ID %x, want %x", got[0].ID, want[:16])
	}
	if got[0].ID == got[1].ID {
		t.Error("two notices share an ID")
	}
	if s.Others() != 2 || s.Copies() != 1 {
		t.Fatalf("others = %d, copies = %d, want 2 and 1", s.Others(), s.Copies())
	}
}

// Quantum-safe notices come as two messages, in one round, or, sent apart,
// in two, either half first, among anything else the rounds
// brought: a pair is a notice when it was sealed for the earlier of its
// rounds, the later no more than apartRounds after it, and it's shown as
// sent then.
func TestInboxSessionPairs(t *testing.T) {
	k := testKey(t, 1)
	var got []Notice
	s := testSession(k, func(n Notice) { got = append(got, n) })
	none := receptionID.EphemeralIdentity{}
	at := func(round id.Round) time.Time { return testSent.Add(time.Duration(round) * time.Second) }
	send := func(round id.Round, streams ...[]byte) {
		for _, m := range streams {
			s.Process(cmixMessage(t, m), nil, nil, none, roundAt(round, at(round)))
		}
	}
	junks := 0
	junk := func() []byte { junks++; return counterBytes(fmt.Sprint("junk", junks), streamLen) }
	want := func(i int, body string, round id.Round) {
		t.Helper()
		if len(got) <= i {
			t.Fatalf("%d notices, want %q", len(got), body)
		}
		if n := got[i]; string(n.Body) != body || !n.QuantumSafe || n.Round != uint64(round) || !n.RoundTime.Equal(at(round)) {
			t.Fatalf("notice %d: %q in round %d at %s, want %q in round %d", i, n.Body, n.Round, n.RoundTime, body, round)
		}
	}

	a := seal(t, k.Address4, NoticeText, []byte("first"), nil, 10)
	send(10, junk(), a[1], junk(), a[0])
	want(0, "first", 10)
	// Two notices, a compact one and junk in one round, shuffled.
	b := seal(t, k.Address4, NoticeText, []byte("second"), nil, 11)
	c := seal(t, k.Address4, NoticeText, []byte("third"), nil, 11)
	d := seal(t, k.Address, NoticeText, []byte("compact"), nil, 11)
	send(11, c[1], b[0], junk(), d[0], b[1], c[0])
	if len(got) != 4 {
		t.Fatalf("got %d notices", len(got))
	}
	// Sent apart: sealed for the first's round, either half first, with
	// junk between; and read back to front, as a look-back may.
	e := seal(t, k.Address4, NoticeText, []byte("apart"), nil, 20)
	send(20, e[0])
	send(21, junk())
	send(25, e[1])
	want(4, "apart", 20)
	f := seal(t, k.Address4, NoticeText, []byte("apart, tagged half first"), nil, 30)
	send(30, f[1])
	send(34, junk(), f[0])
	want(5, "apart, tagged half first", 30)
	g := seal(t, k.Address4, NoticeText, []byte("later round read first"), nil, 40)
	send(47, g[0])
	send(40, g[1])
	want(6, "later round read first", 40)
	// As far apart as the second may go, and no further.
	h := seal(t, k.Address4, NoticeText, []byte("at the limit"), nil, 1000)
	send(1000, h[1])
	send(1000+apartRounds, h[0])
	want(7, "at the limit", 1000)
	far := seal(t, k.Address4, NoticeText, []byte("too far apart"), nil, 3000)
	send(3000, far[0])
	send(3000+apartRounds+1, far[1])
	// Sealed for the later of its rounds: a copy (no first half goes after
	// the second).
	late := seal(t, k.Address4, NoticeText, []byte("sealed for the later"), nil, 51)
	send(50, late[0])
	send(51, late[1])
	// A notice sealed for round 14 arriving whole in round 15: a copy.
	whole := seal(t, k.Address4, NoticeText, []byte("copied"), nil, 14)
	send(15, whole[0], whole[1])
	// Another inbox's.
	send(16, seal(t, testKey(t, 2).Address4, NoticeText, []byte("not yours"), nil, 16)...)
	if len(got) != 8 {
		t.Fatalf("got %d notices: %+v", len(got), got[8:])
	}
	if s.Copies() != 2 {
		t.Errorf("copies = %d, want 2", s.Copies())
	}
	// Others: the junk, and the halves that never paired: the two too far
	// apart, the two copies' and the other inbox's.
	if want := junks + 2 + 2 + 2 + 2; s.Others() != want {
		t.Errorf("others = %d, want %d", s.Others(), want)
	}
	// Found again by a look-back: shown once.
	send(10, a[0], a[1])
	send(25, e[1])
	send(20, e[0])
	if len(got) != 8 {
		t.Fatal("a notice found again was shown twice")
	}
	checkHeld(t, &s.pairs)
}

// Anyone with the inbox's address can fetch its messages and send them
// again, later. A notice sent apart, with copies of both its halves sent a
// few rounds after, is found exactly once, as sent in its first round,
// whatever order a look-back reads the four in; with only copies of its
// sealed half, never.
func TestPairingCopies(t *testing.T) {
	k := testKey(t, 1)
	none := receptionID.EphemeralIdentity{}
	at := func(round id.Round) time.Time { return testSent.Add(time.Duration(round) * time.Second) }
	var perms func(ds []delivery) [][]delivery
	perms = func(ds []delivery) [][]delivery {
		if len(ds) <= 1 {
			return [][]delivery{ds}
		}
		var out [][]delivery
		for i := range ds {
			rest := slices.Concat(ds[:i], ds[i+1:])
			for _, p := range perms(rest) {
				out = append(out, append([]delivery{ds[i]}, p...))
			}
		}
		return out
	}
	n := seal(t, k.Address4, NoticeText, []byte("sent apart"), nil, 100)
	for first := range 2 { // which half went first: the notice is sealed for its round
		x, y := n[first], n[1-first]
		cases := []struct {
			ds    []delivery
			found int
		}{
			{[]delivery{{x, 100}, {y, 103}, {x, 105}, {y, 106}}, 1},
			{[]delivery{{x, 100}, {y, 103}, {y, 105}, {y, 109}}, 1},
			{[]delivery{{y, 103}, {x, 105}, {x, 107}}, 0}, // the first to go only ever as copies
		}
		for _, c := range cases {
			for _, order := range perms(c.ds) {
				var got []Notice
				s := testSession(k, func(n Notice) { got = append(got, n) })
				for _, d := range order {
					s.Process(cmixMessage(t, d.stream), nil, nil, none, roundAt(d.round, at(d.round)))
				}
				if len(got) != c.found {
					t.Fatalf("sealed half %d first, read %v: %d notices, want %d", first, roundsOf(order), len(got), c.found)
				}
				if c.found == 1 && (got[0].Round != 100 || !got[0].RoundTime.Equal(at(100))) {
					t.Fatalf("read %v: shown as sent in round %d", roundsOf(order), got[0].Round)
				}
				checkHeld(t, &s.pairs)
			}
		}
	}
}

// On mainnet a round's number is given when it's made, and its start when
// it's ready, so a round starting later can have a lower number (the reviews,
// 2026-10-18). A notice sent apart whose second half went in a lower-numbered
// round that started later is found, as sent in its first's round; copies in
// lower-numbered rounds that started later can't stop it, nor a notice sent
// whole, whatever order a look-back reads them in.
func TestPairingStartTimes(t *testing.T) {
	k := testKey(t, 1)
	none := receptionID.EphemeralIdentity{}
	type at struct {
		stream []byte
		round  id.Round
		start  time.Duration // after testSent
	}
	var perms func(ds []at) [][]at
	perms = func(ds []at) [][]at {
		if len(ds) <= 1 {
			return [][]at{ds}
		}
		var out [][]at
		for i := range ds {
			for _, p := range perms(slices.Concat(ds[:i], ds[i+1:])) {
				out = append(out, append([]at{ds[i]}, p...))
			}
		}
		return out
	}
	n := seal(t, k.Address4, NoticeText, []byte("out of order"), nil, 100)
	w := seal(t, k.Address4, NoticeText, []byte("whole"), nil, 200)
	for first := range 2 {
		x, y := n[first], n[1-first]
		cases := []struct {
			name  string
			ds    []at
			round id.Round
			found int
		}{
			{"second in a lower round", []at{{x, 100, 0}, {y, 97, 6 * time.Second}}, 100, 1},
			{"copies in lower rounds", []at{{x, 100, 0}, {y, 97, 6 * time.Second}, {x, 95, 20 * time.Second}, {y, 90, 30 * time.Second}}, 100, 1},
			{"a copy of the first only", []at{{x, 100, 0}, {x, 99, 3 * time.Second}, {y, 103, 8 * time.Second}}, 100, 1},
			{"the first only as a copy", []at{{y, 97, 6 * time.Second}, {x, 95, 20 * time.Second}}, 0, 0},
			{"whole, copies in lower rounds", []at{{w[first], 200, time.Minute}, {w[1-first], 200, time.Minute}, {w[first], 190, time.Minute + 10*time.Second}, {w[1-first], 185, time.Minute + 15*time.Second}}, 200, 1},
		}
		for _, c := range cases {
			for _, order := range perms(c.ds) {
				var got []Notice
				s := testSession(k, func(n Notice) { got = append(got, n) })
				for _, d := range order {
					s.Process(cmixMessage(t, d.stream), nil, nil, none, roundAt(d.round, testSent.Add(d.start)))
				}
				if len(got) != c.found {
					t.Fatalf("%s (half %d first): %d notices, want %d", c.name, first, len(got), c.found)
				}
				if c.found == 1 && got[0].Round != uint64(c.round) {
					t.Fatalf("%s: shown as sent in round %d, want %d", c.name, got[0].Round, c.round)
				}
				checkHeld(t, &s.pairs)
			}
		}
	}
}

// startsBefore orders rounds by start time, and by number when the times are
// the same (one round) or either isn't known.
func TestStartsBefore(t *testing.T) {
	at := func(round id.Round, start time.Duration) *half {
		h := &half{round: round}
		if start >= 0 {
			h.start = testSent.Add(start)
		}
		return h
	}
	const unknown = -1
	for _, c := range []struct {
		a, b *half
		want bool
	}{
		{at(100, 0), at(97, 6*time.Second), true}, // a later start can have a lower number
		{at(97, 6*time.Second), at(100, 0), false},
		{at(100, 0), at(100, 0), false},
		{at(99, 0), at(100, 0), true}, // the same time: by number
		{at(100, unknown), at(97, 6*time.Second), false},
		{at(97, 6*time.Second), at(100, unknown), true},
		{at(100, unknown), at(101, unknown), true},
	} {
		if got := startsBefore(c.a, c.b); got != c.want {
			t.Fatalf("round %d at %v before round %d at %v: %v, want %v", c.a.round, c.a.start, c.b.round, c.b.start, got, c.want)
		}
	}
}

// delivery is a message as a look-back reads it: its stream, in its round.
type delivery struct {
	stream []byte
	round  id.Round
}

func roundsOf(ds []delivery) (out []id.Round) {
	for _, d := range ds {
		out = append(out, d.round)
	}
	return out
}

// checkHeld checks what's held for pairing agrees with itself: every held
// message is under the tags it says, in its round's list, and counted once.
func checkHeld(t *testing.T, p *pairing) {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	indexed := map[*half]bool{}
	for name, index := range map[string]map[[pairTagLen]byte][]*half{"firsts": p.firsts, "seconds": p.seconds} {
		for tag, hs := range index {
			if len(hs) == 0 || len(hs) > pairPerTag {
				t.Fatalf("%s holds %d under one tag", name, len(hs))
			}
			for _, h := range hs {
				if (name == "firsts" && (!h.inFirsts || h.want != tag)) || (name == "seconds" && (!h.inSeconds || h.tag() != tag)) {
					t.Fatalf("a message under the wrong tag in %s", name)
				}
				indexed[h] = true
			}
		}
	}
	listed := 0
	for r, b := range p.rounds {
		if len(b.halves) == 0 {
			t.Fatalf("round %d is kept with nothing held", r)
		}
		for _, h := range b.halves {
			if h.round != r || !indexed[h] || (!h.inFirsts && !h.inSeconds) {
				t.Fatalf("round %d lists a message it doesn't hold", r)
			}
			listed++
		}
	}
	if listed != len(indexed) || listed != p.held {
		t.Fatalf("%d listed, %d under tags, %d counted", listed, len(indexed), p.held)
	}
}

// What's held for pairing is bounded, a new round always has room for its
// own messages, and a round's messages are let go of after pairKeep.
func TestPairingLimits(t *testing.T) {
	t.Parallel() // thousands of messages, as in TestPairingFlood
	k := testKey(t, 1)
	var got []Notice
	s := testSession(k, func(n Notice) { got = append(got, n) })
	none := receptionID.EphemeralIdentity{}
	send := func(round id.Round, streams ...[]byte) {
		for _, m := range streams {
			s.Process(cmixMessage(t, m), nil, nil, none, roundAt(round, testSent))
		}
	}
	// Labels end in a dot, so no two messages are the same ("wide1"+"32" and
	// "wide13"+"2" would be, and a message sent again is held once).
	junk := func(label string, n int) (out [][]byte) {
		for i := range n {
			out = append(out, counterBytes(fmt.Sprint(label, ".", i), streamLen))
		}
		return out
	}
	send(20, junk("flood", pairPerRound+4)...)
	if n := len(s.pairs.rounds[20].halves); n != pairPerRound || s.pairs.held != n {
		t.Fatalf("held %d messages of one round (counted %d), want %d", n, s.pairs.held, pairPerRound)
	}
	checkHeld(t, &s.pairs)
	// A message beyond what's held is still matched with what is: a
	// notice whose first half came after the round's held messages filled
	// up doesn't pair...
	a := seal(t, k.Address4, NoticeText, []byte("after a flood"), nil, 20)
	send(20, a...)
	if len(got) != 0 {
		t.Fatal("paired although the first half couldn't be held")
	}
	// ...but one whose first half was held does, junk or no junk after it,
	// and so does one whose second half came first.
	b := seal(t, k.Address4, NoticeText, []byte("first half held"), nil, 21)
	send(21, b[0])
	send(21, junk("flood2", pairPerRound+4)...)
	send(21, b[1])
	c := seal(t, k.Address4, NoticeText, []byte("second half held"), nil, 22)
	send(22, c[1])
	send(22, junk("flood3", pairPerRound+4)...)
	send(22, c[0])
	if len(got) != 2 || string(got[0].Body) != "first half held" || string(got[1].Body) != "second half held" {
		t.Fatalf("got %+v", got)
	}
	// Junk is never tried as a pair: only a matching tag is.
	if s.pairs.tries != 2 {
		t.Fatalf("%d pairs tried, want 2", s.pairs.tries)
	}
	// Across rounds, at most pairHeld in all: the oldest rounds go first,
	// and a new round always has room for pairPerRound of its own.
	for r := range pairHeld/pairPerRound + 3 {
		send(id.Round(100+r), junk(fmt.Sprint("wide", r), pairPerRound)...)
	}
	if s.pairs.held > pairHeld {
		t.Fatalf("held %d, at most %d", s.pairs.held, pairHeld)
	}
	checkHeld(t, &s.pairs)
	last := s.pairs.rounds[100+pairHeld/pairPerRound+2]
	if s.pairs.rounds[20] != nil || last == nil || len(last.halves) != pairPerRound {
		t.Fatal("the oldest rounds weren't the ones let go of, or the newest lacked room")
	}
	// Rounds nothing has come for in pairKeep are let go of.
	for _, b := range s.pairs.rounds {
		b.last = b.last.Add(-pairKeep - time.Second)
	}
	send(999, counterBytes("late", streamLen))
	if len(s.pairs.rounds) != 1 || s.pairs.held != 1 {
		t.Fatalf("%d rounds and %d messages still held", len(s.pairs.rounds), s.pairs.held)
	}
	checkHeld(t, &s.pairs)
	// Everything that didn't pair counts as someone else's.
	if want := 3*(pairPerRound+4) + 2 + (pairHeld/pairPerRound+3)*pairPerRound + 1; s.Others() != want {
		t.Fatalf("others = %d, want %d", s.Others(), want)
	}
}

// A half waits for its other half for pairKeep, ten minutes: a pickup the
// network failed is tried again within that (look-backs read a day's
// rounds together, but a failed round on its own), and a retry of the
// second goes within apartRounds of the first. Then it's let go of.
func TestPairingKeep(t *testing.T) {
	k := testKey(t, 1)
	none := receptionID.EphemeralIdentity{}
	if pairKeep < 10*time.Minute {
		t.Fatalf("pairKeep %s: a retried pickup could miss its other half", pairKeep)
	}
	for _, c := range []struct {
		waited time.Duration
		found  bool
	}{{pairKeep - time.Minute, true}, {pairKeep + time.Second, false}} {
		var got []Notice
		s := testSession(k, func(n Notice) { got = append(got, n) })
		n := seal(t, k.Address4, NoticeText, []byte("kept"), nil, 700)
		s.Process(cmixMessage(t, n[1]), nil, nil, none, roundAt(703, testSent))
		for _, b := range s.pairs.rounds {
			b.last = b.last.Add(-c.waited)
		}
		s.Process(cmixMessage(t, n[0]), nil, nil, none, roundAt(700, testSent))
		if (len(got) == 1) != c.found {
			t.Fatalf("after %s: found %d", c.waited, len(got))
		}
		// Halves that paired are let go of; one swept or alone stays held.
		if want := map[bool]int{true: 0, false: 1}[c.found]; s.pairs.held != want {
			t.Fatalf("after %s: %d held, want %d", c.waited, s.pairs.held, want)
		}
		checkHeld(t, &s.pairs)
	}
}

// A notice sent apart pairs with its first half held while later rounds
// bring junk, up to what's held in all: pairHeld less the first half's own.
func TestPairingApartLimits(t *testing.T) {
	t.Parallel() // thousands of messages a case, as in TestPairingFlood
	// More than a flood can put between halves sent apart: a minute's pause
	// and the first's confirmation, at a round about every 0.8 s.
	if gap := int((apartPauseMax + 10*time.Second) / (800 * time.Millisecond)); pairHeld <= gap*pairPerRound {
		t.Fatalf("pairHeld %d: %d rounds of junk between two halves could push one out", pairHeld, gap)
	}
	for _, c := range []struct {
		floods int // rounds of pairPerRound junk between the halves
		found  bool
	}{{pairHeld/pairPerRound - 1, true}, {pairHeld / pairPerRound, false}} {
		t.Run(fmt.Sprint("floods", c.floods), func(t *testing.T) {
			t.Parallel()
			k := testKey(t, 1)
			none := receptionID.EphemeralIdentity{}
			var got []Notice
			s := testSession(k, func(n Notice) { got = append(got, n) })
			n := seal(t, k.Address4, NoticeText, []byte("apart"), nil, 500)
			s.Process(cmixMessage(t, n[0]), nil, nil, none, roundAt(500, testSent))
			for r := range c.floods {
				for i := range pairPerRound {
					s.Process(cmixMessage(t, counterBytes(fmt.Sprint("flood", r, ".", i), streamLen)), nil, nil, none, roundAt(id.Round(501+r), testSent))
				}
			}
			s.Process(cmixMessage(t, n[1]), nil, nil, none, roundAt(id.Round(501+c.floods), testSent))
			if (len(got) == 1) != c.found {
				t.Fatalf("%d rounds of junk between the halves: found %d", c.floods, len(got))
			}
			checkHeld(t, &s.pairs)
		})
	}
}

// The review's flood (2026-10-18): once a trickle of junk has filled what's
// held, a round with junk of its own and a notice, in any order, must still
// give the notice; and so must two rounds a few apart with junk of their own
// and between them, holding a notice sent apart. With room for one message a
// round it lost a share 2/((k+1)(k+2)) of notices to k junk messages.
//
// Each case is thousands of messages, each costing a few X25519s, so the
// cases run side by side on sessions of their own, as do the other long
// pairing tests.
func TestPairingFlood(t *testing.T) {
	t.Parallel()
	for _, perRound := range []int{1, 2, 3, 100} {
		for _, gap := range []id.Round{0, 3} {
			t.Run(fmt.Sprintf("junk%d-gap%d", perRound, gap), func(t *testing.T) {
				t.Parallel()
				k := testKey(t, 1)
				none := receptionID.EphemeralIdentity{}
				rng := mrand.New(mrand.NewPCG(uint64(perRound), uint64(gap)))
				var got []Notice
				s := testSession(k, func(n Notice) { got = append(got, n) })
				trickle := pairHeld + 50
				if perRound > 1 {
					trickle = pairHeld/perRound + 50
				}
				for r := range trickle {
					for i := range perRound {
						s.Process(cmixMessage(t, counterBytes(fmt.Sprint("trickle", r, ".", i), streamLen)), nil, nil, none, roundAt(id.Round(r+1), testSent))
					}
				}
				if s.pairs.held > pairHeld {
					t.Fatalf("held %d", s.pairs.held)
				}
				const trials = 12
				for trial := range trials {
					round := id.Round(100000 + 10*trial) // past the trickle's rounds
					n := seal(t, k.Address4, NoticeText, []byte(fmt.Sprint("notice ", trial)), nil, uint32(round))
					// Each round of it brings its half (both, sent whole) and
					// junk, shuffled, and so does each round between.
					halves := [][]byte{n[0], n[1]}
					rng.Shuffle(2, func(i, j int) { halves[i], halves[j] = halves[j], halves[i] })
					for r := round; r <= round+gap; r++ {
						var msgs [][]byte
						switch {
						case gap == 0:
							msgs = slices.Clone(halves)
						case r == round:
							msgs = [][]byte{halves[0]}
						case r == round+gap:
							msgs = [][]byte{halves[1]}
						}
						for i := range perRound {
							msgs = append(msgs, counterBytes(fmt.Sprint("junk", trial, ".", r, ".", i), streamLen))
						}
						rng.Shuffle(len(msgs), func(i, j int) { msgs[i], msgs[j] = msgs[j], msgs[i] })
						for _, m := range msgs {
							s.Process(cmixMessage(t, m), nil, nil, none, roundAt(r, testSent))
						}
					}
				}
				if len(got) != trials {
					t.Fatalf("%d junk messages a round, halves %d rounds apart: %d of %d notices came through", perRound, gap, len(got), trials)
				}
				checkHeld(t, &s.pairs)
			})
		}
	}
}

// The second review's case (2026-10-18): with everything held, a round the
// owner already holds a message of still gets room for its own, so a notice
// whose round brought junk first isn't lost. (Live, a round's messages come
// together; in a look-back, rounds' messages interleave.)
func TestPairingExistingRoundRoom(t *testing.T) {
	t.Parallel() // thousands of messages, as in TestPairingFlood
	k := testKey(t, 1)
	var got []Notice
	s := testSession(k, func(n Notice) { got = append(got, n) })
	none := receptionID.EphemeralIdentity{}
	const noticeRound = 1
	for r := 1; r <= pairHeld-pairPerRound; r++ {
		s.Process(cmixMessage(t, counterBytes(fmt.Sprint("one", r), streamLen)), nil, nil, none, roundAt(id.Round(r), testSent))
	}
	burstRound := id.Round(pairHeld + 1000) // past the rounds of one each
	for i := range pairPerRound {
		s.Process(cmixMessage(t, counterBytes(fmt.Sprint("burst", i), streamLen)), nil, nil, none, roundAt(burstRound, testSent))
	}
	if s.pairs.held != pairHeld {
		t.Fatalf("held %d, want %d", s.pairs.held, pairHeld)
	}
	// The notice's round already holds one message; its halves arrive now.
	for _, m := range seal(t, k.Address4, NoticeText, []byte("in a round seen before"), nil, noticeRound) {
		s.Process(cmixMessage(t, m), nil, nil, none, roundAt(noticeRound, testSent))
	}
	if len(got) != 1 || string(got[0].Body) != "in a round seen before" {
		t.Fatalf("got %+v", got)
	}
	if s.pairs.held > pairHeld {
		t.Fatalf("held %d", s.pairs.held)
	}
	checkHeld(t, &s.pairs)
}

// Messages crafted to match each other's tags (someone sending their own
// halves, many of each, in one round or many) cost at most pairPerTag tries
// each, however many come.
func TestPairingCrafted(t *testing.T) {
	k := testKey(t, 1)
	none := receptionID.EphemeralIdentity{}
	for _, spread := range []bool{false, true} {
		s := testSession(k, func(Notice) {})
		// A first half someone made, sent again and again (same key, so the
		// same tag wanted), and as many second halves carrying that tag.
		n := seal(t, k.Address4, NoticeText, []byte("hello"), nil, 30)
		first := bytes.Clone(n[0])
		first[len(first)-1] ^= 1 // so it never opens
		h := newHalf(first)
		h.findWant(k)
		if !h.wants {
			t.Fatal("no tag worked out")
		}
		const each = 40
		var msgs [][]byte
		for i := range each {
			f := bytes.Clone(first)
			f[100] ^= byte(i) // still the same key
			msgs = append(msgs, f)
			second := counterBytes(fmt.Sprint("second", i), streamLen)
			copy(second, h.want[:])
			msgs = append(msgs, second)
		}
		for i, m := range msgs {
			round := id.Round(30)
			if spread {
				round += id.Round(i) // one a round, later each time
			}
			s.Process(cmixMessage(t, m), nil, nil, none, roundAt(round, testSent))
		}
		if limit := len(msgs) * pairPerTag; s.pairs.tries > limit || pairPerTag != 1 {
			t.Fatalf("%d tries for %d messages, at most %d (pairPerTag %d, want 1)", s.pairs.tries, len(msgs), limit, pairPerTag)
		}
		if s.pairs.tries == 0 {
			t.Fatal("the crafted pairs were never tried")
		}
		checkHeld(t, &s.pairs)
	}
}

// A quantum-safe notice's second message starts with the tag its first
// message's key gives the owner, and another inbox works out a different one.
func TestPairTag(t *testing.T) {
	k := testKey(t, 1)
	tags := map[[pairTagLen]byte]bool{}
	for i := range 20 {
		n := seal(t, k.Address4, NoticeText, []byte("hello"), nil, uint32(i))
		first, second := newHalf(n[0]), newHalf(n[1])
		first.findWant(k)
		if !first.wants || first.want != second.tag() {
			t.Fatalf("the owner works out %x, the second half starts %x", first.want, second.tag())
		}
		other := newHalf(n[0])
		other.findWant(testKey(t, 2))
		if other.want == first.want {
			t.Fatal("another inbox works out the same tag")
		}
		tags[first.want] = true
	}
	if len(tags) != 20 {
		t.Fatal("two notices share a tag")
	}
}

// xxDK calls Process from many goroutines; found must still be called once
// per notice, never concurrently, and not after Close.
func TestInboxSessionConcurrent(t *testing.T) {
	k := testKey(t, 1)
	var inFound, overlaps, calls atomic.Int32
	bodies := map[string]int{}
	s := testSession(k, func(n Notice) {
		if inFound.Add(1) > 1 {
			overlaps.Add(1)
		}
		calls.Add(1)
		bodies[string(n.Body)]++ // safe only because calls never overlap
		time.Sleep(time.Millisecond)
		inFound.Add(-1)
	})

	const distinct = 16
	var msgs []format.Message
	for i := range distinct {
		to := k.Address
		if i%2 == 1 {
			to = k.Address4
		}
		for _, m := range seal(t, to, NoticeText, []byte(fmt.Sprint(i)), nil, 1) {
			msgs = append(msgs, cmixMessage(t, m))
		}
	}
	var wg sync.WaitGroup
	for range 3 {
		for i := range msgs {
			wg.Add(1)
			go func() {
				defer wg.Done()
				s.Process(msgs[i], nil, nil, receptionID.EphemeralIdentity{}, roundAt(1, testSent))
			}()
		}
	}
	wg.Wait()
	if overlaps.Load() != 0 {
		t.Errorf("found ran concurrently %d times", overlaps.Load())
	}
	if calls.Load() != distinct || len(bodies) != distinct {
		t.Errorf("found called %d times for %d bodies, want %d", calls.Load(), len(bodies), distinct)
	}

	// After Close (minus its network half, which needs a Client), nothing
	// more is delivered.
	s.deliver.Lock()
	s.closed = true
	s.deliver.Unlock()
	late := seal(t, k.Address, NoticeText, []byte("late"), nil, 2)
	s.Process(cmixMessage(t, late[0]), nil, nil, receptionID.EphemeralIdentity{}, roundAt(2, testSent))
	if calls.Load() != distinct {
		t.Error("found was called after Close")
	}
}

// knownRound is the round the known-answer notices were sealed for.
const knownRound = 456090129

// The known-answer notices were sealed to the golden key ("abandon" x11,
// "about") for knownRound on 2026-10-18: the compact ones by
// the first build with round sealing, the quantum-safe one by the first with
// pairing tags.
const (
	knownTextNotice = "08967a1250f5d4030a64fe30ce96ad82f334d83e091df5b6a3230dc5199ee0bf" +
		"5fdf9332ed6f548a70771618faedb78daf95d977a0bb356f878e5c8aaa000b58" +
		"bcc9f980402ec1e427201f5dba9e12b388b828888000682c3cc00d954548ed03" +
		"733f2ab24577ad4946990c69210fc61d6dc96a00beb83b5bf0e5c70872aa866c" +
		"a88de37e1b2d5689083096dca17888683c93b7095cde0b7cc1f31b999aa58d39" +
		"d358bbcd7e24601a8630c35606959c9c71d7ffe365c7a5cf902b4f3da7b0afe0" +
		"23be4d0aae3fbd1cd7dd780e8d6920d289d0c89842842a8957b972883c5bd229" +
		"b93a61cadcc4ba1c6f88a85b99494be30ea1a5afdc8e3785319ac106b52f75a9" +
		"b5f8e95fca8d2fa86e152f74c348d1ea248d654baf0512e789e343e83ea59f36" +
		"668f935ccba71f6396ea616fb8c3693fb4048061d78c42844a4b734d4ce2feb6" +
		"88b70c836fc5b61348b163b14b62aa3ce9cb9f48511b22673beb3b80617c231c" +
		"3818adb4b362fce0ef6ac79399c2ba421ae5b870d89fb7b0be1a4ff28ea54bd8" +
		"aaff65abc1efbe9ee935fb82fd21a1e9325451bfbc55aa7d986fa5631dbc2365" +
		"512e45b580000735de23cc17690686b090caf2800a7e6e8ec93e6d1be32d28ff" +
		"a6333755636c81d5f6d6fc6ef6e16f54cb2862b41f21d8e92f23b8c274501cf7" +
		"da660a407cca2317ac13f29522d56c59a4ac7ba30d7c42244ed48961b7968018" +
		"93a2a55f226982264d38eeabfd60e37d4380411543bf2248e3af19a45123f2d0" +
		"bef7fd349b67a68ba672b11ff2a3de483e7bc611facae486e47fbb51574ac1be" +
		"ed417c1d025f1b900008f174bc9477af6c41f1df3cb56b6f1e01f42d60416453" +
		"fdd7a2c503a89a16811258384ac4fb1b1cf13103b0227e26fda7c207f09e7311" +
		"e80a2a1e72d8152f9cb36ffc4f747fa4d642ee54a6522c8683ca10a2a83b9566" +
		"5b6bbdedfe79acf86d2274c85ad449480a5f1f3ef67a1375231a632d5b96d66e" +
		"10f5c736d0dfa42885a9002e545ce814095c33f774c3e348c2d6652b29438860" +
		"629416edca376bee0fa2322b226bb81a4ab0defc1e07e83bf232ae36a7dc3963" +
		"57c94e9af75b8eb94da5964c0682b8a0e4f4fb826025fe073b6b94137d7c1d06" +
		"869695aa42842defc1f77550f6ed1f086c80898708d256a7f9756576a6e731f2" +
		"517228965dc960eefb63a091de424182131f2519389b786a22b8e34cace7af88" +
		"bfabc4f8d3f2150fc0f3ef4f59e6c40bd3a991ac49a8d241b87e86bbf0bb997a" +
		"eb4feca3b2fe8ef76a452698f72f9f229538e69837e44841fe7307873804be91" +
		"4b64a7da61a0fbd7e808fe2a986e53b99c1b6bb25cf264a66b1901d73e4f5b52" +
		"8960df35824e016ba9ce0bcc9ec43ecdc2eba467743e0f9df8b812eb"
	knownTextNotice4 = "e49bd9d97bb1673f07845d5b4a7726929a487e1c91a9a77e7d1be38745884bf8" +
		"1c6b3f9764e8b618bcc1e4db4aeeb9e4c0a556f98f1fc2be35bbf31a6a5e314c" +
		"9ca580c3d2c7666062f0c0452f2f4d0b6357e0df90b5cea94ef72ff9d9f9c898" +
		"39de9200af4117449c055722c2650afdbc29c99e32484518ceca0398ae419dd9" +
		"cfd21697a66f8f12adb9c6ecb0656ba5f42d5bdd653432f994f74f73ff11c5f4" +
		"94cb1088416bff73a7e72b39be7ffea8b107cc4f1cebb215e2dd983ee52f1c10" +
		"a2192b48687fe0e614752b3d8ea2598c9c42227f842b77debd4e05361604df3d" +
		"ab8ce2bfef0a1ed49f0c7015119faaa8f6a9270c9cdb65a032902bc6facd60b9" +
		"f25e6b4590bd8302af5fa29660792e7e3c359974e8055980f67e126d5cb7a571" +
		"7eb809fbbbd27f4e220182d84fd8ea8dbb8812cc9410616160361d230d2ca838" +
		"31211821c63db8f29a191a68489403ce44b7ec304ba2d8734714e2a49a7af218" +
		"33e5dd1610b67bd5ff4a977910f8b034ef3683aa680d616760def47a03f8f66e" +
		"4a3c33af83b450eb8f8e779010c6da2c6da6a3482ed50f2f909219753d95d65a" +
		"ad074709b4211ade6820cfe274cdf10f0f642b3484849dd746107296f6654634" +
		"0bbfea42c8b6a456782f38be687422faf3db86c624608cacbc138a0f946dafc2" +
		"2f1f77eaebec4cf6d51995a3de2af689575a9cfa4df5846933f07e9394e42dd2" +
		"e397f9b987d11ead84d1c0094c6752086b8f96aa8855d6fd3f3a66214ef254ff" +
		"6459f364e41fd2483ad3200b2b4f47d95d11cda48075ac270f5304936189e0a1" +
		"d6f9179e4a043abfd4fcbcf85054c111dbf57db1e9cdc2c059910bfe9a2c5fbc" +
		"e787b6c33e2e86fe2bbab8e752a0760ad31069ed7180506049e7840a0725ddc4" +
		"bc7d6f19fdfa12c418983e25ba051172ad7349878f486b7c4f8a8794be2a31e7" +
		"fedd180e727073107aa704a97458da3a2d3eec734524e8742cfa640c3ab56ee6" +
		"9e8936f28e0fce4b3e1ab1881192b50e2b6278f0d70ed49243a5506b862dd82a" +
		"1d3304ab29b2bf0d5a0156762c4acdd61ffeb4781f98d0a84ce210d2aaeb5a17" +
		"502fabbea4d0c36d38bf106dea809dede8291dd60f8d3adb3c1c7b979b323b05" +
		"78488f8c3d3f49e545bfa1be56833162fb8c02ab22c306b523bfd47a77b78e51" +
		"ee3f5f3d8b1cd6a17ffc5687001cd864cd4bc54321548bcf6a6524d85bb410e6" +
		"c9256d53b1003875fbb63dec754dfc6b38ad0604a8fc833e1445f4ae7eb1ba57" +
		"863d4956b0560931ffb19b2b7a987e2f7a7bf46ae64c605533fd7c9a78c6a8a1" +
		"2b34988f3f29547e745bee8283b4c79837430e8f5a462391d011aa278e0f237f" +
		"34655afcbce820a917e371a0ca4905b7ec6f485e91095196f5d1c0dddc09a3f2" +
		"36b46906e877a75361089693a821389e52dc8ee24fe50161f03ffd5856dfdd3b" +
		"a19fffee27a51063f7bde4ef279c21c9891c4676fa82bbc5040f89f3d22493a9" +
		"a3d9068d46f93b43a06eb51f0d0927579a5aad4967b3cba5b28f30de875f03e5" +
		"970c45ced88167aa4d13961c32e2c545f7d4c15560bffd668ba5f7b469ab61d6" +
		"0ffb6bc9871dbc85ec88486aca4875c8920f44dc40d02f095f2aed10357bf72b" +
		"ae2d5e597f296fb9141d71a95cc76fb38093d9f9837a7a0a1232c3d934f39c37" +
		"3eb181a73d812fa1689a828e4e5ace724a8a0c083d56bcf2568a600c7271adb3" +
		"c5caafb40bdaa55189e84f55341577da145251675f18e1b40009d3c2af4eecde" +
		"d1fff92c8ba503deee337ff961a333b50eb5fb650f43d9475509b258da268c4e" +
		"4bfc5d8f5d000e5a83ea77846a496e67c61af4ec9380299811038595a386edc0" +
		"4d7bc75e29212d23fb92f9fe5edfcc82941b0770a2e9cb11f03c9be5f544bd0a" +
		"359ef90616cc0805483e6d9a098e734adc4e6e1c6be5597f0a9900d0c8f00a7b" +
		"62aa23e3c411b6c1d94ab12987d2aeafc2574e56ea7fc8eab9237544e9959107" +
		"1a515d4bc81b5f2256275fcb7435768660e9a55f09f44dae6e5851ad419f1fde" +
		"505e726b832677dee8862e1ab6201315a44a6a3c1af61e3ffd3779eace36678e" +
		"e82d8ae28d172b21c162978140cc9363820aa7ddba4b0f703fcd8e46fa9800a9" +
		"11e046d9a3f3a85c1dc8263ffcdb0d157b5efa51334a989fed2b900cf835da3c" +
		"1de6eb1e0c15dc6057441cdc10ce7250d6259cf154593687e985d0deb1f6840b" +
		"cd783ce0b273fdf18ca9a3045ff0a4f88f71cef7bb40527d7115ea9f378e93c1" +
		"b58e014ee12a7d3e559858d6dedda39e29b3eeb91061957277868618c56676c3" +
		"6893ebd0703467a07acc7041b4c65e398841851b655bab4e63d81dbdb92d933d" +
		"53c5256db07a10cc4dce78a61dc5c147c51c5ba989088ee885099f36ad540dc6" +
		"24bd06bf80933498a6ffb822af1995ae5f340f85af12d35966d9321e4a2427b0" +
		"ae2acd5bb0de4569f9c475dfea5bf769df15c658a1b070c9bda850298a55e5c4" +
		"c55e0d20bbd9a1cd48c4de3619791ec50fc95772043d52fd59f62dbf5a0af198" +
		"254d5f85106bbb51a665a2df5d4da286bdd66d08e5e1ae00868c63c09390bb04" +
		"401b864f2d49c17ab44905330b1a80823b6f979d8be9a9a72c13cfe89270e2ab" +
		"eeb01d1715d9ff3367406a3cac91804f3c5a7f53f3e3f5c21cb611a085e9a352" +
		"b1e1de5f2eda87f2a8f38c1e54cf43e3de8fcfc38a768e67173ce293c41f28e8" +
		"c47718f5ff09a0ad3cc2986a15973a90505102e56d6abe723f46ad8c7ddb2f6a" +
		"5b67bacc4cdec2f8ab063e85fb24e3ae78756f1b024a022e"
	knownDeflatedNotice = "2e6142186e019fc1fe583205de3d4306299c63eff2f1089cd33a5ff714a3eb61" +
		"573bc452152461dfe2f416d5fb612bcb72a075563cd41177b2749ed92ed81a12" +
		"cb1bb8a57381f4eeaac24be273405ed78d85999dba504bdb7626a2a386be7835" +
		"16de38b48c674df0404628e0f1fcfb60a85fe75e83f917bfb89d37fd23ee2e75" +
		"87b36aa57227cbd7cc44fac74bc40b63b76eaff762ea3a67dd064a2e5218042e" +
		"6dcfb960ae50f0fca754cb94e45c03340ab0be0118044ae77ae861956068b5e0" +
		"5832c01ed0d694fe94219baf6ca2023dce54a511f3655e5ec59e701dce1830ae" +
		"7e208c0825092aca198001370a1bafe16cb2f32c2d605a11d857d9a5d132ff8f" +
		"0f07f6ed44ea3685366485fe7cf60161f0bcfa141efbf50dfa07a98c23493fb9" +
		"7f570d229c8de5a0bb13a63f5e5eb1735119384699b4904e6ffa6e9232dde6ad" +
		"24b1be492bbd6d2fe2a3a0b8558e91fe2098086a83ede1ea39f01a6998dd93e2" +
		"bc242a63885e590143dc966fdfc2d0aef02ec6caaef39a65c86193a75f66ccf7" +
		"890c6ca66412405d91a0758d7734d4c03e97c5310fcce0047e485bd3dfc86e43" +
		"bc178ac5db5c23588cf824bb250c3f81efe4dce0a56d9daf5c2c6dc16baf2c96" +
		"55576189fc27d5236432eef8285b34aa26c3392e4c6236d8f7bf57ae371b92ae" +
		"0c680a42b23f9f0d7450ba804eeb7edf12d638eca97c9fd68e97ea1ec432a951" +
		"44ed4a38e40c95faa646adf2ba72bea24a3d6f3315b21917f96d29d6f7f4ad32" +
		"8c9c432f513c4b2cf9d68cdf248db16fcc4b87c9e84fd830f27f68b401db9000" +
		"f374c950ee41e20a2925da0bb1657ccc60d96a6f5d17af36e7fc1d50864a1849" +
		"8850e9bc87865bacc3a882acdb9196d8a9e29d071271cac3ef5a53c281f57207" +
		"6e90b269481a7f504a6684246c0d3ff8d101c17c0441302cb63267684e33b7dd" +
		"01cd15a3c2971dfe68590462133f7e2da84a750b91f5b15ac02c4d48b7076b91" +
		"15942ccdd375ef6f0c8a1c4e6bf1038962fa09e999243c4a728b8e13e6b43fcc" +
		"1ce32ed1070d02a5e6d4e7e68b6258b0add468d7976074a95a379bf7bcc6b970" +
		"7c78dfdf37dfb5cbeb4bb6a2bc869f07491da0732bb5f57bfb2524c2e8a79daf" +
		"4bccd923aa329e19762c11941a88771390e4d96eda1b9c138ed7952b483bf5ac" +
		"ad45b49a4319cebb697c61e3f36f67f466484fe71758f236ae8a14e7a03074f8" +
		"9cf6d5977bcce5b68f16d04b8dd4a5f5fec96a5b1333f5dc1a8dd811c4418ef6" +
		"0187ab2c1dbb6112dbf3a2f5b477d21cbc20f782d9b0687f6edd70cb6ec7ad38" +
		"48ce5672c8e21324d7981d77231e5addcabde172f9df192fc133c86d375d4e24" +
		"f5ca7457111a99ef53515c13ba15c88a59c093471eb24b09bfc394a4"
)

// The look-back counts as finished only once every past label has been
// checked, every pickup has finished, a minimum time has passed and all of
// that has held for a moment; then it stays finished. Rounds the network
// keeps failing to hand over hold it up for lookbackGiveUp at most.
func TestLookbackUpdate(t *testing.T) {
	t0 := time.Unix(1_800_000_000, 0)
	l := lookback{opened: t0}
	at := func(d time.Duration) time.Time { return t0.Add(d) }

	// Before xxDK has added the labels, nothing is left, but it isn't done.
	if got := l.update(at(time.Second), 0, 0, 0); got.Finished || got.DaysTotal != 0 {
		t.Fatalf("finished before any label was seen: %+v", got)
	}
	if got := l.update(at(2*time.Second), 21, 0, 0); got.DaysLeft != 21 || got.DaysTotal != 21 || got.Finished {
		t.Fatalf("21 labels: %+v", got)
	}
	l.update(at(5*time.Second), 3, 2, 0)
	// Labels done, but pickups still under way.
	if got := l.update(at(12*time.Second), 0, 1, 0); got.Finished || got.Collecting != 1 || got.DaysTotal != 21 {
		t.Fatalf("still collecting: %+v", got)
	}
	// Done, but it has to hold for lookbackSettle.
	if got := l.update(at(13*time.Second), 0, 0, 0); got.Finished {
		t.Fatal("finished without settling")
	}
	// A late pickup restarts the wait.
	l.update(at(14*time.Second), 0, 1, 0)
	l.update(at(15*time.Second), 0, 0, 0)
	if got := l.update(at(17*time.Second), 0, 0, 0); got.Finished {
		t.Fatal("finished before settling again")
	}
	if got := l.update(at(18*time.Second), 0, 0, 0); !got.Finished || got.Missing != 0 {
		t.Fatalf("not finished after settling: %+v", got)
	}
	// Once finished, it stays so, even when something new is being collected.
	if got := l.update(at(20*time.Second), 0, 3, 0); !got.Finished || got.Collecting != 3 {
		t.Fatalf("finished should stick: %+v", got)
	}

	// With no past label ever seen, it waits lookbackNoLabels before
	// finishing.
	l = lookback{opened: t0}
	l.update(at(lookbackMinimum), 0, 0, 0)
	if got := l.update(at(lookbackMinimum+lookbackSettle), 0, 0, 0); got.Finished {
		t.Fatal("finished with no labels before lookbackNoLabels")
	}
	l.update(at(lookbackNoLabels), 0, 0, 0)
	if got := l.update(at(lookbackNoLabels+lookbackSettle), 0, 0, 0); !got.Finished {
		t.Fatal("never finished with no labels")
	}

	// A round the network won't hand over holds it up for lookbackGiveUp,
	// then it finishes and says how many are missing.
	l = lookback{opened: t0}
	l.update(at(time.Second), 2, 0, 0)
	l.update(at(20*time.Second), 0, 0, 1)
	if got := l.update(at(20*time.Second+lookbackGiveUp-time.Second), 0, 0, 1); got.Finished {
		t.Fatal("gave up on a failed round too soon")
	}
	// Something else under way restarts the wait.
	l.update(at(20*time.Second+lookbackGiveUp), 0, 1, 1)
	if got := l.update(at(21*time.Second+lookbackGiveUp+lookbackSettle), 0, 0, 1); got.Finished {
		t.Fatal("gave up while a pickup was under way")
	}
	l.update(at(30*time.Second+2*lookbackGiveUp), 0, 0, 1)
	if got := l.update(at(30*time.Second+2*lookbackGiveUp+lookbackSettle), 0, 0, 1); !got.Finished || got.Missing != 1 {
		t.Fatalf("didn't finish with one missing: %+v", got)
	}
	// If the retry works later, nothing is missing.
	if got := l.update(at(time.Hour), 0, 0, 0); !got.Finished || got.Missing != 0 {
		t.Fatalf("after the retry worked: %+v", got)
	}
}

func TestUploadNoticeDelay(t *testing.T) {
	lo, hi := uploadNoticeMax, uploadNoticeMin
	for range 2000 {
		d := UploadNoticeDelay()
		if d < uploadNoticeMin || d > uploadNoticeMax {
			t.Fatalf("delay %s outside %s to %s", d, uploadNoticeMin, uploadNoticeMax)
		}
		lo, hi = min(lo, d), max(hi, d)
	}
	// Spread over the whole range, not stuck at one end.
	if lo > uploadNoticeMin+10*time.Second || hi < uploadNoticeMax-10*time.Second {
		t.Fatalf("delays only spread from %s to %s", lo, hi)
	}
}

func TestUploadNoticeTime(t *testing.T) {
	now := time.Date(2026, 10, 16, 10, 0, 0, 0, time.UTC)
	ended := now.Add(-30 * time.Second)
	for range 200 {
		at := UploadNoticeTime(ended, now)
		if at.Before(ended.Add(uploadNoticeMin)) || at.After(ended.Add(uploadNoticeMax)) {
			t.Fatalf("notice at %s for an upload that ended at %s", at, ended)
		}
	}
	// A time in the future (a wrong clock) counts as now.
	if at := UploadNoticeTime(now.Add(time.Hour), now); at.After(now.Add(uploadNoticeMax)) {
		t.Fatalf("a future end time made the wait %s", at.Sub(now))
	}
	// Long after the upload (Try again), it can go at once.
	if at := UploadNoticeTime(now.Add(-time.Hour), now); !at.Before(now) {
		t.Fatalf("an hour later it still waits until %s", at)
	}
}

// A look-back cut short can carry on only from what's certainly collected:
// days still to check, nothing in flight and nothing failed.
func TestLookbackDoneFrom(t *testing.T) {
	pending := time.Date(2026, 10, 9, 0, 0, 0, 0, time.UTC)
	for _, c := range []struct {
		left, inFlight, failed int
		want                   time.Time
	}{
		{7, 0, 0, pending},
		{7, 1, 0, time.Time{}},
		{7, 0, 2, time.Time{}},
		{0, 0, 0, time.Time{}}, // finished, or nothing to say: Finished covers it
	} {
		if got := doneFrom(c.left, c.inFlight, c.failed, pending); !got.Equal(c.want) {
			t.Errorf("doneFrom(%d, %d, %d) = %s, want %s", c.left, c.inFlight, c.failed, got, c.want)
		}
	}
}
