// Copied from core/transfer/elligator.go (unchanged apart from the package
// name and this note), so the lab can encode the X25519 half of a hybrid
// notice the way today's notices are encoded. The core's copy is the
// reference.
package main

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"sync"

	"filippo.io/edwards25519"
	"filippo.io/edwards25519/field"
	"github.com/pkg/errors"
)

// A sealed notice starts with HPKE's one-time X25519 public key. Sent as is,
// that key is easy to tell from random bytes: its top bit is always clear, it
// is always a point on the curve (not its twist), and always in the curve's
// prime-order subgroup. Elligator 2 (Bernstein, Hamburg, Krasnova and Lange,
// 2013; RFC 9380 section 6.7.1 for the map) writes it as 32 bytes that look
// random instead:
//
//   - The sender adds a random point of order dividing 8 to the key, so it
//     looks like a random point anywhere on the curve, not just in the
//     prime-order subgroup.
//   - About half of all points have a representative: a field element r with
//     map(r) = the point. If this one doesn't, the sender starts again with a
//     fresh key.
//   - The sender picks one of the point's two representatives at random and
//     fills the two unused top bits with random bits.
//
// The owner maps the 32 bytes back to the point and multiplies it by a scalar
// that is 0 mod 8 and -1 mod the group order. That removes the added point
// and gives back HPKE's key exactly, so stdlib HPKE does the rest.
//
// None of this touches a private key. The random choices are what hide the
// key, so they come from crypto/rand, are used once and are applied in
// constant time.

// keyRepLen is the size of an encoded key.
const keyRepLen = 32

var (
	// elligatorA is Curve25519's Montgomery coefficient A; Elligator 2 uses
	// the non-square Z = 2.
	elligatorA = new(field.Element).Mult32(new(field.Element).One(), 486662)

	// torsion8 is a point of order 8. Its multiples are all the points of
	// order dividing 8.
	torsion8 = mustPoint("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05")

	// cleanScalar is 5ℓ-1 (ℓ is the prime group order), little-endian. It is
	// 0 mod 8 and -1 mod ℓ, so it maps P+T to -P for any P in the prime-order
	// subgroup and T of order dividing 8; -P has the same u-coordinate as P.
	// Bit 254 is set and bits 255 and 0-2 clear, so X25519's clamping leaves
	// it unchanged.
	cleanScalar = mustHex("a023cdd083ef5bb82f10d62e59e15a6800000000000000000000000000000050")

	// cleanKey is cleanScalar as an X25519 key, made once: making one also
	// computes its public key, which costs as much as using it.
	cleanKey = sync.OnceValues(func() (*ecdh.PrivateKey, error) {
		return ecdh.X25519().NewPrivateKey(cleanScalar)
	})
)

func mustPoint(s string) *edwards25519.Point {
	p, err := new(edwards25519.Point).SetBytes(mustHex(s))
	if err != nil {
		panic(err)
	}
	return p
}

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// hideKey encodes an X25519 public key (HPKE's enc) as 32 random-looking
// bytes. ok is false, about half the time, when this key can't be encoded;
// the caller then tries again with a fresh key. Trying again with the same key
// and a different torsion point would bias which points get sent.
func hideKey(enc []byte) (rep []byte, ok bool, err error) {
	var pick [1]byte // bits 0-2: torsion point; 3: which representative; 6-7: top bits
	if _, err := rand.Read(pick[:]); err != nil {
		return nil, false, err
	}
	return hideKeyWith(enc, pick[0])
}

func hideKeyWith(enc []byte, pick byte) (rep []byte, ok bool, err error) {
	if len(enc) != keyRepLen {
		return nil, false, errors.New("bad key length")
	}
	// Montgomery u to Edwards y = (u-1)/(u+1). Either sign of x will do: only
	// the result's u-coordinate is used, and -P plus a uniformly random
	// torsion point gives the same u-coordinates as P plus one.
	var u, y, den field.Element
	if _, err := u.SetBytes(enc); err != nil {
		return nil, false, err
	}
	one := new(field.Element).One()
	y.Subtract(&u, one)
	y.Multiply(&y, den.Invert(den.Add(&u, one)))
	p, err := new(edwards25519.Point).SetBytes(y.Bytes())
	if err != nil {
		return nil, false, errors.New("key isn't on the curve")
	}
	// [pick&7]torsion8, by a constant-time multiplication, not a table
	// lookup.
	var k [32]byte
	k[0] = pick & 7
	s, err := new(edwards25519.Scalar).SetCanonicalBytes(k[:])
	if err != nil {
		return nil, false, err
	}
	dirty := new(edwards25519.Point).ScalarMult(s, torsion8)
	dirty.Add(dirty, p)
	if _, err := u.SetBytes(dirty.BytesMontgomery()); err != nil {
		return nil, false, err
	}

	// A point (u, v) with u ≠ 0, -A has representatives exactly when
	// -2u(u+A) is a square. Its two representatives are
	// sqrt(-u / (2(u+A))) and sqrt(-(u+A) / (2u)): one maps to (u, v), the
	// other to (u, -v). map(r) = map(-r), so r is swapped for -r when it
	// doesn't fit in 254 bits.
	var uA, num, div, num2, div2, neg field.Element
	uA.Add(&u, elligatorA)
	zero := new(field.Element)
	if u.Equal(zero) == 1 || uA.Equal(zero) == 1 {
		return nil, false, nil
	}
	second := int(pick >> 3 & 1)
	num.Negate(&u)
	div.Add(&uA, &uA)
	num2.Negate(&uA)
	div2.Add(&u, &u)
	num.Select(&num2, &num, second)
	div.Select(&div2, &div, second)
	r, isSquare := new(field.Element).SqrtRatio(&num, &div)
	if isSquare == 0 {
		return nil, false, nil
	}
	r.Select(neg.Negate(r), r, int(r.Bytes()[31]>>6&1))
	rep = r.Bytes()
	rep[31] |= pick & 0xc0
	return rep, true, nil
}

// revealKey maps 32 bytes back to the X25519 public key they hide. Any 32
// bytes map to some point; ones that weren't made by hideKey give a key that
// simply won't open the notice.
func revealKey(rep []byte) ([]byte, error) {
	if len(rep) != keyRepLen {
		return nil, errors.New("bad key length")
	}
	u, err := elligatorMap(rep)
	if err != nil {
		return nil, err
	}
	// Remove the torsion point the sender added.
	sk, err := cleanKey()
	if err != nil {
		return nil, err
	}
	pk, err := ecdh.X25519().NewPublicKey(u.Bytes())
	if err != nil {
		return nil, err
	}
	return sk.ECDH(pk) // fails for points of small order
}

// elligatorMap maps a representative to its point's u-coordinate, ignoring
// the top two bits.
func elligatorMap(rep []byte) (*field.Element, error) {
	b := bytes.Clone(rep)
	b[31] &= 0x3f
	r, err := new(field.Element).SetBytes(b)
	if err != nil {
		return nil, err
	}

	// Elligator 2 (RFC 9380 6.7.1, Z = 2): x1 = -A / (1 + 2r²), which is never
	// a division by zero because -1/2 isn't a square. The point is x1 if
	// x1³ + Ax1² + x1 is a square, otherwise -x1 - A. The v-coordinate isn't
	// needed: X25519 works on u alone.
	var t, x1, gx1, x2, u field.Element
	one := new(field.Element).One()
	t.Square(r)
	t.Add(&t, &t)
	t.Add(&t, one)
	x1.Negate(elligatorA)
	x1.Multiply(&x1, t.Invert(&t))
	gx1.Add(&x1, elligatorA)
	gx1.Multiply(&gx1, &x1)
	gx1.Add(&gx1, one)
	gx1.Multiply(&gx1, &x1)
	_, onCurve := new(field.Element).SqrtRatio(&gx1, one)
	x2.Negate(&x1)
	x2.Subtract(&x2, elligatorA)
	return u.Select(&x1, &x2, onCurve), nil
}
