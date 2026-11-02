package transfer

import (
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"slices"

	"github.com/pkg/errors"
	"golang.org/x/crypto/chacha20poly1305"
)

// HPKE's steps (RFC 9180), written out where Go's crypto/hpke can't do the
// job as it is: the sending side of a quantum-safe notice, whose pairing tag
// comes from X-Wing's X25519 secret, which crypto/hpke keeps to itself
// (xwing.go); and both sides of a reply sealed with reply keys, which takes
// HPKE's PSK mode, which crypto/hpke doesn't offer (reply.go). Every step is
// the RFC's own, always with HKDF-SHA256 and ChaCha20-Poly1305, a compact
// notice's KDF and AEAD: xwing_test.go and reply_test.go check them against
// the test vectors the standards publish, and against crypto/hpke.

// The modes of HPKE's key schedule used here (RFC 9180 section 5).
const (
	hpkeModeBase = 0x00
	hpkeModePSK  = 0x01
)

// hpkeSuiteID is the suite_id of HPKE's key schedule for a KEM: "HPKE", then
// the KEM, the KDF (1, HKDF-SHA256) and the AEAD (3, ChaCha20-Poly1305).
func hpkeSuiteID(kem uint16) []byte {
	return []byte{'H', 'P', 'K', 'E', byte(kem >> 8), byte(kem), 0x00, 0x01, 0x00, 0x03}
}

var (
	// xwingSuite is a quantum-safe notice's: KEM 0x647a, MLKEM768-X25519.
	xwingSuite = hpkeSuiteID(0x647a)
	// dhkemSuite is a reply's: KEM 0x0020, DHKEM(X25519, HKDF-SHA256), as a
	// compact notice's.
	dhkemSuite = hpkeSuiteID(0x0020)
	// dhkemKEMSuite is the suite_id inside that KEM (RFC 9180 section 4.1).
	dhkemKEMSuite = []byte{'K', 'E', 'M', 0x00, 0x20}
)

// labeledExtract and labeledExpand are RFC 9180's (section 4), for a suite_id.
func labeledExtract(suite, salt []byte, label string, ikm []byte) ([]byte, error) {
	return hkdf.Extract(sha256.New, slices.Concat([]byte("HPKE-v1"), suite, []byte(label), ikm), salt)
}

func labeledExpand(suite, prk []byte, label string, info []byte, n int) ([]byte, error) {
	labeled := slices.Concat([]byte{byte(n >> 8), byte(n)}, []byte("HPKE-v1"), suite, []byte(label), info)
	return hkdf.Expand(sha256.New, prk, string(labeled), n)
}

// hpkeKey is HPKE's key schedule (RFC 9180 section 5.1) for a suite: the AEAD
// key and the nonce of the first message sealed with it (the only one, for a
// notice), from the KEM's shared secret, the info string and, in PSK mode,
// the pre-shared key and its ID (both empty in base mode).
func hpkeKey(suite []byte, mode byte, ss, info, psk, pskID []byte) (key, nonce []byte, err error) {
	// VerifyPSKInputs: both or neither, and only in PSK mode.
	if (len(psk) == 0) != (len(pskID) == 0) || (mode == hpkeModePSK) != (len(psk) > 0) {
		return nil, nil, errors.New("inconsistent PSK inputs")
	}
	pskIDHash, err := labeledExtract(suite, nil, "psk_id_hash", pskID)
	if err != nil {
		return nil, nil, err
	}
	infoHash, err := labeledExtract(suite, nil, "info_hash", info)
	if err != nil {
		return nil, nil, err
	}
	context := slices.Concat([]byte{mode}, pskIDHash, infoHash)
	secret, err := labeledExtract(suite, ss, "secret", psk)
	if err != nil {
		return nil, nil, err
	}
	if key, err = labeledExpand(suite, secret, "key", context, chacha20poly1305.KeySize); err != nil {
		return nil, nil, err
	}
	if nonce, err = labeledExpand(suite, secret, "base_nonce", context, chacha20poly1305.NonceSize); err != nil {
		return nil, nil, err
	}
	return key, nonce, nil
}

// hpkeContext is the AEAD hpkeKey's key makes, and the first nonce.
func hpkeContext(suite []byte, mode byte, ss, info, psk, pskID []byte) (cipher.AEAD, []byte, error) {
	key, nonce, err := hpkeKey(suite, mode, ss, info, psk, pskID)
	if err != nil {
		return nil, nil, err
	}
	aead, err := chacha20poly1305.New(key)
	if err != nil {
		return nil, nil, err
	}
	return aead, nonce, nil
}

// dhkemSecret is DHKEM(X25519, HKDF-SHA256)'s shared secret (RFC 9180
// section 4.1, ExtractAndExpand): from the X25519 result, the encapsulated
// key (the sender's one-time public key) and the recipient's public key.
func dhkemSecret(dh, enc, pkR []byte) ([]byte, error) {
	prk, err := labeledExtract(dhkemKEMSuite, nil, "eae_prk", dh)
	if err != nil {
		return nil, err
	}
	return labeledExpand(dhkemKEMSuite, prk, "shared_secret", slices.Concat(enc, pkR), sha256.Size)
}
