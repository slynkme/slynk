package main

import (
	"bytes"
	"crypto/mlkem"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math/big"
	"testing"
	"time"
)

// goldenKey4 is the core's golden test inbox ("abandon" ×11, "about"), whose
// words stand for 16 zero bytes.
func goldenKey4(t *testing.T) *Key4 {
	t.Helper()
	k, err := key4FromEntropy(make([]byte, 16))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// The v4 address leads to the same inbox as today's: its compact form is the
// core's golden v3 address (core/transfer/inbox_test.go).
func TestSameInboxAsV3(t *testing.T) {
	const v3 = "03398330eaeb0a19e6abcfe411c31a0f2c3ef90a5b3cb7511a67177161bd919955"
	k := goldenKey4(t)
	if got := hex.EncodeToString(k.Address.V3()); got != v3 {
		t.Fatalf("v3 form %s, want %s", got, v3)
	}
	b := k.Address.Bytes()
	if len(b) != Inbox4AddressLen || Inbox4AddressLen != 1217 {
		t.Fatalf("address is %d bytes", len(b))
	}
	a, err := ParseAddress4(b)
	if err != nil || !bytes.Equal(a.Bytes(), b) {
		t.Fatal("address doesn't round-trip")
	}
}

func TestParseAddress4Rejects(t *testing.T) {
	b := goldenKey4(t).Address.Bytes()
	for name, bad := range map[string][]byte{
		"short":       b[:len(b)-1],
		"long":        append(bytes.Clone(b), 0),
		"v3":          append([]byte{3}, b[1:]...),
		"bad ML-KEM":  func() []byte { c := bytes.Clone(b); c[33], c[34] = 0xff, 0xff; return c }(),
		"small order": func() []byte { c := bytes.Clone(b); copy(c[1:33], make([]byte, 32)); c[1] = 1; return c }(),
	} {
		if _, err := ParseAddress4(bad); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestKemeleonRoundTrip(t *testing.T) {
	ek := goldenKey4(t).Address.ek
	for i := 0; i < 200; i++ {
		_, ct := ek.Encapsulate()
		enc, err := kemeleonEncode768(ct)
		if errors.Is(err, errKemeleonReject) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(enc) != Kem768Len {
			t.Fatalf("encoded %d bytes", len(enc))
		}
		got, err := kemeleonDecode768(enc)
		if err != nil || !bytes.Equal(got, ct) {
			t.Fatal("ciphertext doesn't round-trip")
		}
	}
}

func TestPack10(t *testing.T) {
	c := make([]uint16, u768Count)
	for i := range c {
		c[i] = uint16(i*37) & 0x3ff
	}
	if !equal16(unpack10(pack10(c), len(c)), c) {
		t.Fatal("pack10 doesn't round-trip")
	}
	// Every value mod q compresses into its own bin, and the bins hold 3 or 4.
	for c, b := range bins {
		if len(b) != 3 && len(b) != 4 {
			t.Fatalf("bin %d holds %d values", c, len(b))
		}
	}
}

func equal16(a, b []uint16) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestNoticeRoundTrip(t *testing.T) {
	k := goldenKey4(t)
	sent := time.Date(2026, 10, 17, 12, 34, 0, 0, time.UTC)
	for _, msgLen := range []int{926, 988} {
		for _, n := range []int{0, 1, 300, MaxBody4(msgLen)} {
			body := make([]byte, n)
			rand.Read(body)
			ps, err := sealNotice4(k.Address, body, sent, msgLen)
			if err != nil {
				t.Fatal(err)
			}
			if len(ps) != 2 || len(ps[0]) != msgLen || len(ps[1]) != msgLen {
				t.Fatalf("pieces are wrong sizes")
			}
			o, err := openPair(k, ps[0], ps[1])
			if err != nil {
				t.Fatalf("%d/%d: %v", msgLen, n, err)
			}
			if !bytes.Equal(o.body, body) || !o.sent.Equal(sent) {
				t.Fatal("contents differ")
			}
			if _, err := openPair(k, ps[1], ps[0]); err == nil {
				t.Fatal("opened with the pieces swapped")
			}
		}
		if _, err := sealNotice4(k.Address, make([]byte, MaxBody4(msgLen)+1), sent, msgLen); err != errSize {
			t.Fatalf("too long: %v", err)
		}
	}
	if MaxBody4(926) != 544 || MaxBody4(988) != 668 {
		t.Fatalf("text room %d / %d", MaxBody4(926), MaxBody4(988))
	}
}

func TestOtherInboxCantOpen(t *testing.T) {
	k := goldenKey4(t)
	other := mustKey()
	ps, err := sealNotice4(k.Address, []byte("hello"), time.Now(), 926)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openPair(other, ps[0], ps[1]); err == nil {
		t.Fatal("another inbox opened it")
	}
}

// Changing any byte of either piece stops the notice opening.
func TestTamper(t *testing.T) {
	k := goldenKey4(t)
	ps, err := sealNotice4(k.Address, []byte("hello"), time.Now(), 926)
	if err != nil {
		t.Fatal(err)
	}
	for p := range ps {
		for _, i := range []int{0, 31, 32, 500, 925} {
			c := [][]byte{bytes.Clone(ps[0]), bytes.Clone(ps[1])}
			c[p][i] ^= 1
			if _, err := openPair(k, c[0], c[1]); err == nil {
				t.Errorf("piece %d byte %d: opened after a change", p, i)
			}
		}
	}
}

// Anyone can re-encode the keys without knowing anything secret: a fresh
// Kemeleon widening, the other Elligator representative or other spare top
// bits. A re-encoded copy must not open, or it would slip past the owner's
// check for copies of a notice.
func TestReencodedCopyWontOpen(t *testing.T) {
	k := goldenKey4(t)
	ps, err := sealNotice4(k.Address, []byte("hello"), time.Now(), 926)
	if err != nil {
		t.Fatal(err)
	}
	stream := append(bytes.Clone(ps[0]), ps[1]...)
	kem := stream[keyRepLen : keyRepLen+Kem768Len]
	ct, _ := kemeleonDecode768(kem)
	var again []byte
	for again == nil || bytes.Equal(again, kem) {
		again, _ = kemeleonEncode768(ct)
	}
	if got, _ := kemeleonDecode768(again); !bytes.Equal(got, ct) {
		t.Fatal("re-encoding changed the ciphertext")
	}
	re := bytes.Clone(stream)
	copy(re[keyRepLen:], again)
	if _, err := openPair(k, re[:926], re[926:]); err == nil {
		t.Fatal("a re-widened copy opened")
	}
	// The spare top bits of the X25519 representative and of the number.
	for _, i := range []int{keyRepLen - 1, keyRepLen} {
		re := bytes.Clone(stream)
		re[i] ^= 0x80
		if _, err := openPair(k, re[:926], re[926:]); err == nil {
			t.Fatalf("flipping a spare bit at %d opened", i)
		}
	}
}

func TestOpenRound(t *testing.T) {
	k := goldenKey4(t)
	a, _ := sealNotice4(k.Address, []byte("first"), time.Now(), 926)
	b, _ := sealNotice4(k.Address, []byte("second"), time.Now(), 926)
	msgs := [][]byte{randomMessage(926), b[1], a[0], randomMessage(926), b[0], a[1]}
	found, tried := openRound(k, msgs)
	if len(found) != 2 || tried > len(msgs)*(len(msgs)-1) {
		t.Fatalf("found %d after %d tries", len(found), tried)
	}
	// Two notices' halves mixed up don't open.
	if _, err := openPair(k, a[0], b[1]); err == nil {
		t.Fatal("halves of two notices opened together")
	}
}

func TestSizesMatchStdlib(t *testing.T) {
	if mlkem.CiphertextSize768 != ct768Len || mlkem.EncapsulationKeySize768 != 1184 {
		t.Fatal("ML-KEM-768 sizes changed")
	}
}

// A quick version of the lab's randomness checks, so a broken encoding fails
// a test: the spare top bits are fair, the widened values cover all of mod q
// (not one per pattern), and the ML-KEM test can't tell.
func TestLooksRandom(t *testing.T) {
	k := goldenKey4(t)
	const n = 400
	var top, spare, flagged int
	seen := map[uint64]bool{}
	for range n {
		ps, err := sealNotice4(k.Address, nil, time.Now(), 926)
		if err != nil {
			t.Fatal(err)
		}
		stream := append(bytes.Clone(ps[0]), ps[1]...)
		top += int(stream[keyRepLen-1] >> 7)
		spare += int(stream[keyRepLen] >> 7)
		if llrMLKEM768(stream[keyRepLen:]) > 0 {
			flagged++
		}
		for _, d := range digits(stream[keyRepLen : keyRepLen+kem768ULen]) {
			seen[d] = true
		}
	}
	if top < n*35/100 || top > n*65/100 {
		t.Errorf("representative's top bit set %d times in %d", top, n)
	}
	if spare < n*35/100 || spare > n*65/100 {
		t.Errorf("a spare bit of the number set %d times in %d", spare, n)
	}
	if flagged > n*15/100 {
		t.Errorf("the ML-KEM test flagged %d of %d", flagged, n)
	}
	if len(seen) < kemQ-50 {
		t.Errorf("only %d of %d values mod q seen", len(seen), kemQ)
	}
}

// digits reads an encoded u back as its base-q values.
func digits(b []byte) []uint64 {
	c := bytes.Clone(b)
	c[0] &= 1<<(kem768Bits%8) - 1
	n := new(big.Int).SetBytes(c)
	out := make([]uint64, u768Count)
	r := new(big.Int)
	for i := range out {
		n.QuoRem(n, bigQ, r)
		out[i] = r.Uint64()
	}
	return out
}

// keepV rejects a 0 in v one time in 209 and nothing else.
func TestKeepV(t *testing.T) {
	ones := bytes.Repeat([]byte{0x11}, ct768VLen)
	zeros := make([]byte, ct768VLen)
	kept := 0
	for range 300 {
		if ok, _ := keepV(ones); !ok {
			t.Fatal("rejected a v with no zeros")
		}
		if ok, _ := keepV(zeros); ok {
			kept++
		}
	}
	// (208/209)^256 ≈ 0.29, so about 88 of 300.
	if kept < 40 || kept > 140 {
		t.Fatalf("all-zero v kept %d times in 300", kept)
	}
}
