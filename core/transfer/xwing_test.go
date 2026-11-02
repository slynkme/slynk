package transfer

import (
	"bytes"
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/mlkem"
	"crypto/mlkem/mlkemtest"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func mustDecode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The sender's side of a quantum-safe seal (xwing.go, hpke.go) against the test vector
// draft-ietf-hpke-pq gives for this suite (KEM 0x647a, X-Wing; KDF 1,
// HKDF-SHA256; AEAD 3, ChaCha20-Poly1305; base mode), as Go 1.27 ships it in
// crypto/hpke/testdata/hpke-pq.json: the recipient's key from ikmR and the
// sender's one-time X25519 key and ML-KEM randomness from ikmE, as crypto/hpke's
// own tests use them; then the encapsulation, X-Wing's shared secret, the key
// schedule's key and nonce, and the first sealed message. pkRm and enc, long,
// are pinned by their SHA-256.
func TestXWingVector(t *testing.T) {
	var (
		info     = mustDecode(t, "34663634363532303666366532303631323034373732363536333639363136653230353537323665")
		ikmE     = mustDecode(t, "a3a869097e0241158eca5dc6c9e695f9e0d2ee5db51c09c435aab69d56509a43d94ff76d7d47cf79ecf75394261236cec024bd849cc782e14f7f0738af83daed")
		ikmR     = mustDecode(t, "0379761fa4f6869592b0d1f9a71eb92b122dc030a7a8858132109f6b1a4bbde4")
		pkRmHash = "120b60e0ae3c00c1c9def1c61aeb12de710bfa49646ae6f99a7e564b25ace493"
		encHash  = "3a7ef30fb815e75b7f0f16f5bab5c36250882d94ea0f776cc2241cdd3b36b480"
		ss       = mustDecode(t, "b90cf181d95351d1091569487caaf6c3434eeb181a2c4c04631980ce139afa67")
		key      = mustDecode(t, "4a4c042267e8ec360c83b2baf0d5e3dcca73a86531cdf67ec41d95bccfe12387")
		nonce    = mustDecode(t, "5ddfaaee10a4dfd0d8e1b49f")
		aad      = mustDecode(t, "436f756e742d30")
		pt       = mustDecode(t, "34323635363137353734373932303639373332303734373237353734363832633230373437323735373436383230363236353631373537343739")
		ct       = mustDecode(t, "ac355d192158cd54250e1702be51e9d2eafe5f9292a9f153e02a2323e1ff071a30947836c38c63c986c28ccf05e00d4e5fe066a48ab8d5b39c69d32da80c93dc868daa0f853a6cbdd640")
	)
	sk, err := hpke.MLKEM768X25519().DeriveKeyPair(ikmR)
	if err != nil {
		t.Fatal(err)
	}
	pkR := sk.PublicKey().Bytes()
	if h := sha256.Sum256(pkR); hex.EncodeToString(h[:]) != pkRmHash {
		t.Fatalf("the recipient's key hashes to %x", h)
	}
	ek, err := mlkem.NewEncapsulationKey768(pkR[:mlkem.EncapsulationKeySize768])
	if err != nil {
		t.Fatal(err)
	}
	pkT, err := ecdh.X25519().NewPublicKey(pkR[mlkem.EncapsulationKeySize768:])
	if err != nil {
		t.Fatal(err)
	}

	// The encapsulation, as sealPlaintext4 makes it, with the vector's
	// randomness.
	skE, err := ecdh.X25519().NewPrivateKey(ikmE[32:])
	if err != nil {
		t.Fatal(err)
	}
	ssT, err := skE.ECDH(pkT)
	if err != nil {
		t.Fatal(err)
	}
	ssPQ, ctPQ, err := mlkemtest.Encapsulate768(ek, ikmE[:32])
	if err != nil {
		t.Fatal(err)
	}
	enc := append(bytes.Clone(ctPQ), skE.PublicKey().Bytes()...)
	if h := sha256.Sum256(enc); hex.EncodeToString(h[:]) != encHash {
		t.Fatalf("the encapsulation hashes to %x", h)
	}
	if got := xwingSecret(ssPQ, ssT, skE.PublicKey().Bytes(), pkT.Bytes()); !bytes.Equal(got, ss) {
		t.Fatalf("shared secret %x, want %x", got, ss)
	}
	gotKey, gotNonce, err := hpkeKey(xwingSuite, hpkeModeBase, ss, info, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotKey, key) || !bytes.Equal(gotNonce, nonce) {
		t.Fatalf("key %x and nonce %x, want %x and %x", gotKey, gotNonce, key, nonce)
	}
	aead, n, err := hpkeContext(xwingSuite, hpkeModeBase, ss, info, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	sealed := aead.Seal(nil, n, pt, aad)
	if !bytes.Equal(sealed, ct) {
		t.Fatalf("sealed %x, want %x", sealed, ct)
	}
	// And crypto/hpke, as the owner uses it, opens what was sealed here.
	r, err := hpke.NewRecipient(enc, sk, hpke.HKDFSHA256(), hpke.ChaCha20Poly1305(), info)
	if err != nil {
		t.Fatal(err)
	}
	if opened, err := r.Open(aad, sealed); err != nil || !bytes.Equal(opened, pt) {
		t.Fatalf("crypto/hpke didn't open it: %v", err)
	}
}

// Every notice sealed here opens with crypto/hpke under the notice's own info
// string, and with nothing else: another info string, or another inbox.
func TestXWingOpensWithHPKE(t *testing.T) {
	k, other := testKey(t, 1), testKey(t, 2)
	pt := make([]byte, plaintext4Len(streamLen))
	for i := range 50 {
		copy(pt, []byte{byte(i)})
		streams, err := sealPlaintext4(k.Address4, pt, nil, streamLen)
		if err != nil {
			t.Fatal(err)
		}
		whole := append(bytes.Clone(streams[0]), streams[1][pairTagLen:]...)
		ctPQ, err := kemeleonDecode768(whole[keyRepLen:keys4Len])
		if err != nil {
			t.Fatal(err)
		}
		enc := append(ctPQ, mustReveal(t, whole[:keyRepLen])...)
		aad := append(bytes.Clone(whole[:keys4Len]), streams[1][:pairTagLen]...)
		for _, c := range []struct {
			key  hpke.PrivateKey
			info string
			ok   bool
		}{
			{k.sk4, inboxNotice4Info, true},
			{k.sk4, inboxNoticeInfo, false},
			{other.sk4, inboxNotice4Info, false},
		} {
			r, err := hpke.NewRecipient(enc, c.key, noticeKDF, noticeAEAD, []byte(c.info))
			if err != nil {
				t.Fatal(err)
			}
			got, err := r.Open(aad, whole[keys4Len:])
			if c.ok != (err == nil) || (c.ok && !bytes.Equal(got, pt)) {
				t.Fatalf("info %q: opened %v", c.info, err)
			}
		}
	}
}
