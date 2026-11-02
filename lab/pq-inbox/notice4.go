package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hpke"
	"crypto/mlkem"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"errors"
	"time"

	"filippo.io/edwards25519"
)

// A quantum-safe inbox address (v4) and its two-piece notices: a prototype,
// not the core's code.
//
// The same 12 words make the inbox as today (v3): its ed25519 key, the
// X25519 key that goes with it and its mailbox. They also make an ML-KEM-768
// key. The v4 address publishes both public keys:
//
//	address: version(4) ed25519PublicKey(32) mlkem768EncapsulationKey(1184)
//
// A notice is sealed with HPKE's MLKEM768-X25519 hybrid (X-Wing, Go's
// crypto/hpke), so it stays safe while either half holds: ML-KEM against a
// quantum computer, X25519 against a flaw in the much younger ML-KEM. X-Wing's
// encapsulated key is ML-KEM's ciphertext followed by an X25519 key; both are
// encoded to look random (Kemeleon and Elligator 2), and they're the AEAD's
// associated data, so a re-encoded copy won't open.
//
//	stream: key(32) kem(1252) sealed(version(1) kind(1) bodyLen(2)
//	        sentUnixMinutes(4) body zeros)
//
// The stream fills two cMix messages exactly and is cut in two. Both go in
// the same round (xxDK's SendMany), to the inbox's usual mailbox. The owner
// tries the messages a round brought it in pairs.

const (
	inbox4AddressVersion = 4
	Inbox4AddressLen     = 1 + ed25519.PublicKeySize + mlkem.EncapsulationKeySize768 // 1217

	// pieces is how many cMix messages a v4 notice fills.
	pieces = 2
	// overhead4 is the encoded keys, the AEAD tag and the notice header.
	overhead4 = keyRepLen + Kem768Len + 16 + noticeHeaderLen // 1308

	noticeHeaderLen = 8
	noticeVersion   = 1
	NoticeText      = 1

	inboxKeyInfo    = "slynk/inbox/v1/ed25519"
	inboxMLKEMInfo  = "slynk/inbox/v4/mlkem768"
	inbox4NoticeInf = "slynk/inbox/v4/notice"
)

var (
	errAddress = errors.New("this isn't a valid v4 inbox address")
	errSize    = errors.New("this is too long for a v4 notice")

	kdf4  = hpke.HKDFSHA256()
	aead4 = hpke.ChaCha20Poly1305()
)

// Address4 is a v4 inbox's public half.
type Address4 struct {
	pub  ed25519.PublicKey
	xpub *ecdh.PublicKey
	ek   *mlkem.EncapsulationKey768
	pk   hpke.PublicKey
}

// Key4 is its private half.
type Key4 struct {
	Address *Address4
	sk      hpke.PrivateKey
}

// key4FromEntropy derives the v4 inbox from the 16 bytes the 12 words stand
// for. The ed25519 and X25519 keys are exactly the core's (inbox.go), so the
// v3 and v4 addresses lead to the same inbox and mailbox.
func key4FromEntropy(entropy []byte) (*Key4, error) {
	seed, err := hkdf.Key(sha256.New, entropy, nil, inboxKeyInfo, ed25519.SeedSize)
	if err != nil {
		return nil, err
	}
	pub := ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey)
	h := sha512.Sum512(seed)
	xpriv, err := ecdh.X25519().NewPrivateKey(h[:32])
	if err != nil {
		return nil, err
	}
	mseed, err := hkdf.Key(sha256.New, entropy, nil, inboxMLKEMInfo, mlkem.SeedSize)
	if err != nil {
		return nil, err
	}
	dk, err := mlkem.NewDecapsulationKey768(mseed)
	if err != nil {
		return nil, err
	}
	sk, err := hpke.NewHybridPrivateKey(dk, xpriv)
	if err != nil {
		return nil, err
	}
	addr, err := newAddress4(pub, dk.EncapsulationKey())
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(addr.xpub.Bytes(), xpriv.PublicKey().Bytes()) {
		return nil, errors.New("inbox key derivation is inconsistent")
	}
	return &Key4{Address: addr, sk: sk}, nil
}

// ParseAddress4 validates a binary v4 address. mlkem checks the encapsulation
// key (FIPS 203's modulus check); the ed25519 checks are the core's.
func ParseAddress4(b []byte) (*Address4, error) {
	if len(b) != Inbox4AddressLen || b[0] != inbox4AddressVersion {
		return nil, errAddress
	}
	ek, err := mlkem.NewEncapsulationKey768(b[1+ed25519.PublicKeySize:])
	if err != nil {
		return nil, errAddress
	}
	return newAddress4(bytes.Clone(b[1:1+ed25519.PublicKeySize]), ek)
}

func newAddress4(pub ed25519.PublicKey, ek *mlkem.EncapsulationKey768) (*Address4, error) {
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil || !bytes.Equal(p.Bytes(), pub) {
		return nil, errAddress
	}
	if new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return nil, errAddress
	}
	xpub, err := ecdh.X25519().NewPublicKey(p.BytesMontgomery())
	if err != nil {
		return nil, errAddress
	}
	pk, err := hpke.NewHybridPublicKey(ek, xpub)
	if err != nil {
		return nil, err
	}
	return &Address4{pub: pub, xpub: xpub, ek: ek, pk: pk}, nil
}

// Bytes is the binary address.
func (a *Address4) Bytes() []byte {
	b := append([]byte{inbox4AddressVersion}, a.pub...)
	return append(b, a.ek.Bytes()...)
}

// V3 is the compact address of the same inbox: anyone holding the v4 address
// can work it out, and a notice sent to it is sealed the classical way.
func (a *Address4) V3() []byte {
	return append([]byte{3}, a.pub...)
}

// MaxBody4 is the most a v4 notice can carry when each cMix message holds
// msgLen bytes.
func MaxBody4(msgLen int) int {
	return pieces*msgLen - overhead4
}

// tries counts the encapsulations sealNotice4 needed (for the lab's
// statistics).
var tries int

// sealNotice4 seals a text body to the inbox and returns the pieces=2 cMix
// payloads, each msgLen bytes, that all look random.
func sealNotice4(to *Address4, body []byte, sent time.Time, msgLen int) ([][]byte, error) {
	if len(body) > MaxBody4(msgLen) {
		return nil, errSize
	}
	pt := make([]byte, pieces*msgLen-keyRepLen-Kem768Len-16)
	pt[0] = noticeVersion
	pt[1] = NoticeText
	binary.BigEndian.PutUint16(pt[2:4], uint16(len(body)))
	binary.BigEndian.PutUint32(pt[4:8], uint32(sent.Unix()/60))
	copy(pt[noticeHeaderLen:], body)

	// Each try succeeds with probability about 1/2 (Elligator) × 0.77
	// (Kemeleon).
	for range 256 {
		tries++
		enc, s, err := hpke.NewSender(to.pk, kdf4, aead4, []byte(inbox4NoticeInf))
		if err != nil {
			return nil, err
		}
		ctPQ, ctT := enc[:mlkem.CiphertextSize768], enc[mlkem.CiphertextSize768:]
		rep, ok, err := hideKey(ctT)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		kem, err := kemeleonEncode768(ctPQ)
		if errors.Is(err, errKemeleonReject) {
			continue
		}
		if err != nil {
			return nil, err
		}
		ad := append(rep, kem...)
		ct, err := s.Seal(ad, pt)
		if err != nil {
			return nil, err
		}
		stream := append(ad, ct...)
		out := make([][]byte, pieces)
		for i := range out {
			out[i] = stream[i*msgLen : (i+1)*msgLen]
		}
		return out, nil
	}
	return nil, errors.New("couldn't encode the keys")
}

// opened4 is what a v4 notice says.
type opened4 struct {
	body []byte
	sent time.Time
}

// openPair tries to open first and second as the two halves of a notice.
// Most pairs aren't one, which is normal.
func openPair(key *Key4, first, second []byte) (opened4, error) {
	stream := append(bytes.Clone(first), second...)
	if len(stream) < keyRepLen+Kem768Len+16 {
		return opened4{}, errors.New("too short")
	}
	rep := stream[:keyRepLen]
	kem := stream[keyRepLen : keyRepLen+Kem768Len]
	ctT, err := revealKey(rep)
	if err != nil {
		return opened4{}, err
	}
	ctPQ, err := kemeleonDecode768(kem)
	if err != nil {
		return opened4{}, err
	}
	r, err := hpke.NewRecipient(append(ctPQ, ctT...), key.sk, kdf4, aead4, []byte(inbox4NoticeInf))
	if err != nil {
		return opened4{}, err
	}
	pt, err := r.Open(stream[:keyRepLen+Kem768Len], stream[keyRepLen+Kem768Len:])
	if err != nil {
		return opened4{}, err
	}
	if len(pt) < noticeHeaderLen || pt[0] != noticeVersion || pt[1] != NoticeText {
		return opened4{}, errors.New("unknown notice version")
	}
	end := noticeHeaderLen + int(binary.BigEndian.Uint16(pt[2:4]))
	if end > len(pt) || len(bytes.Trim(pt[end:], "\x00")) != 0 {
		return opened4{}, errors.New("malformed notice")
	}
	return opened4{
		body: bytes.Clone(pt[noticeHeaderLen:end]),
		sent: time.Unix(int64(binary.BigEndian.Uint32(pt[4:8]))*60, 0),
	}, nil
}

// openRound finds the v4 notices among the messages one round brought to the
// mailbox, trying every ordered pair of messages not yet used. It returns the
// notices and how many pairs it tried. A round holding n messages costs up to
// n(n-1) tries, so the core would cap n (see the report).
func openRound(key *Key4, msgs [][]byte) (found []opened4, tried int) {
	used := make([]bool, len(msgs))
	for i := range msgs {
		for j := range msgs {
			if i == j || used[i] || used[j] {
				continue
			}
			tried++
			if n, err := openPair(key, msgs[i], msgs[j]); err == nil {
				found = append(found, n)
				used[i], used[j] = true, true
			}
		}
	}
	return found, tried
}

// randomMessage is a stand-in for anything else at the mailbox: other
// people's messages and cover messages look like this.
func randomMessage(msgLen int) []byte {
	b := make([]byte, msgLen)
	rand.Read(b)
	return b
}
