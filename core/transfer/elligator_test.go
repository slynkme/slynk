package transfer

import (
	"bytes"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/hex"
	"math/big"
	"slices"
	"testing"

	"filippo.io/edwards25519"
	"filippo.io/edwards25519/field"
)

var (
	bigP = new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 255), big.NewInt(19))
	bigL = func() *big.Int {
		l, _ := new(big.Int).SetString("27742317777372353535851937790883648493", 10)
		return l.Add(l, new(big.Int).Lsh(big.NewInt(1), 252))
	}()
)

func leInt(b []byte) *big.Int {
	be := bytes.Clone(b)
	slices.Reverse(be)
	return new(big.Int).SetBytes(be)
}

func newX25519Key(t *testing.T) []byte {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return k.PublicKey().Bytes()
}

// torsionOrder is the order of P's component of order dividing 8.
func torsionOrder(t *testing.T, p *edwards25519.Point) int {
	t.Helper()
	// [8⁻¹ mod ℓ][8]P is P's prime-order component, so what's left over is
	// the torsion component.
	var eight [32]byte
	eight[0] = 8
	s, err := new(edwards25519.Scalar).SetCanonicalBytes(eight[:])
	if err != nil {
		t.Fatal(err)
	}
	s.Invert(s)
	prime := new(edwards25519.Point).ScalarMult(s, new(edwards25519.Point).MultByCofactor(p))
	tor := new(edwards25519.Point).Subtract(p, prime)
	id := edwards25519.NewIdentityPoint()
	for order, q := 1, tor; order <= 8; order *= 2 {
		if q.Equal(id) == 1 {
			return order
		}
		q = new(edwards25519.Point).Add(q, q)
	}
	t.Fatal("torsion component of order above 8")
	return 0
}

// edwardsFromU returns a point with Montgomery coordinate u.
func edwardsFromU(t *testing.T, u *field.Element) *edwards25519.Point {
	t.Helper()
	var y, den field.Element
	one := new(field.Element).One()
	y.Subtract(u, one)
	y.Multiply(&y, den.Invert(den.Add(u, one)))
	p, err := new(edwards25519.Point).SetBytes(y.Bytes())
	if err != nil {
		t.Fatalf("u %x isn't on the curve", u.Bytes())
	}
	return p
}

func TestElligatorConstants(t *testing.T) {
	c := leInt(cleanScalar)
	if new(big.Int).Mod(c, big.NewInt(8)).Sign() != 0 ||
		new(big.Int).Mod(new(big.Int).Add(c, big.NewInt(1)), bigL).Sign() != 0 {
		t.Error("cleanScalar isn't 0 mod 8 and -1 mod ℓ")
	}
	if c.Bit(254) != 1 || c.BitLen() != 255 {
		t.Error("X25519's clamping would change cleanScalar")
	}

	if !bytes.Equal(elligatorA.Bytes(), new(field.Element).Mult32(new(field.Element).One(), 486662).Bytes()) ||
		leInt(elligatorA.Bytes()).Int64() != 486662 {
		t.Error("A is wrong")
	}

	// torsion8 has order exactly 8, so its multiples are all 8 points of
	// order dividing 8.
	id := edwards25519.NewIdentityPoint()
	var multiples [8]*edwards25519.Point
	multiples[0] = id
	for i := 1; i < 8; i++ {
		multiples[i] = new(edwards25519.Point).Add(multiples[i-1], torsion8)
	}
	if new(edwards25519.Point).MultByCofactor(torsion8).Equal(id) != 1 || multiples[4].Equal(id) == 1 {
		t.Error("torsion8 doesn't have order 8")
	}
	for i := range multiples {
		for j := range i {
			if multiples[i].Equal(multiples[j]) == 1 {
				t.Errorf("[%d]torsion8 = [%d]torsion8", i, j)
			}
		}
	}
}

// elligatorMapBig is RFC 9380's map_to_curve_elligator2 for curve25519,
// written independently with math/big. It returns the u-coordinate and
// whether it's x1 = -A / (1 + 2r²) rather than -x1 - A.
func elligatorMapBig(r *big.Int) (u *big.Int, isX1 bool) {
	p, a := bigP, big.NewInt(486662)
	mod := func(x *big.Int) *big.Int { return x.Mod(x, p) }
	tv1 := mod(new(big.Int).Mul(big.NewInt(2), new(big.Int).Mul(r, r)))
	if tv1.Cmp(new(big.Int).Sub(p, big.NewInt(1))) == 0 {
		tv1.SetInt64(0)
	}
	x1 := new(big.Int).ModInverse(mod(new(big.Int).Add(tv1, big.NewInt(1))), p)
	x1 = mod(x1.Mul(x1, new(big.Int).Neg(a)))
	gx1 := mod(new(big.Int).Add(x1, a))
	gx1 = mod(gx1.Mul(gx1, x1))
	gx1 = mod(gx1.Add(gx1, big.NewInt(1)))
	gx1 = mod(gx1.Mul(gx1, x1))
	if big.Jacobi(gx1, p) >= 0 {
		return x1, true
	}
	return mod(new(big.Int).Sub(new(big.Int).Neg(x1), a)), false
}

func TestElligatorMapMatchesReference(t *testing.T) {
	reps := [][]byte{make([]byte, 32), bytes.Repeat([]byte{0xff}, 32)}
	for range 200 {
		b := make([]byte, 32)
		rand.Read(b)
		reps = append(reps, b)
	}
	for _, rep := range reps {
		u, err := elligatorMap(rep)
		if err != nil {
			t.Fatal(err)
		}
		r := leInt(rep)
		r.SetBit(r, 255, 0).SetBit(r, 254, 0)
		if want, _ := elligatorMapBig(r); leInt(u.Bytes()).Cmp(want) != 0 {
			t.Fatalf("map(%x) = %x, want %x", rep, leInt(u.Bytes()), want)
		}
		// The result is always on the curve, never its twist.
		edwardsFromU(t, u)
	}
}

// RFC 9380 appendix J.4.2 (curve25519_XMD:SHA-512_ELL2_NU_): u[0] and Q.x,
// where Q = map_to_curve(u[0]), as big-endian integers.
func TestElligatorMapRFC9380(t *testing.T) {
	for _, v := range []struct{ u, x string }{
		{"608d892b641f0328523802a6603427c26e55e6f27e71a91a478148d45b5093cd",
			"51125222da5e763d97f3c10fcc92ea6860b9ccbbd2eb1285728f566721c1e65b"},
		{"46f5b22494bfeaa7f232cc8d054be68561af50230234d7d1d63d1d9abeca8da5",
			"7d56d1e08cb0ccb92baf069c18c49bb5a0dcd927eff8dcf75ca921ef7f3e6eeb"},
		{"235fe40c443766ce7e18111c33862d66c3b33267efa50d50f9e8e5d252a40aaa",
			"3fbe66b9c9883d79e8407150e7c2a1c8680bee496c62fabe4619a72b3cabe90f"},
		{"001e92a544463bda9bd04ddbe3d6eed248f82de32f522669efc5ddce95f46f5b",
			"227e0bb89de700385d19ec40e857db6e6a3e634b1c32962f370d26f84ff19683"},
		{"1a68a1af9f663592291af987203393f707305c7bac9c8d63d6a729bdc553dc19",
			"3bcd651ee54d5f7b6013898aab251ee8ecc0688166fce6e9548d38472f6bd196"},
	} {
		u := new(big.Int).SetBytes(mustHex(v.u))
		want := new(big.Int).SetBytes(mustHex(v.x))
		if got, _ := elligatorMapBig(u); got.Cmp(want) != 0 {
			t.Errorf("reference map(%s) = %x, want %s", v.u, got, v.x)
		}
		// The map depends only on u², and a representative is below 2^254,
		// so use whichever of u and -u is.
		if u.Bit(254) == 1 {
			u.Sub(bigP, u)
		}
		rep := make([]byte, 32)
		u.FillBytes(rep)
		slices.Reverse(rep)
		got, err := elligatorMap(rep)
		if err != nil {
			t.Fatal(err)
		}
		if leInt(got.Bytes()).Cmp(want) != 0 {
			t.Errorf("map(%s) = %x, want %s", v.u, leInt(got.Bytes()), v.x)
		}
	}
}

// Every way of hiding a key gives it back exactly. Whether a key can be
// hidden depends only on the torsion point, and the two representatives and
// four top-bit patterns give 8 distinct encodings.
func TestHideRevealEveryPick(t *testing.T) {
	for range 20 {
		enc := newX25519Key(t)
		for tor := range byte(8) {
			reps := map[string]bool{}
			var first *bool
			for _, extra := range []byte{0, 8, 0x40, 0x48, 0x80, 0x88, 0xc0, 0xc8} {
				rep, ok, err := hideKeyWith(enc, tor|extra)
				if err != nil {
					t.Fatal(err)
				}
				if first == nil {
					first = &ok
				} else if ok != *first {
					t.Fatal("whether a key can be hidden depended on more than the torsion point")
				}
				if !ok {
					continue
				}
				reps[string(rep)] = true
				// With extra's top bits clear, this also checks the
				// representative itself is below 2^254.
				if got := rep[31] & 0xc0; got != extra&0xc0 {
					t.Fatalf("top bits %x, want %x", got, extra&0xc0)
				}
				got, err := revealKey(rep)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(got, enc) {
					t.Fatalf("pick %x: revealed %x, want %x", tor|extra, got, enc)
				}
			}
			if *first && len(reps) != 8 {
				t.Fatalf("%d distinct encodings, want 8", len(reps))
			}
		}
	}
}

// The tells that give a plain X25519 key away are gone: the top bit, being on
// the curve rather than its twist, and being in the prime-order subgroup.
func TestHiddenKeysLookRandom(t *testing.T) {
	const n = 1000
	var bitSet [256]int
	onCurve, isX1 := 0, 0
	orders := map[int]int{}
	tries := 0
	for range n {
		var rep []byte
		for {
			tries++
			var ok bool
			var err error
			rep, ok, err = hideKey(newX25519Key(t))
			if err != nil {
				t.Fatal(err)
			}
			if ok {
				break
			}
		}
		for i := range 256 {
			bitSet[i] += int(rep[i/8] >> (i % 8) & 1)
		}
		// Read as a plain X25519 key, it's on the curve only half the time.
		var u, gu field.Element
		u.SetBytes(rep)
		gu.Add(&u, elligatorA)
		gu.Multiply(&gu, &u)
		gu.Add(&gu, new(field.Element).One())
		gu.Multiply(&gu, &u)
		if _, sq := new(field.Element).SqrtRatio(&gu, new(field.Element).One()); sq == 1 {
			onCurve++
		}
		// Either of a point's representatives is sent: one maps through
		// each branch of the map.
		r := leInt(rep)
		if _, x1 := elligatorMapBig(r.SetBit(r, 255, 0).SetBit(r, 254, 0)); x1 {
			isX1++
		}
		// The point it stands for has a uniformly random torsion component.
		m, err := elligatorMap(rep)
		if err != nil {
			t.Fatal(err)
		}
		orders[torsionOrder(t, edwardsFromU(t, m))]++
	}
	// Bounds are about 6 standard deviations wide.
	for i, c := range bitSet {
		if c < n/2-95 || c > n/2+95 {
			t.Errorf("bit %d set %d times in %d", i, c, n)
		}
	}
	if onCurve < n/2-95 || onCurve > n/2+95 {
		t.Errorf("%d of %d look like curve points", onCurve, n)
	}
	if isX1 < n/2-95 || isX1 > n/2+95 {
		t.Errorf("%d of %d map through x1", isX1, n)
	}
	for order, want := range map[int]int{1: n / 8, 2: n / 8, 4: n / 4, 8: n / 2} {
		if c := orders[order]; c < want-95 || c > want+95 {
			t.Errorf("torsion of order %d: %d of %d, want about %d", order, c, n, want)
		}
	}
	if tries < n*3/2 || tries > n*5/2 {
		t.Errorf("%d tries for %d keys, expected about %d", tries, n, 2*n)
	}

	// A plain key always has the tells.
	plain := newX25519Key(t)
	u, _ := new(field.Element).SetBytes(plain)
	if plain[31]&0x80 != 0 || torsionOrder(t, edwardsFromU(t, u)) != 1 {
		t.Error("a plain X25519 key should be in the prime-order subgroup with its top bit clear")
	}
}

// A key's 8 torsion variants can be encoded about 4 at a time, and anyone can
// count them for a sent key. Starting again with a fresh key when one can't
// be encoded gives the same count as random bytes, about 4.5 on average
// (keys with more encodable variants get sent more often). Retrying the
// same key with another torsion point would give about 4.0.
func TestSealRetriesWithFreshKeys(t *testing.T) {
	const n = 1000
	k := testKey(t, 1)
	total := 0
	for range n {
		sealed, err := sealPlaintext(k.Address, []byte("x"), nil)
		if err != nil {
			t.Fatal(err)
		}
		enc, err := revealKey(sealed[:keyRepLen])
		if err != nil {
			t.Fatal(err)
		}
		for tor := range byte(8) {
			if _, ok, err := hideKeyWith(enc, tor); err != nil {
				t.Fatal(err)
			} else if ok {
				total++
			}
		}
	}
	// The standard deviation of the mean is about 0.042.
	if mean := float64(total) / n; mean < 4.25 || mean > 4.75 {
		t.Errorf("mean encodable variants %.3f, want about 4.5", mean)
	}
}

// revealKey copes with any 32 bytes, as anyone can send anything to an inbox.
func TestRevealKeyAnyBytes(t *testing.T) {
	inputs := [][]byte{make([]byte, 32), bytes.Repeat([]byte{0xff}, 32), bytes.Repeat([]byte{0x3f}, 32)}
	for range 500 {
		b := make([]byte, 32)
		rand.Read(b)
		inputs = append(inputs, b)
	}
	for _, in := range inputs {
		enc, err := revealKey(in)
		if err != nil {
			continue
		}
		// Whatever comes out is in the prime-order subgroup.
		u, _ := new(field.Element).SetBytes(enc)
		if torsionOrder(t, edwardsFromU(t, u)) != 1 {
			t.Fatalf("revealKey(%x) has a torsion component", in)
		}
	}
	if _, err := revealKey(make([]byte, 31)); err == nil {
		t.Error("accepted 31 bytes")
	}
}

// Hiding is deterministic given the random byte. Pin its output so the
// encoding can't change by accident.
func TestHideKeyKnownAnswer(t *testing.T) {
	enc := mustHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f") // RFC 7748 6.1, Bob
	for _, c := range []struct {
		pick byte
		rep  string
	}{
		{0x00, "ff0e34241eb8da8edc5f95248d7a468b48ad5bb104eb1689820b50fde32d961b"},
		{0x01, ""}, // this torsion point gives a point with no representative
		{0x08, "8841e5d343b9f0607f5fdc11b277e0acce0119a22e4c33950ba4af7aa498121e"},
		{0xc5, "3ad3c07fac48a181979854238b6881ae608b80bff4c184f5b5cae7a75d961ee9"},
		{0x4e, "bcba4d8a500f4c614cc7505391f001ea644feaedcf70aa230abf8e952cd70540"},
	} {
		rep, ok, err := hideKeyWith(enc, c.pick)
		if err != nil {
			t.Fatal(err)
		}
		got := ""
		if ok {
			got = hex.EncodeToString(rep)
		}
		if got != c.rep {
			t.Errorf("pick %#x: got %q, want %q", c.pick, got, c.rep)
		}
	}
}
