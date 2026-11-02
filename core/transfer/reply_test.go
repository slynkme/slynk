package transfer

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
)

// Replies sealed with reply keys (reply.go).

// HPKE's PSK mode as reply.go and hpke.go write it out, against RFC 9180's
// test vector for this suite (appendix A.2.2: DHKEM(X25519, HKDF-SHA256),
// HKDF-SHA256, ChaCha20Poly1305, mode_psk), every value as the RFC prints
// it: the KEM's shared secret from both sides, the key schedule's context
// and secret, the key and nonce, and the first sealed message.
func TestReplyPSKVector(t *testing.T) {
	var (
		info    = mustDecode(t, "4f6465206f6e2061204772656369616e2055726e")
		skRm    = mustDecode(t, "77d114e0212be51cb1d76fa99dd41cfd4d0166b08caa09074430a6c59ef17879")
		skEm    = mustDecode(t, "0c35fdf49df7aa01cd330049332c40411ebba36e0c718ebc3edf5845795f6321")
		psk     = mustDecode(t, "0247fd33b913760fa1fa51e1892d9f307fbe65eb171e8132c2af18555a738b82")
		pskID   = mustDecode(t, "456e6e796e20447572696e206172616e204d6f726961")
		pkRm    = mustDecode(t, "13640af826b722fc04feaa4de2f28fbd5ecc03623b317834e7ff4120dbe73062")
		enc     = mustDecode(t, "2261299c3f40a9afc133b969a97f05e95be2c514e54f3de26cbe5644ac735b04")
		ss      = mustDecode(t, "4be079c5e77779d0215b3f689595d59e3e9b0455d55662d1f3666ec606e50ea7")
		context = mustDecode(t, "016870c4c76ca38ae43efbec0f2377d109499d7ce73f4a9e1ec37f21d3d063b97cb69c5718a60cc5876c358d3f7fc31ddb598503f67be58ea1e798c0bb19eb9796")
		secret  = mustDecode(t, "16974354c497c9bd24c000ceed693779b604f1944975b18c442d373663f4a8cc")
		key     = mustDecode(t, "600d2fdb0313a7e5c86a9ce9221cd95bed069862421744cfb4ab9d7203a9c019")
		nonce   = mustDecode(t, "112e0465562045b7368653e7")
		pt      = mustDecode(t, "4265617574792069732074727574682c20747275746820626561757479")
		aad     = mustDecode(t, "436f756e742d30")
		ct      = mustDecode(t, "4a177f9c0d6f15cfdf533fb65bf84aecdc6ab16b8b85b4cf65a370e07fc1d78d28fb073214525276f4a89608ff")
	)
	skR, err := ecdh.X25519().NewPrivateKey(skRm)
	if err != nil {
		t.Fatal(err)
	}
	skE, err := ecdh.X25519().NewPrivateKey(skEm)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(skR.PublicKey().Bytes(), pkRm) || !bytes.Equal(skE.PublicKey().Bytes(), enc) {
		t.Fatal("the vector's keys don't match")
	}
	// The sender's side, as sealReply works it out, and the recipient's, as
	// openReply does.
	for name, sides := range map[string][2]*ecdh.PrivateKey{"sender": {skE, skR}, "recipient": {skR, skE}} {
		dh, err := sides[0].ECDH(sides[1].PublicKey())
		if err != nil {
			t.Fatal(err)
		}
		got, err := dhkemSecret(dh, enc, pkRm)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, ss) {
			t.Fatalf("%s: shared secret %x, want %x", name, got, ss)
		}
	}
	pskIDHash, err := labeledExtract(dhkemSuite, nil, "psk_id_hash", pskID)
	if err != nil {
		t.Fatal(err)
	}
	infoHash, err := labeledExtract(dhkemSuite, nil, "info_hash", info)
	if err != nil {
		t.Fatal(err)
	}
	if got := slices.Concat([]byte{hpkeModePSK}, pskIDHash, infoHash); !bytes.Equal(got, context) {
		t.Fatalf("key schedule context %x, want %x", got, context)
	}
	if got, err := labeledExtract(dhkemSuite, ss, "secret", psk); err != nil || !bytes.Equal(got, secret) {
		t.Fatalf("secret %x, want %x (%v)", got, secret, err)
	}
	gotKey, gotNonce, err := hpkeKey(dhkemSuite, hpkeModePSK, ss, info, psk, pskID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotKey, key) || !bytes.Equal(gotNonce, nonce) {
		t.Fatalf("key %x and nonce %x, want %x and %x", gotKey, gotNonce, key, nonce)
	}
	aead, n, err := hpkeContext(dhkemSuite, hpkeModePSK, ss, info, psk, pskID)
	if err != nil {
		t.Fatal(err)
	}
	if sealed := aead.Seal(nil, n, pt, aad); !bytes.Equal(sealed, ct) {
		t.Fatalf("sealed %x, want %x", sealed, ct)
	}
	// RFC 9180's VerifyPSKInputs: both or neither, and only in PSK mode.
	for _, c := range []struct {
		mode       byte
		psk, pskID []byte
	}{
		{hpkeModePSK, nil, nil},
		{hpkeModePSK, psk, nil},
		{hpkeModePSK, nil, pskID},
		{hpkeModeBase, psk, pskID},
		{hpkeModeBase, psk, nil},
	} {
		if _, _, err := hpkeKey(dhkemSuite, c.mode, ss, info, c.psk, c.pskID); err == nil {
			t.Errorf("mode %d with a PSK of %d bytes and an ID of %d: no error", c.mode, len(c.psk), len(c.pskID))
		}
	}
}

// DHKEM(X25519) and HPKE's base mode as hpke.go writes them out match Go's
// crypto/hpke both ways round, for the suite compact notices use: what one
// seals, the other opens.
func TestDHKEMMatchesHPKE(t *testing.T) {
	k := testKey(t, 1)
	pkR := k.Address.xpub
	skR, err := hpke.NewDHKEMPrivateKey(k.xpriv)
	if err != nil {
		t.Fatal(err)
	}
	pk, err := hpke.NewDHKEMPublicKey(pkR)
	if err != nil {
		t.Fatal(err)
	}
	info := []byte(inboxNoticeInfo)
	for i := range 50 {
		pt := []byte(strings.Repeat("x", i))
		aad := []byte{byte(i)}

		// Written out here, opened by crypto/hpke.
		skE, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		dh, err := skE.ECDH(pkR)
		if err != nil {
			t.Fatal(err)
		}
		ss, err := dhkemSecret(dh, skE.PublicKey().Bytes(), pkR.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		aead, nonce, err := hpkeContext(dhkemSuite, hpkeModeBase, ss, info, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		r, err := hpke.NewRecipient(skE.PublicKey().Bytes(), skR, noticeKDF, noticeAEAD, info)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := r.Open(aad, aead.Seal(nil, nonce, pt, aad)); err != nil || !bytes.Equal(got, pt) {
			t.Fatalf("crypto/hpke didn't open it: %v", err)
		}

		// Sealed by crypto/hpke, opened here.
		enc, s, err := hpke.NewSender(pk, noticeKDF, noticeAEAD, info)
		if err != nil {
			t.Fatal(err)
		}
		sealed, err := s.Seal(aad, pt)
		if err != nil {
			t.Fatal(err)
		}
		pubE, err := ecdh.X25519().NewPublicKey(enc)
		if err != nil {
			t.Fatal(err)
		}
		dh, err = k.xpriv.ECDH(pubE)
		if err != nil {
			t.Fatal(err)
		}
		ss, err = dhkemSecret(dh, enc, pkR.Bytes())
		if err != nil {
			t.Fatal(err)
		}
		aead, nonce, err = hpkeContext(dhkemSuite, hpkeModeBase, ss, info, nil, nil)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := aead.Open(nil, nonce, sealed, aad); err != nil || !bytes.Equal(got, pt) {
			t.Fatalf("didn't open what crypto/hpke sealed: %v", err)
		}
	}
}

// An inbox's reply keys come from its words and must never change: a kept
// inbox holds the keys others gave it, and replies on their way were sealed
// with them. They differ for every pair of inboxes and from everything else
// the words give, and either address of the recipient gives the same.
func TestReplyKeysGolden(t *testing.T) {
	a, b := goldenKey(t), testKey(t, 2)
	const (
		goldenToken = "0f8abf8dde7abd62"
		goldenKey   = "961ad748e1e0c38e5ea905ed171e2a277e5f0bc5bc753de0771c22434aad6a14"
	)
	r, err := a.replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(r.Token[:]) != goldenToken || hex.EncodeToString(r.Key[:]) != goldenKey {
		t.Errorf("reply keys %x %x, want %s %s", r.Token, r.Key, goldenToken, goldenKey)
	}
	if r4, err := a.replyKeysFor(b.Address4); err != nil || *r4 != *r {
		t.Error("the recipient's quantum-safe address gives other reply keys")
	}
	if k, err := a.replyKey(r.Token); err != nil || k != r.Key {
		t.Error("the token doesn't name the key")
	}
	c, err := a.replyKeysFor(testKey(t, 3).Address)
	if err != nil {
		t.Fatal(err)
	}
	other, err := testKey(t, 4).replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	if c.Token == r.Token || c.Key == r.Key || other.Token == r.Token || other.Key == r.Key {
		t.Error("two pairs of inboxes share reply keys")
	}
	for _, x := range [][]byte{a.StoreSecret(), a.Address.pub, a.Address4.Bytes()} {
		if bytes.Contains(x, r.Key[:8]) || bytes.Contains(x, r.Token[:]) {
			t.Error("the reply keys overlap another of the inbox's values")
		}
	}
	got, err := ParseReplyKeys(r.Bytes())
	if err != nil || *got != *r || len(r.Bytes()) != ReplyKeysLen {
		t.Fatalf("reply keys don't round-trip: %v", err)
	}
	for _, n := range []int{0, ReplyKeysLen - 1, ReplyKeysLen + 1} {
		if _, err := ParseReplyKeys(make([]byte, n)); err != ErrReplyKeys {
			t.Errorf("%d bytes: %v", n, err)
		}
	}
	// A key of zeros is what a wiped buffer holds, never a real key: refused, so it can't go
	// out unnoticed (the reviews' finding: a file notice once could).
	wiped := r.Bytes()
	clear(wiped[ReplyTokenLen:])
	if _, err := ParseReplyKeys(wiped); err != ErrReplyKeys {
		t.Errorf("a key of zeros: %v", err)
	}
	if _, err := ParseReplyKeys(make([]byte, ReplyKeysLen)); err != ErrReplyKeys {
		t.Errorf("all zeros: %v", err)
	}
}

// openAny opens one message's stream as Process does, before pairing: as a
// compact notice, then as a reply.
func openAny(key *InboxKey, stream []byte) (opened, error) {
	m := newHalf(stream)
	if o, err := openCompact(key, m); err == nil {
		return o, nil
	}
	return openReply(key, m)
}

// A conversation that starts with a quantum-safe notice: each side's message
// carries their reply keys for the other, and every reply sealed with them
// opens, one message each, quantum-safe, with the sender proved.
func TestReplyRoundTrip(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	link := append([]byte{linkVersion1}, bytes.Repeat([]byte{9}, linkLen-1)...)

	// a writes to b's quantum-safe address, and lets b reply.
	first, err := open(b, seal(t, b.Address4, NoticeText, []byte("hello"), &From{Key: a, Name: "Sam"}, 7))
	if err != nil {
		t.Fatal(err)
	}
	if first.replyKeys == nil || first.reply || !first.quantum {
		t.Fatalf("the first notice: %+v", first)
	}
	aKeys := first.replyKeys // what a gave b

	for _, c := range []struct {
		kind byte
		body []byte
		want string
	}{
		{NoticeText, []byte("hi back"), "hi back"},
		{NoticeText | NoticeDeflate, deflated(t, "packed"), "packed"},
		{NoticeLink, link, string(link)},
		{NoticeText, nil, ""},
	} {
		// b replies to a's compact address, with a's keys: one message.
		for _, to := range []*InboxAddress{a.Address, a.Address4} {
			streams := sealerReply(t, to, c.kind, c.body, &From{Key: b, Name: "Kim"}, aKeys)(8)
			if len(streams) != 1 || len(streams[0]) != streamLen {
				t.Fatalf("a reply filled %d messages", len(streams))
			}
			o, err := openAny(a, streams[0])
			if err != nil {
				t.Fatalf("a didn't open b's reply: %v", err)
			}
			wantB, err := b.replyKeysFor(a.Address)
			if err != nil {
				t.Fatal(err)
			}
			if !o.reply || !o.quantum || o.from == nil || !bytes.Equal(o.from.Bytes(), b.Address.Bytes()) || o.name != "Kim" ||
				o.kind != c.kind&^NoticeDeflate || string(o.body) != c.want || o.round != 8 || o.replyKeys == nil || *o.replyKeys != *wantB {
				t.Fatalf("b's reply opened as %+v", o)
			}
			// Nobody else opens it: not b, nor another inbox.
			if _, err := openAny(b, streams[0]); err == nil {
				t.Fatal("the sender opened their own reply")
			}
			if _, err := openAny(testKey(t, 3), streams[0]); err == nil {
				t.Fatal("another inbox opened a reply")
			}

			// And a answers b the same way, with the keys b just gave.
			back := sealerReply(t, b.Address, NoticeText, []byte("and again"), &From{Key: a}, o.replyKeys)(9)
			o2, err := openAny(b, back[0])
			if err != nil || !o2.reply || string(o2.body) != "and again" || !bytes.Equal(o2.from.Bytes(), a.Address.Bytes()) || *o2.replyKeys != *aKeys {
				t.Fatalf("b didn't open a's answer: %+v %v", o2, err)
			}
		}
	}
}

// sealerReply seals as a reply with the keys the recipient gave, failing the
// test if it's refused, giving a function of the round.
func sealerReply(t *testing.T, to *InboxAddress, kind byte, body []byte, from *From, keys *ReplyKeys) func(uint32) [][]byte {
	t.Helper()
	s, err := newNoticeSealer(to, kind, body, from, keys, msgLen)
	if err != nil {
		t.Fatal(err)
	}
	return func(round uint32) [][]byte {
		t.Helper()
		streams, err := s(round)
		if err != nil {
			t.Fatal(err)
		}
		return streams
	}
}

// A notice goes in as many messages as its seal fills, to the inbox's
// mailbox: a reply in one, whichever address of the inbox it's sent to.
func TestNoticeJobPieces(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	keys, err := a.replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		to     *InboxAddress
		from   *From
		reply  *ReplyKeys
		pieces int
	}{
		{a.Address, nil, nil, 1},
		{a.Address4, nil, nil, 2},
		{a.Address4, &From{Key: b}, nil, 2},
		{a.Address, &From{Key: b}, keys, 1},
		{a.Address4, &From{Key: b}, keys, 1},
	} {
		for _, apart := range []bool{false, true} {
			job, err := newNoticeJob(c.to, NoticeText, []byte("hi"), c.from, c.reply, msgLen, apart)
			if err != nil {
				t.Fatal(err)
			}
			streams, err := job.seal(1)
			if err != nil {
				t.Fatal(err)
			}
			if job.pieces != c.pieces || len(streams) != c.pieces || !job.recipient.Cmp(a.Address.mailbox) {
				t.Errorf("to %d bytes, reply %v: %d pieces, sealed %d", len(c.to.Bytes()), c.reply != nil, job.pieces, len(streams))
			}
			// Only a notice of two messages is ever sent apart.
			if (job.apart != nil) != (apart && c.pieces == 2) {
				t.Errorf("to %d bytes, reply %v, apart %v: sent apart %v", len(c.to.Bytes()), c.reply != nil, apart, job.apart != nil)
			}
		}
	}
}

// What a notice can carry, with and without reply keys: a reply has room for
// 916 bytes, less the sender's inbox and their reply keys.
func TestReplySizes(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	keys, err := a.replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	if MaxReplyBody(msgLen) != 916 || modeReply.plaintextLen(streamLen) != 932 || modeReply.pieces() != 1 {
		t.Fatalf("a reply holds %d bytes", MaxReplyBody(msgLen))
	}
	for name, c := range map[string]struct {
		to    *InboxAddress
		reply *ReplyKeys
		room  int
	}{
		"compact":      {a.Address, nil, 924 - 66},
		"quantum-safe": {a.Address4, nil, 652 - 66 - 40},
		"reply":        {a.Address, keys, 916 - 66 - 40},
	} {
		from := &From{Key: b}
		if got := modeOf(c.to, c.reply).maxBody(msgLen) - modeOf(c.to, c.reply).fromOverhead(0); got != c.room {
			t.Errorf("%s: room %d, want %d", name, got, c.room)
		}
		if _, err := newNoticeSealer(c.to, NoticeText, make([]byte, c.room), from, c.reply, msgLen); err != nil {
			t.Errorf("%s: %d bytes didn't fit: %v", name, c.room, err)
		}
		if _, err := newNoticeSealer(c.to, NoticeText, make([]byte, c.room+1), from, c.reply, msgLen); err != ErrNoticeSize {
			t.Errorf("%s: %d bytes: %v", name, c.room+1, err)
		}
	}
}

// What can't be sealed or opened as a reply: no sender, the wrong key, a
// token given to another inbox, another inbox's mailbox key, any byte
// changed; and reply keys anywhere they can't be.
func TestReplyRejects(t *testing.T) {
	a, b, c := testKey(t, 1), testKey(t, 2), testKey(t, 3)
	aKeys, err := a.replyKeysFor(b.Address) // what a gave b
	if err != nil {
		t.Fatal(err)
	}

	// A notice without its sender's inbox never uses reply keys: the token
	// would say who sent it.
	if _, err := newNoticeSealer(a.Address, NoticeText, []byte("hi"), nil, aKeys, msgLen); err != ErrReplyKeys {
		t.Fatalf("an anonymous reply: %v", err)
	}

	good := sealerReply(t, a.Address, NoticeText, []byte("hi"), &From{Key: b}, aKeys)(1)[0]
	if _, err := openAny(a, good); err != nil {
		t.Fatal(err)
	}

	// The right token with the wrong key, and a key for another token.
	wrongKey := *aKeys
	wrongKey.Key[0] ^= 1
	wrongToken := *aKeys
	wrongToken.Token[0] ^= 1
	for name, keys := range map[string]*ReplyKeys{"wrong key": &wrongKey, "wrong token": &wrongToken} {
		s := sealerReply(t, a.Address, NoticeText, []byte("hi"), &From{Key: b}, keys)(1)[0]
		if _, err := openAny(a, s); err == nil {
			t.Errorf("%s: opened", name)
		}
	}

	// Keys a gave c, used by b: they open, but the token isn't b's.
	cKeys, err := a.replyKeysFor(c.Address)
	if err != nil {
		t.Fatal(err)
	}
	borrowed := sealerReply(t, a.Address, NoticeText, []byte("hi"), &From{Key: b}, cKeys)(1)[0]
	if _, err := openAny(a, borrowed); err == nil || !strings.Contains(err.Error(), "another inbox") {
		t.Errorf("a reply with another sender's keys: %v", err)
	}
	// c itself may use them.
	if _, err := openAny(a, sealerReply(t, a.Address, NoticeText, []byte("hi"), &From{Key: c}, cKeys)(1)[0]); err != nil {
		t.Errorf("c's own keys: %v", err)
	}

	// Sealed to another inbox with a's keys: neither opens it.
	misdirected := sealerReply(t, c.Address, NoticeText, []byte("hi"), &From{Key: b}, aKeys)(1)[0]
	for _, k := range []*InboxKey{a, c} {
		if _, err := openAny(k, misdirected); err == nil {
			t.Error("a reply sealed to another inbox opened")
		}
	}

	// Any byte changed: the key, the hidden token, the sealed part, its tag.
	for _, i := range []int{0, keyRepLen - 1, keyRepLen, keyRepLen + ReplyTokenLen - 1, keyRepLen + ReplyTokenLen, streamLen / 2, streamLen - 1} {
		bad := bytes.Clone(good)
		bad[i] ^= 1
		if _, err := openAny(a, bad); err == nil {
			t.Errorf("byte %d changed: opened", i)
		}
	}

	// Handmade plaintexts, sealed properly, that a sender could only make on
	// purpose.
	proved := func(to *InboxAddress, kind byte, keys []byte, body []byte) ([]byte, int) {
		pt := make([]byte, streamLen-replyOverhead)
		full := FromOverhead(0) + len(keys) + len(body)
		pt[0], pt[1] = noticeVersion, kind
		binary.BigEndian.PutUint16(pt[2:4], uint16(full))
		binary.BigEndian.PutUint32(pt[4:8], 1)
		at := noticeHeaderLen + copy(pt[noticeHeaderLen:], b.Address.Bytes())
		proofAt := at + 1
		copy(pt[proofAt+fromProofLen:], keys)
		copy(pt[proofAt+fromProofLen+len(keys):], body)
		return pt, proofAt
	}
	fromKeyBA := mustFromKey(t, b, a.Address, b.Address, a.Address)
	bKeys, err := b.replyKeysFor(a.Address)
	if err != nil {
		t.Fatal(err)
	}
	sealAs := func(mode sealMode, pt []byte, proofAt int) []byte {
		prove := func(aad []byte) {
			if proofAt > 0 {
				end := noticeHeaderLen + int(binary.BigEndian.Uint16(pt[2:4]))
				copy(pt[proofAt:], fromProof(fromKeyBA, aad, pt, proofAt, end))
			}
		}
		var s []byte
		var err error
		if mode == modeReply {
			s, err = sealReply(a.Address, aKeys, pt, prove)
		} else {
			s, err = sealPlaintext(a.Address, pt, prove)
		}
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	// The handmade reply that's right opens, so the ones below fail for
	// what they change.
	pt, proofAt := proved(a.Address, NoticeText|noticeFrom|noticeReplyKeys, bKeys.Bytes(), []byte("hi"))
	if o, err := openAny(a, sealAs(modeReply, pt, proofAt)); err != nil || *o.replyKeys != *bKeys {
		t.Fatalf("the handmade reply: %v", err)
	}
	// A reply that doesn't say who sent it.
	anon := make([]byte, streamLen-replyOverhead)
	anon[0], anon[1] = noticeVersion, NoticeText
	binary.BigEndian.PutUint16(anon[2:4], 2)
	binary.BigEndian.PutUint32(anon[4:8], 1)
	copy(anon[noticeHeaderLen:], "hi")
	if _, err := openAny(a, sealAs(modeReply, anon, 0)); err == nil {
		t.Error("a reply without its sender's inbox opened")
	}
	// Reply keys with no sender's inbox, in a reply.
	anonKeys := bytes.Clone(anon)
	anonKeys[1] = NoticeText | noticeReplyKeys
	if _, err := openAny(a, sealAs(modeReply, anonKeys, 0)); err == nil {
		t.Error("reply keys without a sender opened")
	}
	// Reply keys in a compact notice, which can't keep them from someone
	// who breaks X25519.
	compactPT := make([]byte, streamLen-hpkeOverhead)
	copy(compactPT, pt)
	if _, err := openAny(a, sealAs(modeCompact, compactPT, proofAt)); err == nil {
		t.Error("reply keys in a compact notice opened")
	}
	// Reply keys cut short.
	short, shortAt := proved(a.Address, NoticeText|noticeFrom|noticeReplyKeys, nil, bytes.Repeat([]byte{'k'}, ReplyKeysLen-1))
	if _, err := openAny(a, sealAs(modeReply, short, shortAt)); err == nil || !strings.Contains(err.Error(), "reply keys") {
		t.Errorf("reply keys cut short: %v", err)
	}
	// A compact notice doesn't open as a reply, nor a reply as a compact notice.
	plain := seal(t, a.Address, NoticeText, []byte("hi"), &From{Key: b}, 1)[0]
	if _, err := openReply(a, newHalf(plain)); err == nil {
		t.Error("a compact notice opened as a reply")
	}
	if _, err := openCompact(a, newHalf(good)); err == nil {
		t.Error("a reply opened as a compact notice")
	}
}

// Every byte of a reply looks random: the hidden token as much as the rest,
// and the same token hides differently every time.
//
// Each run seals fresh replies, so the bound leaves a correct seal only a tiny
// chance of failing by bad luck: chi-squared with 255 degrees of freedom tops
// 403 with probability 10^-8 (simulated 40 million times over 8,000 draws,
// this statistic matched its tail within about 10% down to 10^-6), so the 10
// bytes fail by chance about once in 10 million runs. Its first bound, 340
// over 4,000 replies, failed about once in 330 runs; over 8,000, any bias
// that bound caught at least one time in five, this one catches at least as
// often. A fixed seed wouldn't fix that, only hide it (see
// TestKemeleonLooksRandom).
func TestReplyLooksRandom(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	keys, err := a.replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	s, err := newNoticeSealer(a.Address, NoticeText, []byte("hi"), &From{Key: b}, keys, msgLen)
	if err != nil {
		t.Fatal(err)
	}
	// Sealing is nearly all the time, so it's spread over the CPUs.
	const n = 8000
	streams := make([][]byte, n)
	workers := runtime.GOMAXPROCS(0)
	errs := make([]error, workers)
	var wg sync.WaitGroup
	for w := range workers {
		wg.Go(func() {
			for i := w; i < n && errs[w] == nil; i += workers {
				var sealed [][]byte
				sealed, errs[w] = s(1)
				if errs[w] == nil {
					streams[i] = sealed[0]
				}
			}
		})
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var counts [ReplyTokenLen + 2][256]int
	seen := map[string]bool{}
	for _, stream := range streams {
		hidden := stream[keyRepLen : keyRepLen+ReplyTokenLen]
		if seen[string(hidden)] || subtle.ConstantTimeCompare(hidden, keys.Token[:]) == 1 {
			t.Fatal("a token hid the same way twice, or not at all")
		}
		seen[string(hidden)] = true
		for i, v := range hidden {
			counts[i][v]++
		}
		counts[ReplyTokenLen][stream[keyRepLen-1]]++
		counts[ReplyTokenLen+1][stream[keyRepLen+ReplyTokenLen]]++
	}
	for i, c := range counts {
		chi := 0.0
		for _, v := range c {
			d := float64(v) - n/256.0
			chi += d * d / (n / 256.0)
		}
		if chi > 403 {
			t.Errorf("byte %d: chi-squared %.0f", i, chi)
		}
	}
}

// An inbox finds a reply as it finds any notice: once, quantum-safe, from its
// sender, with their reply keys, and never holds it for pairing.
func TestInboxSessionReply(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	aKeys, err := a.replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	var got []Notice
	s := testSession(a, func(n Notice) { got = append(got, n) })
	none := receptionID.EphemeralIdentity{}
	streams := sealerReply(t, a.Address, NoticeText, []byte("a reply"), &From{Key: b, Name: "Kim"}, aKeys)(5)
	for range 2 { // a second copy of the same try shows once
		s.Process(cmixMessage(t, streams[0]), nil, nil, none, roundAt(5, testSent.Add(time.Second)))
	}
	// And one sealed for round 5 but found in round 6: a copy someone sent again.
	s.Process(cmixMessage(t, streams[0]), nil, nil, none, roundAt(6, testSent.Add(2*time.Second)))
	bKeys, err := b.replyKeysFor(a.Address)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("found %d notices", len(got))
	}
	if n := got[0]; !n.Reply || !n.QuantumSafe || string(n.Body) != "a reply" || n.FromName != "Kim" ||
		!bytes.Equal(n.From.Bytes(), b.Address.Bytes()) || n.ReplyKeys == nil || *n.ReplyKeys != *bKeys || n.Round != 5 {
		t.Fatalf("found %+v", n)
	}
	if s.pairs.held != 0 || s.Others() != 0 || s.Copies() != 1 {
		t.Fatalf("held %d, others %d, copies %d", s.pairs.held, s.Others(), s.Copies())
	}
	// A reply that opens but is refused (a token given to another inbox) is counted as someone
	// else's and never held for pairing: having opened, it's no half of a quantum-safe notice.
	c := testKey(t, 3)
	cKeys, err := a.replyKeysFor(c.Address)
	if err != nil {
		t.Fatal(err)
	}
	borrowed := sealerReply(t, a.Address, NoticeText, []byte("borrowed"), &From{Key: b}, cKeys)(8)
	s.Process(cmixMessage(t, borrowed[0]), nil, nil, none, roundAt(8, testSent.Add(4*time.Second)))
	if len(got) != 1 || s.pairs.held != 0 || s.Others() != 1 {
		t.Fatalf("a refused reply: found %d, held %d, others %d", len(got), s.pairs.held, s.Others())
	}
	// A quantum-safe notice including its sender's inbox passes their reply
	// keys on, as Notice.ReplyKeys.
	got = nil
	for _, m := range seal(t, a.Address4, NoticeText, []byte("first"), &From{Key: b}, 7) {
		s.Process(cmixMessage(t, m), nil, nil, none, roundAt(7, testSent.Add(3*time.Second)))
	}
	if len(got) != 1 || got[0].Reply || !got[0].QuantumSafe || got[0].ReplyKeys == nil || *got[0].ReplyKeys != *bKeys {
		t.Fatalf("the quantum-safe notice: %+v", got)
	}
}

// Notices sealed by this build: they must keep opening the same way. They
// pin the reply's key schedule, info string, token, pad and layout, and the
// reply keys' place in a quantum-safe notice.
func TestReplyKnownNotice(t *testing.T) {
	golden, b := goldenKey(t), testKey(t, 2)
	bKeys, err := b.replyKeysFor(golden.Address)
	if err != nil {
		t.Fatal(err)
	}
	goldenKeys, err := golden.replyKeysFor(b.Address)
	if err != nil {
		t.Fatal(err)
	}
	// From the golden inbox to b's quantum-safe address, with its reply keys.
	raw := mustDecode(t, knownReplyKeysNotice4)
	o, err := open(b, [][]byte{raw[:streamLen], raw[streamLen:]})
	if err != nil {
		t.Fatal(err)
	}
	if string(o.body) != "Known-answer test: a quantum-safe message with reply keys." || o.name != "Sam" || o.round != knownRound ||
		!o.quantum || o.reply || !bytes.Equal(o.from.Bytes(), golden.Address.Bytes()) || *o.replyKeys != *goldenKeys {
		t.Fatalf("the quantum-safe notice: %+v", o)
	}
	// b's reply to the golden inbox's compact address, with those keys.
	o, err = openAny(golden, mustDecode(t, knownReplyNotice))
	if err != nil {
		t.Fatal(err)
	}
	if string(o.body) != "Known-answer test: a reply sealed with reply keys." || o.name != "Kim" || o.round != knownRound ||
		!o.quantum || !o.reply || !bytes.Equal(o.from.Bytes(), b.Address.Bytes()) || *o.replyKeys != *bKeys {
		t.Fatalf("the reply: %+v", o)
	}
}

// knownReplyKeysNotice4 was sealed by the golden inbox ("abandon" x11,
// "about"), named "Sam", to testKey(2)'s quantum-safe address, and
// knownReplyNotice by testKey(2), named "Kim", to the golden inbox's compact
// address with the reply keys that notice gave, both for knownRound, on
// 2026-10-18.
const (
	knownReplyKeysNotice4 = "314c74f6d524509cc6f1116f2807065089124729a888c56c05cde9125b8181d9" +
		"5da63e1da91dab53c25e0bb1e05b7b4fd686bdc81b6b29a453120de79488e159" +
		"a31c29b255237226321ead7fe44494eb1eff6b9f04e9556d16f438272882e2c0" +
		"bd81b50f4061523b0323de0c751e32d65738a4f93c7384a15fe9270b8b49ca05" +
		"0c5e6d710e3cc6c66f7d51341d97dd53babdbc2074c7a46ef235f5c2ea68c796" +
		"58e3d9764e5c9543514777ae7c8868505465f9f9a135b2231eb252c00ba06d72" +
		"408071e8da55a6ebd626474d0427fec9d9380f870b53425970fdf77a5c2f26fc" +
		"f85e94fc0556a73d540297139bac700d9817a4afea9708c4cf2db6a7ffa4fafc" +
		"943a2fda9b5b3aff581bb531ddb2a987d24d8600d41280b955733fb7930d7063" +
		"aabfe7f00697b0b88b76267635b5d72a9496a6eb7d21d4a3d0a25021aff6c7f6" +
		"9a6a75ac2482237c455c3fb525dd3895903672573c5e6c1b1749e8b9d4998ff5" +
		"5c7a765b6ff30bbb05e1c1bb64365657237b06c4fb8d971d57033ba196fde2a0" +
		"250a49780335bdf6c836a319ea6a31c72d5c517a286182631277a26f39eb7971" +
		"e2b84f20e6f504d18541d99bc295195d92e7d890ca29a9e9bf3334ccc40da668" +
		"a74020c64db3e39010e6b0d8f6a3c187305a7a4128dae138b8f7ebd9d3d7f983" +
		"bb9bb7aa205ab5a11d56908a23b12f2a52ab022ed0b9ca100ad8e0691cb6bb02" +
		"9c6db7941e048bb3707971dad88ce092b28f8595e3df0bea251f0cc56cbc1733" +
		"408b7ab3daf1b92b193e6b296c3dc19da6eef6bef4ea7f75d52fc81d6df3fb7e" +
		"bff6820fd3eaa8a5c219a78ccbb51ed215d81f7267db8b404b433abd9f715e6a" +
		"4d00898da2dbc520479e31f4236b2fdcc0c0cc1ffc99d2683f2d6576734d4666" +
		"3821e7e1f45bfcffe837e2cae6cb9c370f52eb8c2554b605e856f4da9bdbe732" +
		"8a35093731795a0ba85ee41c2c2e32dc1ed4121b86994185e3f3a7a5ab8a0aa1" +
		"f3a9511cdf8ba6cfd5ab7f840a616d57847816ab54f8fc10d3daf9d41113a25b" +
		"d87a5786862975442bac4b7f5e803a83cc223535dcb2d751b84b7ff457235efd" +
		"560a58ab1219bbeb59785dc4731dc4db02bb601c32834a92f729b4427669daad" +
		"a37535a8fc32b64bc13ca9507f9a18dc37ad6a1e96cfa4db972cf258c98f0c50" +
		"99dacfc7224e611638594f99dedf45f88ce44d123b3ec2db9e355377f23b4df2" +
		"b1c7640f60b771761a9f15a724f2201f4be85ecca98a209f17931b2af33f3dbe" +
		"8419e0a1c4eb5ba19b45fefbefb42d952442818e6484bd885028e158c21f696a" +
		"3a96dd4b0747219e4491057ab7cef31a37c25257aa960832d96f73108ddfca69" +
		"79892e447a254eaad237ade6d81aa5524050d181194d5eaad61c23917d888f96" +
		"aa2c0fed27e5bb48536a36b8cf0b905039e27a233ab856340191d500c56203a4" +
		"8c69d9122885e6fb94f2362c27958b37e1a1627907a8267647c59e81b0498372" +
		"f3fe84b83597cdfe973693a06df61c46206002f4dca5e8cad7f1cb0b37e67b2a" +
		"5417100d008229bc5f6fb97a0b3c96e5ddec1930164a0298909196c6ba90ae18" +
		"6333fd5e1244dfad2238c7abc4de19709b73f7df2f182063effbdc01d621e054" +
		"1ea0d4bec858eb096c2bbf9e55c163cd6ffb60f2c73e73d1074ada2e7fae642f" +
		"16aa88543ed37735645b55c94f8358fa91ea78b92a05fa189fbca31fe845feae" +
		"16e466ab549c00a968b060f3f94f8c7714c67c66551d3e577710906e7e6919dd" +
		"622871dbd9b667cc25759fbef2c33536592bd51eba4383970f51548516e49b3b" +
		"2305bee45bc9fbf17d49a96a064710ff7d65188fffbc98cffafc8acc71673d4b" +
		"35a98fda7c78c0e56e847499b0254b731b6f10fbdfe13586a2b968273e7d2c34" +
		"bc2f4962ec7a9f06f06545083a5d9cafe4d155de64f286a3de6aa88a2b0145df" +
		"8267d1cc8bcb05c969b1bcc625f8caa6c5c08c14b990d214682193285149c8d6" +
		"7230707464e402eb9160be68d36e4b4234f4f1404de55a3b217d674235c5f8db" +
		"e88e6b292b775fea73bbfbca0674179c8d36320ffdc7be495fbbfcde8255f7f6" +
		"9fe7587be46741d5a2d7e8c4c399b06dfd9d6bbdd4d1e65494471ac0b803306c" +
		"a04e6f4b4528fcae7af60aebfc71eb65070be69a782eac2569e225b608203016" +
		"ea66ca9f98393cc494cf29fe1008a1d212a997c12afc6206454da0bc65057c01" +
		"cbbade11d2e61536e143f42db4795a3a03a1077fbae0357a24820157c4fbabf5" +
		"c3826dd94b0f67ed1b7e0ab606fe1913852651fd678c3c80ea9dc0eb7511bd23" +
		"dc38faa89c00300765556710c820e3975f0ea8795a9dde851bbc53858b5f649b" +
		"9f1be91b4d8508f7fb670199d3dc6800bc0ea37a5c60ea846bec6e87be88cd75" +
		"58dc6dbb32a9e0fba4bdbb894c645c41c7b02c3da809c11d37a4383ebed408ba" +
		"b27b5b08d98df3ba2a84cb662a5585d2c646a6099bbc13ba1c96415d70ae2aad" +
		"242692730e0fa9d7b177e31d18d974be060bf331ff14b4d8e1a4e93c18d8c60c" +
		"1e0e30d57ba83c0af713529382be6ba3c9b52414c077bb507ba5779bf2d53392" +
		"9a26ca87901bd605f72a1d195836c0c07bc97c723f975ce8926488e24b0906ea" +
		"24eaa5feecea1faa4f208bc84a2c539e6c22456c130e541d6be7e17aa41a2bdd" +
		"d600c12770eb0da4c91feaaceb086c69031b8c9884f222132c7b249f0d04ceb0" +
		"322ac42278c87ca1cff171be0e87d1fb791ebe64454ae6b0409c72e94905080a" +
		"fb870e4c724ba11da6653a15c7644cc3ca94911c179493e0"
	knownReplyNotice = "29d76aae05b5a91f73e15ed8230ef10b9d67f8ba329d47b79965470428f14860" +
		"04375082dc4f8e71b6b4e448d47bb73e788a800c44d865d4f855c40ddbf83e17" +
		"bad552b2827f266e4c9f7274dcf8f5559a700e3afe2c473c195a3e6e2e3f7cbf" +
		"70eb8640aa1d140cd0475810e075dbfa3cb29c2e8eb2ae50b7c66c9152f59d12" +
		"a4d459f398450f960ef5fadd104a678194bbb84af34711ed9b6ffbb6df313bcc" +
		"252c5aafa98bdcbbe3bb3e326eef0e7fae238ebe2584a54a179816b3cc177a49" +
		"7fcb4d3206ebfc572209c789eaed781e3c8daf46a350f0ca98c00a5d3a0c3169" +
		"692ac6caa7798b9168c003da886aebc49f4e7826a9ef36cf38805912ebb9511e" +
		"5f366c85164532cb8da09f192a590789e8aff18937eda22ade8ae37f2983bec8" +
		"b602847d6fedf937e069e6f074051a1b92c68a0e13241f9c5c4b94ff465ffa19" +
		"928d21919854c4d5dafc945bd99e206556e4037903a3792d960143a2447947a8" +
		"1e3716cd569998bd68c85743aa3cce73abfbe3ad6b624214c1fff852de9e0992" +
		"6ded5d1053161e0809761d0c9a1b3afe9ad7f2da91288c8cf47cd4f5f564d86f" +
		"bac7a1d2a6b9200d6c9a3d3a8599e1eb6bfab33c7baa57c0846437d936864ae0" +
		"f2062f95a5785781c7d487bdbfccfa909f1357066e00234911fe3dab3f5fd227" +
		"be0a678bb7261cc37d604a3218207254b7280e9c46950327d713546dc02dd5be" +
		"f2b263f4a44e66333839b33c7ef405c5dc05f1e32709d0f1be330c815148c564" +
		"f897722a3ae9d31809f145df16ada51aaeb28a8969637dae3a788b7d43ec5ea5" +
		"bd1113a908e0cf1903a5ba436c294be0e594a4199c30d2c28d3575ac48ff59dd" +
		"0c8b21bcd99d87db190e1f7d3f76608b9b3b7d4abfcd6fe536d8a26b6b6d9480" +
		"60ee0bd33ee002b855b9f884e6246d8c597306e92b41d8ad46483ffe80e384d6" +
		"9cf8dccdcfb55f63977fb0bc788b4f52e5bd2c0aec59a3222f3c05880c8f1a5f" +
		"7c9d1c2b62cc9c215319379b890159c4b9ba00adaecea6531dd66a847feef12c" +
		"68067be1bb1ffba652f193a549b29bc6593767a571989be5f52a6245b0d9f2e3" +
		"9472f2e2bbbb3ce1e0a504df1b4cefbf1be697ca7615c5038b48eae993c71455" +
		"25a75ecb1eca19017ae5f09e7add8d5d286c13a6df9256da0b95e844dfcad469" +
		"7b1e09a90f693c4e653feec2f0d031e9ab760eab9150c553bbde5d76db90af02" +
		"1dbe6d7421c782097ca81fae6bc4e050decda7d8a9269301a1e0b45e3725c758" +
		"c86b9cfbdf3d04687ff1bf60cf5927e87669b0657325a7ab9177c4b72be40f8d" +
		"304a151ae5ac59595921c75e7b50232dbf143bd2970825d94c14ae0a65838e40" +
		"4d79d9d86a01e20136fc2d7da2bb28b8c436e9e3562263188cbc81f3"
)
