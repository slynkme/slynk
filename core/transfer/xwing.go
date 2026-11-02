package transfer

import (
	"crypto/sha3"
)

// The sending side of a quantum-safe notice's seal, written out. The owner
// opens it with Go's crypto/hpke: HPKE's base mode (RFC 9180) with the
// MLKEM768-X25519 KEM, which is X-Wing (draft-connolly-cfrg-xwing-kem, as
// draft-ietf-hpke-pq puts it in HPKE), HKDF-SHA256 and ChaCha20-Poly1305.
// The sender takes the same steps here rather than through crypto/hpke only
// because the pairing tag (inbox4.go) comes from X-Wing's X25519 shared
// secret, which crypto/hpke keeps to itself. Each step is the standards'
// own: X-Wing's combiner here, HPKE's key schedule in hpke.go. xwing_test.go
// checks them against draft-ietf-hpke-pq's test vector for this suite, and
// against crypto/hpke, which opens everything sealed here.

// xwingLabel ends X-Wing's combiner: the six characters \./ and /^\.
const xwingLabel = `\./` + `/^\`

// xwingSecret is X-Wing's combiner: the KEM's shared secret from ML-KEM's
// (ssPQ), X25519's (ssT), the X25519 ciphertext, which is the sender's
// one-time public key (ctT), and the recipient's X25519 key (pkT).
func xwingSecret(ssPQ, ssT, ctT, pkT []byte) []byte {
	h := sha3.New256()
	h.Write(ssPQ)
	h.Write(ssT)
	h.Write(ctT)
	h.Write(pkT)
	h.Write([]byte(xwingLabel))
	return h.Sum(nil)
}
