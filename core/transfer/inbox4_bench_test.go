package transfer

import (
	"crypto/mlkem"
	"fmt"
	mrand "math/rand/v2"
	"testing"

	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/xx_network/primitives/id"
)

// What a quantum-safe notice costs, for the public write-up
// (docs/findings/quantum-safety.md): natively with
// `go test -bench Inbox4 ./transfer/`, and as WebAssembly, close to a
// browser's speed, with GOOS=js GOARCH=wasm and $(go env GOROOT)/lib/wasm on
// the PATH.

func benchKey(b *testing.B) *InboxKey {
	b.Helper()
	k, err := inboxKeyFromEntropy(make([]byte, inboxEntropyLen))
	if err != nil {
		b.Fatal(err)
	}
	return k
}

func BenchmarkInbox4Seal(b *testing.B) {
	s, err := newNoticeSealer(benchKey(b).Address4, NoticeText, []byte("a message"), nil, nil, msgLen)
	if err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		if _, err := s(1); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkInbox4Open(b *testing.B) {
	k := benchKey(b)
	s, err := newNoticeSealer(k.Address4, NoticeText, []byte("a message"), nil, nil, msgLen)
	if err != nil {
		b.Fatal(err)
	}
	streams, err := s(1)
	if err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		if _, err := openNotice4(k, newHalf(streams[0]), streams[1]); err != nil {
			b.Fatal(err)
		}
	}
}

// A pair that isn't one: the price of a try, which the owner makes only for
// a pair whose tags match (one a notice, crafted ones at most pairPerTag a
// message).
func BenchmarkInbox4TryJunkPair(b *testing.B) {
	k := benchKey(b)
	first := newHalf(counterBytes("first", streamLen))
	second := counterBytes("second", streamLen)
	for b.Loop() {
		if _, err := openNotice4(k, first, second); err == nil {
			b.Fatal("junk opened")
		}
	}
}

func BenchmarkInbox4KeyFromWords(b *testing.B) {
	for b.Loop() {
		if _, err := inboxKeyFromEntropy(make([]byte, inboxEntropyLen)); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkKemeleonEncode(b *testing.B) {
	dk, err := mlkem.GenerateKey768()
	if err != nil {
		b.Fatal(err)
	}
	_, ct := dk.EncapsulationKey().Encapsulate()
	for b.Loop() {
		kemeleonEncode768(ct) // a rejection costs the same work
	}
}

func BenchmarkKemeleonDecode(b *testing.B) {
	in := counterBytes("encoded", Kem768Len)
	for b.Loop() {
		if _, err := kemeleonDecode768(in); err != nil {
			b.Fatal(err)
		}
	}
}

// A reply sealed with reply keys: sealing and opening one.
func BenchmarkReplySeal(b *testing.B) {
	k, other := benchKey(b), benchKey(b)
	keys, err := k.replyKeysFor(other.Address)
	if err != nil {
		b.Fatal(err)
	}
	s, err := newNoticeSealer(k.Address, NoticeText, []byte("a reply"), &From{Key: other}, keys, msgLen)
	if err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		if _, err := s(1); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkReplyOpen(b *testing.B) {
	k, other := benchKey(b), benchKey(b)
	keys, err := k.replyKeysFor(other.Address)
	if err != nil {
		b.Fatal(err)
	}
	s, err := newNoticeSealer(k.Address, NoticeText, []byte("a reply"), &From{Key: other}, keys, msgLen)
	if err != nil {
		b.Fatal(err)
	}
	streams, err := s(1)
	if err != nil {
		b.Fatal(err)
	}
	for b.Loop() {
		m := newHalf(streams[0])
		if _, err := openCompact(k, m); err == nil {
			b.Fatal("a reply opened as a compact notice")
		}
		if _, err := openReply(k, m); err != nil {
			b.Fatal(err)
		}
	}
}

// What trying a message as a reply adds, once the X25519 it shares with the
// pairing tag is worked out: the price of the reply try for a message that
// isn't one.
func BenchmarkReplyTryJunk(b *testing.B) {
	k := benchKey(b)
	m := newHalf(counterBytes("junk", streamLen))
	m.shared(k)
	for b.Loop() {
		if _, err := openReply(k, m); err == nil {
			b.Fatal("junk opened")
		}
	}
}

// One message that isn't for the inbox, as Process handles it: tried as a
// compact notice and as a reply, then its tag worked out and looked up, and
// held. What a flood costs the owner, per message.
func BenchmarkInboxJunk(b *testing.B) {
	k := benchKey(b)
	s := newInboxSession(k, func(Notice) {})
	none := receptionID.EphemeralIdentity{}
	var msgs []format.Message
	for i := range 4096 {
		msgs = append(msgs, benchMessage(b, counterBytes(fmt.Sprint("junk", i), streamLen)))
	}
	i := 0
	for b.Loop() {
		s.Process(msgs[i%len(msgs)], nil, nil, none, rounds.Round{ID: id.Round(i / 16)})
		i++
	}
}

// The same message tried as a compact notice only: what it cost before 8j.
func BenchmarkInboxJunkCompactOnly(b *testing.B) {
	k := benchKey(b)
	stream := counterBytes("junk", streamLen)
	for b.Loop() {
		if _, err := openCompact(k, newHalf(stream)); err == nil {
			b.Fatal("junk opened")
		}
	}
}

// A round with 32 junk messages and a quantum-safe notice among them, in a
// random order: the review measured 166 ms a round natively for this before
// pairing tags.
func BenchmarkInbox4FloodedRound(b *testing.B) {
	k := benchKey(b)
	none := receptionID.EphemeralIdentity{}
	round := 0
	for b.Loop() {
		b.StopTimer()
		round++
		s := newInboxSession(k, func(Notice) {})
		streams, err := newNoticeSealer(k.Address4, NoticeText, []byte("a message"), nil, nil, msgLen)
		if err != nil {
			b.Fatal(err)
		}
		halves, err := streams(uint32(round))
		if err != nil {
			b.Fatal(err)
		}
		var msgs []format.Message
		for i := range 32 {
			msgs = append(msgs, benchMessage(b, counterBytes(fmt.Sprint("junk", round, ".", i), streamLen)))
		}
		msgs = append(msgs, benchMessage(b, halves[0]), benchMessage(b, halves[1]))
		mrand.Shuffle(len(msgs), func(i, j int) { msgs[i], msgs[j] = msgs[j], msgs[i] })
		found := 0
		s.found = func(Notice) { found++ }
		b.StartTimer()
		for _, m := range msgs {
			s.Process(m, nil, nil, none, rounds.Round{ID: id.Round(round)})
		}
		if found != 1 {
			b.Fatalf("found %d notices", found)
		}
	}
}

func benchMessage(b *testing.B, stream []byte) format.Message {
	b.Helper()
	fp, mac, contents, err := splitStream(stream, msgLen)
	if err != nil {
		b.Fatal(err)
	}
	m := format.NewMessage(512)
	m.SetKeyFP(fp)
	m.SetMac(mac)
	m.SetContents(contents)
	return m
}
