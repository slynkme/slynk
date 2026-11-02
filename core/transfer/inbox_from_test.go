package transfer

import (
	"bytes"
	"crypto/hpke"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
)

// Replies between inboxes: a sender may include their own
// inbox, proved with a key only the two inboxes can work out.

// plainFrom builds a compact notice's plaintext claiming from, with name and
// body, and seals it to to for round 1, its proof made with proofKey (the
// right one, or not).
func plainFrom(t *testing.T, to, from *InboxAddress, proofKey []byte, kind byte, name, body []byte) []byte {
	t.Helper()
	pt := make([]byte, streamLen-hpkeOverhead)
	full := FromOverhead(len(name)) + len(body)
	pt[0], pt[1] = noticeVersion, kind|noticeFrom
	binary.BigEndian.PutUint16(pt[2:4], uint16(full))
	binary.BigEndian.PutUint32(pt[4:8], 1)
	at := noticeHeaderLen + copy(pt[noticeHeaderLen:], from.Bytes())
	pt[at] = byte(len(name))
	proofAt := at + 1 + copy(pt[at+1:], name)
	copy(pt[proofAt+fromProofLen:], body)
	sealed, err := sealPlaintext(to, pt, func(rep []byte) {
		copy(pt[proofAt:], fromProof(proofKey, rep, pt, proofAt, noticeHeaderLen+full))
	})
	if err != nil {
		t.Fatal(err)
	}
	return sealed
}

func mustFromKey(t *testing.T, priv *InboxKey, pub, from, to *InboxAddress) []byte {
	t.Helper()
	k, err := fromKey(priv.xpriv, pub.xpub, from, to)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestFromRoundTrip(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	link := append([]byte{linkVersion1}, bytes.Repeat([]byte{9}, linkLen-1)...)
	for _, to := range []*InboxAddress{b.Address, b.Address4} {
		for _, c := range []struct {
			kind byte
			name string
			body []byte
		}{
			{NoticeText, "Sam", []byte("hello")},
			{NoticeText, "", []byte("no name")},
			{NoticeText, "Zoë 🌱 Ольга", nil},
			{NoticeText, strings.Repeat("é", MaxFromName/2), bytes.Repeat([]byte{'x'}, to.MaxBody(msgLen)-modeOf(to, nil).fromOverhead(MaxFromName))},
			{NoticeText | NoticeDeflate, "Sam", deflated(t, "packed")},
			{NoticeLink, "Sam", link},
			{NoticeLink, "", append(bytes.Clone(link), "with a note"...)},
		} {
			streams := seal(t, to, c.kind, c.body, &From{Key: a, Name: c.name}, 9)
			o, err := open(b, streams)
			if err != nil {
				t.Fatalf("%q: %v", c.name, err)
			}
			want := c.body
			if c.kind&NoticeDeflate != 0 {
				want = []byte("packed")
			}
			if o.kind != c.kind&^NoticeDeflate || !bytes.Equal(o.body, want) || o.name != c.name || o.round != 9 {
				t.Fatalf("got %+v", o)
			}
			// Always the sender's compact address. A quantum-safe notice
			// carries their reply keys for the recipient too, so
			// a reply can be quantum-safe; a compact one never does.
			if o.from == nil || !bytes.Equal(o.from.Bytes(), a.Address.Bytes()) || !o.from.mailbox.Cmp(a.Address.mailbox) || o.from.QuantumSafe() {
				t.Fatalf("from %v, want the sender's inbox", o.from)
			}
			want4, err := a.replyKeysFor(b.Address)
			if err != nil {
				t.Fatal(err)
			}
			if to.QuantumSafe() != (o.replyKeys != nil) || (o.replyKeys != nil && *o.replyKeys != *want4) {
				t.Fatalf("reply keys %v, to a quantum-safe address %v", o.replyKeys, to.QuantumSafe())
			}
			// Anyone else, the sender included, can't open it.
			if _, err := open(a, streams); err == nil {
				t.Fatal("the sender's own key opened a notice sealed to the recipient")
			}
		}
	}

	// A note to one's own inbox works too.
	for _, to := range []*InboxAddress{a.Address, a.Address4} {
		if o, err := open(a, seal(t, to, NoticeText, []byte("to myself"), &From{Key: a}, 9)); err != nil || !bytes.Equal(o.from.Bytes(), a.Address.Bytes()) {
			t.Fatalf("to oneself: %+v, %v", o, err)
		}
	}
}

func TestFromLimits(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	if got := FromOverhead(0); got != 66 {
		t.Fatalf("FromOverhead(0) = %d, want 66", got)
	}
	for _, to := range []*InboxAddress{b.Address, b.Address4} {
		room := func(name string) int { return to.MaxBody(msgLen) - modeOf(to, nil).fromOverhead(len(name)) }
		for name, c := range map[string]struct {
			from *From
			body []byte
			want error
		}{
			"fits":            {&From{Key: a, Name: "Sam"}, make([]byte, room("Sam")), nil},
			"one over":        {&From{Key: a, Name: "Sam"}, make([]byte, room("Sam")+1), ErrNoticeSize},
			"longest name":    {&From{Key: a, Name: strings.Repeat("a", MaxFromName)}, []byte("hi"), nil},
			"name too long":   {&From{Key: a, Name: strings.Repeat("a", MaxFromName+1)}, []byte("hi"), ErrFromName},
			"name isn't text": {&From{Key: a, Name: "Sam\xff"}, []byte("hi"), ErrFromName},
		} {
			_, err := newNoticeSealer(to, NoticeText, c.body, c.from, nil, msgLen)
			if err != c.want {
				t.Errorf("%s: got %v, want %v", name, err, c.want)
			}
		}
	}
}

// Every part of a notice that includes the sender's inbox is covered by its
// proof, and the proof is tied to the notice it came in, the two inboxes and
// the direction between them.
func TestFromRejects(t *testing.T) {
	a, b, c := testKey(t, 1), testKey(t, 2), testKey(t, 3)
	sealed := seal(t, b.Address, NoticeText, []byte("hello"), &From{Key: a, Name: "Sam"}, 1)[0]
	pt, err := openSealed(b, sealed)
	if err != nil {
		t.Fatal(err)
	}
	rep := sealed[:keyRepLen]
	end := noticeHeaderLen + int(binary.BigEndian.Uint16(pt[2:4]))
	if _, _, _, err := checkFrom(b, rep, pt, end); err != nil {
		t.Fatalf("the untouched plaintext: %v", err)
	}

	// Any one bit of the header, the sender's address, the name, the proof or
	// the message changed: refused. (Only the recipient could do this, since
	// the seal covers it all too; this checks the proof on its own.)
	for i := 0; i < end; i++ {
		for _, bit := range []byte{1, 0x80} {
			bad := bytes.Clone(pt)
			bad[i] ^= bit
			if _, _, _, err := checkFrom(b, rep, bad, end); err == nil {
				t.Fatalf("byte %d changed by %#x still proved out", i, bit)
			}
		}
	}
	for i := range keyRepLen {
		bad := bytes.Clone(rep)
		bad[i] ^= 1
		if _, _, _, err := checkFrom(b, bad, pt, end); err == nil {
			t.Fatalf("a proof moved to another one-time key (byte %d) proved out", i)
		}
	}

	// The same plaintext under a fresh one-time key: refused.
	rewrapped, err := sealPlaintext(b.Address, bytes.Clone(pt), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openNotice(b, rewrapped); err == nil {
		t.Error("a proof re-sealed under a new one-time key opened")
	}
	// Sealed on to another inbox: refused there.
	forwarded, err := sealPlaintext(c.Address, bytes.Clone(pt), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openNotice(c, forwarded); err == nil {
		t.Error("a proof made for one inbox opened at another")
	}

	// Claiming someone else's inbox without its key: whatever key the forger
	// has, it isn't the one only the claimed inbox and the recipient share.
	right := mustFromKey(t, a, b.Address, a.Address, b.Address)
	for name, key := range map[string][]byte{
		"the forger's own key with the recipient": mustFromKey(t, c, b.Address, a.Address, b.Address),
		"the claimed inbox's key with another":    mustFromKey(t, a, c.Address, a.Address, b.Address),
		"the right secret, the other direction":   mustFromKey(t, a, b.Address, b.Address, a.Address),
		"the right secret, another pair":          mustFromKey(t, a, b.Address, a.Address, c.Address),
		"nothing":                                 make([]byte, len(right)),
	} {
		if _, err := openNotice(b, plainFrom(t, b.Address, a.Address, key, NoticeText, []byte("Sam"), []byte("hi"))); err == nil {
			t.Errorf("%s: a forged proof opened", name)
		}
	}
	if o, err := openNotice(b, plainFrom(t, b.Address, a.Address, right, NoticeText, []byte("Sam"), []byte("hi"))); err != nil || string(o.body) != "hi" {
		t.Fatalf("the helper's own notice: %+v, %v", o, err)
	}

	// Malformed: the sender's address, the name's length, the name itself,
	// too short a body, an unknown flag. Each with an otherwise right proof
	// where one can be made.
	small := append([]byte{inboxAddressVersion}, make([]byte, 32)...) // a point of small order
	smallKey := right                                                 // never reached: the address is refused first
	plain := func(kind byte, nameLen int, name, body []byte, proofKey []byte, from []byte) []byte {
		pt := make([]byte, streamLen-hpkeOverhead)
		full := InboxAddressLen + 1 + len(name) + fromProofLen + len(body)
		pt[0], pt[1] = noticeVersion, kind
		binary.BigEndian.PutUint16(pt[2:4], uint16(full))
		binary.BigEndian.PutUint32(pt[4:8], 1)
		at := noticeHeaderLen + copy(pt[noticeHeaderLen:], from)
		pt[at] = byte(nameLen)
		proofAt := at + 1 + copy(pt[at+1:], name)
		copy(pt[proofAt+fromProofLen:], body)
		s, err := sealPlaintext(b.Address, pt, func(rep []byte) {
			copy(pt[proofAt:], fromProof(proofKey, rep, pt, proofAt, noticeHeaderLen+full))
		})
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	ab := a.Address.Bytes()
	for name, s := range map[string][]byte{
		"small-order address":   plain(NoticeText|noticeFrom, 3, []byte("Sam"), []byte("hi"), smallKey, small),
		"a link's version byte": plain(NoticeText|noticeFrom, 3, []byte("Sam"), []byte("hi"), right, append([]byte{linkVersion1}, ab[1:]...)),
		"name past the body":    plain(NoticeText|noticeFrom, 255, []byte("Sam"), []byte("hi"), right, ab),
		"name isn't text":       plain(NoticeText|noticeFrom, 4, []byte("Sam\xff"), []byte("hi"), right, ab),
		"unknown flag":          plain(NoticeText|noticeFrom|0x20, 3, []byte("Sam"), []byte("hi"), right, ab),
		"compressed, isn't":     plain(NoticeText|noticeFrom|NoticeDeflate, 3, []byte("Sam"), []byte("hi"), right, ab),
		"quantum-safe address":  plain(NoticeText|noticeFrom, 3, []byte("Sam"), []byte("hi"), right, append([]byte{inboxAddress4Version}, ab[1:]...)),
		"link too short":        plain(NoticeLink|noticeFrom, 3, []byte("Sam"), []byte{linkVersion1}, right, ab),
	} {
		if _, err := openNotice(b, s); err == nil {
			t.Errorf("%s: opened", name)
		}
	}
	tooLong := strings.Repeat("a", MaxFromName+1)
	if _, err := openNotice(b, plain(NoticeText|noticeFrom, len(tooLong), []byte(tooLong), nil, right, ab)); err == nil {
		t.Error("a name over MaxFromName opened")
	}
	// The flag with less than a sender's worth of body.
	short := make([]byte, streamLen-hpkeOverhead)
	short[0], short[1] = noticeVersion, NoticeText|noticeFrom
	binary.BigEndian.PutUint16(short[2:4], uint16(FromOverhead(0)-1))
	copy(short[noticeHeaderLen:], ab)
	s, err := sealPlaintext(b.Address, short, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := openNotice(b, s); err == nil {
		t.Error("a body too short for a sender opened")
	}
}

// The proof convinces only the recipient: they could have made it
// themselves, so it proves nothing to anyone they show it to. That's the
// point of using a key both inboxes can work out rather than a signature.
func TestFromDeniable(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	if !bytes.Equal(mustFromKey(t, a, b.Address, a.Address, b.Address), mustFromKey(t, b, a.Address, a.Address, b.Address)) {
		t.Fatal("the recipient can't work out the sender's proof key")
	}
	// A notice "from" a, made by b alone, opens just like a real one.
	byRecipient := mustFromKey(t, b, a.Address, a.Address, b.Address)
	o, err := openNotice(b, plainFrom(t, b.Address, a.Address, byRecipient, NoticeText, []byte("Sam"), []byte("made by the recipient")))
	if err != nil || !bytes.Equal(o.from.Bytes(), a.Address.Bytes()) {
		t.Fatalf("got %+v, %v", o, err)
	}
	// Directions differ: what a sends b proves nothing the other way.
	if bytes.Equal(mustFromKey(t, a, b.Address, a.Address, b.Address), mustFromKey(t, b, a.Address, b.Address, a.Address)) {
		t.Fatal("a→b and b→a share a proof key")
	}
}

// The proof's key and the proof itself must never change, or replies from
// one build couldn't be read by another. These values were checked against
// an independent implementation (Node's crypto, web/test/inbox-reply.test.ts).
func TestFromKnownAnswer(t *testing.T) {
	a, b := goldenKey(t), testKey(t, 2)
	key := mustFromKey(t, a, b.Address, a.Address, b.Address)
	const goldenKeyHex = "f7081a5b666253f54d76149e4e9adec7e0aad709b8e26e3a32f8b3199067b783"
	if got := hex.EncodeToString(key); got != goldenKeyHex {
		t.Errorf("proof key %s, want %s", got, goldenKeyHex)
	}
	pt := make([]byte, 64)
	for i := range pt {
		pt[i] = byte(i)
	}
	rep := bytes.Repeat([]byte{0x11}, keyRepLen)
	const goldenProof = "baf5d5b42ecfff482d29c382f0c4b28abc03e917cd87344da93c0a3ff4bee460"
	if got := hex.EncodeToString(fromProof(key, rep, pt, 20, 60)); got != goldenProof {
		t.Errorf("proof %s, want %s", got, goldenProof)
	}
}

// In a quantum-safe notice the proof covers both encoded keys and the
// pairing tag: moved to another encoding of either key, or another tag, it
// doesn't prove out.
func TestFromCoversBothKeys(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	streams := seal(t, b.Address4, NoticeText, []byte("hello"), &From{Key: a, Name: "Sam"}, 1)
	whole := append(bytes.Clone(streams[0]), streams[1][pairTagLen:]...)
	keys := append(bytes.Clone(whole[:keys4Len]), streams[1][:pairTagLen]...) // and the tag
	ctPQ, err := kemeleonDecode768(keys[keyRepLen:keys4Len])
	if err != nil {
		t.Fatal(err)
	}
	r, err := hpke.NewRecipient(append(ctPQ, mustReveal(t, keys[:keyRepLen])...), b.sk4, noticeKDF, noticeAEAD, []byte(inboxNotice4Info))
	if err != nil {
		t.Fatal(err)
	}
	pt, err := r.Open(keys, whole[keys4Len:])
	if err != nil {
		t.Fatal(err)
	}
	end := noticeHeaderLen + int(binary.BigEndian.Uint16(pt[2:4]))
	if _, _, _, err := checkFrom(b, keys, pt, end); err != nil {
		t.Fatalf("the untouched plaintext: %v", err)
	}
	for _, i := range []int{0, keyRepLen - 1, keyRepLen, keys4Len / 2, keys4Len - 1, keys4Len, len(keys) - 1} {
		bad := bytes.Clone(keys)
		bad[i] ^= 1
		if _, _, _, err := checkFrom(b, bad, pt, end); err == nil {
			t.Fatalf("a proof moved to other keys (byte %d) proved out", i)
		}
	}
}

func mustReveal(t *testing.T, rep []byte) []byte {
	t.Helper()
	k, err := revealKey(rep)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// Notices including the sender's inbox, sealed by this build: they must keep
// opening the same way, with the same sender and name.
func TestFromKnownNotice(t *testing.T) {
	a, b := goldenKey(t), testKey(t, 2)
	for name, c := range map[string]struct {
		hex string
		qs  bool
	}{
		"compact":      {knownFromNotice, false},
		"quantum-safe": {knownFromNotice4, true},
	} {
		raw, err := hex.DecodeString(c.hex)
		if err != nil {
			t.Fatal(err)
		}
		streams := [][]byte{raw}
		if c.qs {
			streams = [][]byte{raw[:streamLen], raw[streamLen:]}
		}
		o, err := open(b, streams)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if o.kind != NoticeText || string(o.body) != "Known-answer test: a message they can reply to." || o.name != "Sam" ||
			o.round != knownRound || o.quantum != c.qs || !bytes.Equal(o.from.Bytes(), a.Address.Bytes()) {
			t.Fatalf("%s: got %+v", name, o)
		}
	}
}

// The inbox session passes on who a message is from, when they said.
func TestInboxSessionFrom(t *testing.T) {
	a, b := testKey(t, 1), testKey(t, 2)
	var got []Notice
	s := testSession(b, func(n Notice) { got = append(got, n) })
	none := receptionID.EphemeralIdentity{}
	from := seal(t, b.Address, NoticeText, []byte("reply to me"), &From{Key: a, Name: "Sam"}, 1)
	anon := seal(t, b.Address, NoticeText, []byte("anonymous"), nil, 2)
	from4 := seal(t, b.Address4, NoticeText, []byte("quantum-safe, reply to me"), &From{Key: a, Name: "Sam"}, 3)
	s.Process(cmixMessage(t, from[0]), nil, nil, none, roundAt(1, testSent.Add(time.Second)))
	s.Process(cmixMessage(t, anon[0]), nil, nil, none, roundAt(2, testSent.Add(time.Second)))
	for _, m := range from4 {
		s.Process(cmixMessage(t, m), nil, nil, none, roundAt(3, testSent.Add(time.Second)))
	}
	if len(got) != 3 {
		t.Fatalf("got %d notices", len(got))
	}
	if n := got[0]; n.From == nil || !bytes.Equal(n.From.Bytes(), a.Address.Bytes()) || n.FromName != "Sam" || string(n.Body) != "reply to me" || n.Kind != NoticeText {
		t.Errorf("from: %+v", n)
	}
	if n := got[1]; n.From != nil || n.FromName != "" {
		t.Errorf("anonymous: %+v", n)
	}
	if n := got[2]; n.From == nil || !bytes.Equal(n.From.Bytes(), a.Address.Bytes()) || !n.QuantumSafe {
		t.Errorf("quantum-safe from: %+v", n)
	}
}

// knownFromNotice and knownFromNotice4 were sealed by the golden key's inbox
// ("abandon" x11, "about"), named "Sam", to testKey(2)'s compact and
// quantum-safe addresses, for knownRound, on 2026-10-18 (the
// quantum-safe one by the first build with pairing tags).
const (
	knownFromNotice = "fe632b7eb3ea3a5c5121c544c0885b430b633a7ae550a9d639ab32fc5fb88411" +
		"c3c8c64e6cdaa223878b9a1f5472991e5752e39aea21f42a82a02001f0c508ee" +
		"920bbd52a532f1c0aef2ee2d435038048a424f2306f7597fba8fc107dbd38ce5" +
		"ead1e70acdffc23ca28da437489a21e4f87652d2a405d6227014fb0cf30ff6ad" +
		"1f7dcf2d82f79a436aa087f5e8a67e037fba3d35e97ffd7aa3ab52c4a5a6900d" +
		"d7aab88eea44614d685709ab2dfa3337006b842eff73365d844242bc3c3a7e4e" +
		"0a812fe4de725d55ee40d3ced76c60699f71a68d31397f72fa926598f3117976" +
		"ccc06236d7126544fc3f64e696a1bfd6e8cd5e53ed56342cb4bd0b802c06912e" +
		"1d00d1abbec365eab136d34a698f7ad40fe29a649392a22e99b18240a4b7873c" +
		"b6952455523bbb4a5bd2e2465bbe73e9caf13903918c00a436a7adfa96b17810" +
		"a57982a4dca52a041568386abd75804579396acfac994f5c32c4dbaff48aab52" +
		"00867264d268fed2b7b383e8ce4a67508ba341bbf1168b475fda96d48a5bf2c2" +
		"0b1213c708ceb11bb17ec7c95450a5c9c46ddb549b55adf9770391141c0e6520" +
		"dbc5adc7cfd569986f2f6666a222929a205d9459e18866c1a102b0088eda953c" +
		"20ad0854b46756c8ef897a63c43019867e5cb9378b5601759fcf5b49408e1873" +
		"f33b7b29b0019f502c872f9ffd398c2ee9145a99a905aa69547e91e56e86e8ce" +
		"b2a9bab6d485efe1046a3112360980ceb8979c8f3785f81cbff64a17ae8ac610" +
		"c44132aa23a475bf6087ae36d3f92d1123581411051ae115c60b8196cad11adc" +
		"ff442f41857024dcac9087dfbab1472628a5e706eea2df94793e18ee94310a25" +
		"9258387d248fabf1acee0684c424e622e7847a266d3cec5cb15cb15e3309d502" +
		"82eda14d637bb55f34d4df9444377d633849922d136ee52b9419f16d9fef115d" +
		"13e42db793030e634cda3238663ee72902351f523dcc73684f309ea3d0994456" +
		"e52de8cbd032a226ecfe02adb52a0d66ee95dede89665ade521b30dc131dbd32" +
		"53b0164894c62f38f53f88d6d2d8496cf9ccc38ab771db0107227110ea43e4b0" +
		"c26b1a8122f5555df2cebc9903da7d20712b0d90de48edde2d2dbfda145402ba" +
		"aa700b1313e629566b3e51d7d9ceb7c25a61dc10001864151469ccd5321fa081" +
		"253f239839a9594358833218633b6f47384a8e02ce7e4145f2d5790cc8bed0e1" +
		"a8b93b88b2db14cb5d8e330b1f9ec5e8a4c5fe97be742d0fbc038741c61c9222" +
		"bda11cba25cfc7c56ffb4ce235725fafc4eb71f4333a3785a365ce599a1b6e75" +
		"7ed75febeac32a41de35a51a4b0ca0058418456ed98235aed40da1d7704bb960" +
		"fd1c28830720418ca1769ae752caaa224a9b125c7bdbe3ac299d38ed"
	knownFromNotice4 = "0bf01cb064bd481182119a2038565dd9c575dd084d45463f325b3ea27f6c43c7" +
		"27c820e3d18a2534c5db2e0eef29e784ddedd5bbf39c5f4c1d55a0640c2ed152" +
		"6773a7e3974bc1817667f95d30c04e96c57f837594ebe0316fcb83ebe6522e93" +
		"6b388b665ac8ea0d63edd45746287fdee0d68c5c0aabe16055ad4f9af76717f9" +
		"947464d7f42689947a281345778fe6ebafdad4b0c274b3b18984f2dd39ac06e7" +
		"a68ae7e1a7e583467ae4c4025071b019134e0b2cf4e7a4e392d4c65fc3114ee8" +
		"e93a549f00ae833ffcb1c972ac0673fa02d44069326c33bda2c1a64501529286" +
		"45c9387bfc44ac6ddd5a7d3b54b906682070c570cd48444512be2ef02b153699" +
		"be7724f24c127e2cba85ab0fd65bb0cd6141196d6db2204c002c3ac576468df0" +
		"b2bb150a3dd425def3acb4ced0a7d397662aa70a63647b04fa8f1cdfb11e820d" +
		"6cdcaa724a4b6efba269de7dc5550e0d3b4ba16f22d6dd1c7f70898d221729c1" +
		"a3ab6b7971ec1f93705ec9046a396473faa1ac1b3d02e07e868d902599f51fca" +
		"10a8310fc8326151326424404da91f160d0199ddffcecadde577711bc088cb5d" +
		"b29a3a953cdca7731b128cf58bd2bab7e7a0f02884216c3a6f480a4218301042" +
		"6cd905557052e7a9b4444db5f8147b9f7d4f409643390e9fc01658eb7239d800" +
		"927e8bb9b5a88fb6fec65539063518ff9b363c295c68728c6e18cd93d961110d" +
		"d0d137d884e4ba0e57c826cd5e11d6e579d09d3c71b2fc561fa5c0ad2c03db29" +
		"edae1ea5442a074ab5b1560a12d393725303f7abd9d4034a42bda609add8b912" +
		"6ae870167a13059859fdefe3a3595fa383bbdab10ffbac562c3d5ec8ac30cbcd" +
		"3f1c7182864ce72999093cee3ba776b63a174db096ee524df798301c13aab211" +
		"3f362d598aeccd9831eba04ed4d5f425ff3019dca06030db35c3d702c370355b" +
		"51081828f1bea2e280d88b558d37b536895002c03e76ea8338cc62ab65ca4725" +
		"a3070a67aedec489a8f170adebd0943cd42fba9a59354721fb52159a0bcd241a" +
		"4dcb023be28e8254121505b84803f2041af20ac64618d1285cfb0da31e73b610" +
		"3cc0bf1d27f1df4e94d0fffa3af83e036b721750f219cf387aee352b2df1a8ba" +
		"23f96a78e2e64cabc174f2d089877828eeb3ea3ba1a6cf19fe53e525c6373088" +
		"60c51cf8327262546cd4c0f62c2926aa97fa019cebeb2ad60f520db732f1fdb5" +
		"8786251ae1294d3eb5fc92289fb7185e1f81e9f94b9db0a1401c22f2e371bb2e" +
		"77446a56e7f14068a5ff29634b441ca0b805ace3dbbbb224f34863a3e04fe664" +
		"e7ccc83c661c9fc05ea55d4fcd89428fd7f9664f71209aeec5464f9234258f3f" +
		"15a9e6cff70c1cd2049c4244049f479361fd768dace64b707e81c125045f4f76" +
		"fc177b9b4d73df99d62b8663a71066f405e3a9435519488467430e81c1c7d670" +
		"41508dfcecabc981e63ba71cc99cbd9fa055b9e326e7f70e787ec3b11f6ce2f5" +
		"69415e748c0b3400d5317bb819dde4f0e3973e4e6b83b2c46974c0d0beaa1e0a" +
		"4e96c70bcc17a6009673bde499050549feacda32d02e45bf9e352ba0443c1a1c" +
		"1e33147efce5f9168d72298c8bf93c5567ec2cdc94534b5e652204cedefc2b57" +
		"d2e21b73cf04a967651dc15b780d24c8f35076a360f5e09b3c9b6ee57cf7def6" +
		"0ce35db2673f05891bc6a68b02cd07ad6709167327cfa49502a3cc15bb918580" +
		"4f05dbf6d684178fbf64953131f963bf4da21aa3046a60e7326edb9cd803897f" +
		"07fb07b7c69431c4ff6b9ded8f5660affadaed1a89b023240510014fbb8517d1" +
		"7a7689cb7c87b8b80b6f03605d610add40e4b97984c36f37d03bf46a2fd5340d" +
		"9a750b7c46cebfec2003e7b1d406979e4befe403d91651e8d73f9f9cdd0c300d" +
		"b1a1cb9e20f918370e6339b9534617c12414d127a5e8254e9d486aeb7325f839" +
		"fc8bb2e5765c3bda94cb2ceb04beeaa7a09cda2d937f4014b47d7648a9b35447" +
		"3f0c3d62bcfaa1ed530d1ebba03a494b8b1b00428b66ccf9b296e6d5edec6192" +
		"0c34a84cc4d98cfc51fab965e2aff8e88ecb2f1c5031b5c8d01c995e7beea015" +
		"018b95321f64a6a7bf6956293835b625b06c9353e439d90070dd7f2736ff8216" +
		"536ef89a4844b938032ec3ade8da5cb689adc7c3e9ca3205cd8d97086a281095" +
		"12e51df928ebb742d6861ec4f1062984ff46dd2147b85a32cdc2c1a23399859e" +
		"4b80d2c37bb1fc064f63c17785df380595804ab1a0393e1d1505f3cde46748a7" +
		"8b9b21d60e76127c3df059daea8dfd19ae0e2931b1885aeb9d87fbe7a2c69436" +
		"811863060caf21343434adaa54d8d6b94cb3144dd2679c275690c13fad9f88a5" +
		"ed0488f45c86101ab5eab75d10388045800485c2df1059bfc8b73927897eee22" +
		"8827021acdf91643ff65e2b48f79935d6d6d461c488937459ff98b71b6aae2ff" +
		"ab0948d0fa262ddae6756214d78985d933f15f2d5ff1e734662d5200c581df6e" +
		"650beeed486eeed394211a1182c43db6950ed82615da032f6e39852717dfbf9a" +
		"34211ad3711f0322d1b72c0e7dcdd490bbeeced841f6e5a9e34d80807eebb9b1" +
		"56c6b59de084ab20402c53f8bd36250f06717f6360ffc4383d5b9ebec1ec8088" +
		"5cd81abcc2b1285a4b053c514434c7c6ca7e983acc40b004a41af5707ec8f752" +
		"c50dd1745eaa03363fe3513c71f07eb9aeaa5130a805e8691448653ae25889cb" +
		"087f2fb9a24de1481366b5d875a6075f2fb47d2bf3be29fa27343eec1b9d03c2" +
		"c47387043e47270f25cbb9e556dc7f4d3d2b0eae23c5cf2f"
)
