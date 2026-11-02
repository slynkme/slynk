package transfer

import (
	"bytes"
	"crypto/mlkem"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"math/big"
	mrand "math/rand/v2"
	"testing"

	"github.com/pkg/errors"
)

// The draft has no test vectors, so the encoding is checked three ways: its
// pieces against a plain transcription of the draft's pseudocode (section
// 5.1.1, with math/big), the decoder against the lab prototype's independent
// one (lab/pq-inbox), and whole encodings for
// round trips, their rate of success and how random they look.

var bigQ = big.NewInt(kemQ)

// draftVectorEncodeR transcribes VectorEncodeR and IntegerRandomizeUnused:
// r = sum of q^(i-1)·a[i]; fail if msb(r) = 1 (bit b = floor(log2(q^768)));
// to_bytes in network byte order; r_bytes[0] |= rand & (0xFF << (8-x)),
// where x = 8 - (b % 8) unused bits.
func draftVectorEncodeR(a []uint16, rnd byte) ([]byte, bool) {
	r := new(big.Int)
	pow := big.NewInt(1)
	for i := range a {
		r.Add(r, new(big.Int).Mul(pow, big.NewInt(int64(a[i]))))
		pow.Mul(pow, bigQ)
	}
	b := new(big.Int).Exp(bigQ, big.NewInt(int64(len(a))), nil).BitLen() - 1 // floor(log2(q^768))
	if b != kem768Bits {
		panic("b")
	}
	if r.Bit(b) == 1 {
		return nil, false
	}
	x := 8 - b%8
	rBytes := r.FillBytes(make([]byte, (b+x)/8))
	rBytes[0] |= rnd & (0xff << (8 - x) & 0xff)
	return rBytes, true
}

// draftVectorDecodeR transcribes IntegerClearUnused and VectorDecodeR:
// r_bytes[0] &= 0xFF >> x; then a[i] = r % q, r = r // q, k·n times.
func draftVectorDecodeR(rBytes []byte) []uint16 {
	c := bytes.Clone(rBytes)
	x := 8 - kem768Bits%8
	c[0] &= 0xff >> x
	r := new(big.Int).SetBytes(c)
	a := make([]uint16, u768Count)
	m := new(big.Int)
	for i := range a {
		r.QuoRem(r, bigQ, m)
		a[i] = uint16(m.Int64())
	}
	return a
}

// preimages are the values mod q that Compress_10 sends to c.
func preimages(c uint16) []uint16 {
	var out []uint16
	for x := range uint16(kemQ) {
		if compress10(x) == c {
			out = append(out, x)
		}
	}
	return out
}

// fixedRand is a kemRand reading the given bytes, then zeros.
func fixedRand(b ...byte) *kemRand {
	return newKemRand(io0Reader(b))
}

type io0Reader []byte

func (r io0Reader) Read(p []byte) (int, error) {
	n := copy(p, r)
	clear(p[n:])
	return len(p), nil
}

// SamplePreimage picks uniformly among exactly the values that compress to
// c: each of its first draws gives a different one of them.
func TestSamplePreimage10(t *testing.T) {
	sizes := map[int]int{}
	for c := range uint16(1 << 10) {
		want := preimages(c)
		sizes[len(want)]++
		got := map[uint16]bool{}
		for v := range byte(len(want)) {
			x, err := samplePreimage10(c, fixedRand(v))
			if err != nil {
				t.Fatal(err)
			}
			if compress10(x) != c || got[x] {
				t.Fatalf("c=%d: draw %d gave %d", c, v, x)
			}
			got[x] = true
		}
		if len(got) != len(want) {
			t.Fatalf("c=%d: %d values reached, want %d", c, len(got), len(want))
		}
		// A 3-way pick throws away the draw 3 and draws again.
		if len(want) == 3 {
			again, _ := samplePreimage10(c, fixedRand(3|2<<2))
			first, _ := samplePreimage10(c, fixedRand(2))
			if again != first {
				t.Fatalf("c=%d: a redraw didn't use the next 2 bits", c)
			}
		}
	}
	if sizes[4] != 257 || sizes[3] != 767 || len(sizes) != 2 {
		t.Fatalf("bins: %v", sizes)
	}
	if decompress10(0) != 0 || decompress10(1023) != 3326 || compress10(3328) != 0 {
		t.Fatal("compression edges")
	}
}

func testVectors(t *testing.T) [][]uint16 {
	t.Helper()
	rng := mrand.New(mrand.NewPCG(1, 2))
	var vs [][]uint16
	for _, fill := range []uint16{0, 1, kemQ - 1} {
		v := make([]uint16, u768Count)
		for i := range v {
			v[i] = fill
		}
		vs = append(vs, v)
	}
	for range 200 {
		v := make([]uint16, u768Count)
		for i := range v {
			v[i] = uint16(rng.IntN(kemQ))
		}
		vs = append(vs, v)
	}
	// Just below and above the 2^8986 cut-off: the digits of 2^8986 - 1 and
	// 2^8986.
	for _, n := range []*big.Int{
		new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), kem768Bits), big.NewInt(1)),
		new(big.Int).Lsh(big.NewInt(1), kem768Bits),
	} {
		v := make([]uint16, u768Count)
		m := new(big.Int)
		for i := range v {
			n.QuoRem(n, bigQ, m)
			v[i] = uint16(m.Int64())
		}
		vs = append(vs, v)
	}
	return vs
}

func TestKemPackMatchesDraft(t *testing.T) {
	kept := 0
	for i, w := range testVectors(t) {
		spare := byte(i * 37)
		want, wantOK := draftVectorEncodeR(w, spare)
		got, ok := kemPack(w, spare)
		if ok != wantOK {
			t.Fatalf("vector %d: ok %v, draft says %v", i, ok, wantOK)
		}
		if !ok {
			continue
		}
		kept++
		if !bytes.Equal(got, want) {
			t.Fatalf("vector %d: packed differently from the draft", i)
		}
		if back := kemUnpack(got); !equal16(back, w) {
			t.Fatalf("vector %d: didn't unpack to the same digits", i)
		}
	}
	// All q-1 and 2^8986 fail; the rest of the edges pass; about 83% of
	// random vectors do.
	if kept < 160 || kept > 195 {
		t.Fatalf("%d vectors kept", kept)
	}
}

func TestKemUnpackMatchesDraft(t *testing.T) {
	rng := mrand.New(mrand.NewPCG(3, 4))
	inputs := [][]byte{make([]byte, kem768ULen), bytes.Repeat([]byte{0xff}, kem768ULen)}
	for range 200 {
		b := make([]byte, kem768ULen)
		for i := range b {
			b[i] = byte(rng.Uint32())
		}
		inputs = append(inputs, b)
	}
	for i, b := range inputs {
		if !equal16(kemUnpack(b), draftVectorDecodeR(b)) {
			t.Fatalf("input %d: unpacked differently from the draft", i)
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

func counterBytes(label string, n int) []byte {
	var out []byte
	for i := uint32(0); len(out) < n; i++ {
		var b [4]byte
		binary.BigEndian.PutUint32(b[:], i)
		h := sha256.Sum256(append([]byte(label), b[:]...))
		out = append(out, h[:]...)
	}
	return out[:n]
}

// Pinned from the lab prototype's decoder (lab/pq-inbox/kemeleon.go, its own
// math/big code), 2026-10-18: the same bytes must decode to the same
// ciphertexts.
func TestKemeleonDecodeMatchesLab(t *testing.T) {
	for _, c := range []struct {
		name string
		in   []byte
		want string // SHA-256 of the ciphertext
	}{
		{"zeros", make([]byte, Kem768Len), "0e40a09dd6c3d8b503c0095444488c25f0fa19356ddd9b77a16219cb1cec69e6"},
		{"ones", bytes.Repeat([]byte{0xff}, Kem768Len), "86b8e02dce718aa36b05979039c7f3dc8ea155946558cb883658befbb50d88b8"},
		{"counter", counterBytes("kemeleon decode vector", Kem768Len), "4556665a906cf7475df20294cdbf5be3ca47241d6c78e9b5462a1f1e03cd7e67"},
	} {
		ct, err := kemeleonDecode768(c.in)
		if err != nil {
			t.Fatal(err)
		}
		if h := sha256.Sum256(ct); hex.EncodeToString(h[:]) != c.want {
			t.Errorf("%s decodes to %x", c.name, h)
		}
	}
}

func TestPack10(t *testing.T) {
	rng := mrand.New(mrand.NewPCG(5, 6))
	c := make([]uint16, u768Count)
	for i := range c {
		c[i] = uint16(rng.IntN(1 << 10))
	}
	b := pack10(c)
	if len(b) != ct768ULen || !equal16(unpack10(b, u768Count), c) {
		t.Fatal("pack10 and unpack10 don't round-trip")
	}
	// FIPS 203's ByteEncode_10: least significant bit first.
	if got := pack10([]uint16{0x3ff, 0, 1, 0x200}); hex.EncodeToString(got) != "ff03100080" {
		t.Fatalf("pack10 = %x", got)
	}
}

// Real ciphertexts survive encoding and decoding exactly, about 77% of
// encodings succeed (the draft's Table 2), and a failure is a fresh
// encapsulation's job, never the same ciphertext's.
func TestKemeleonRoundTrip(t *testing.T) {
	dk, err := mlkem.GenerateKey768()
	if err != nil {
		t.Fatal(err)
	}
	const n = 2000
	ok := 0
	for range n {
		key, ct := dk.EncapsulationKey().Encapsulate()
		enc, err := kemeleonEncode768(ct)
		if errors.Is(err, errKemeleonReject) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		ok++
		if len(enc) != Kem768Len {
			t.Fatalf("encoded %d bytes", len(enc))
		}
		back, err := kemeleonDecode768(enc)
		if err != nil || !bytes.Equal(back, ct) {
			t.Fatal("didn't decode to the same ciphertext")
		}
		if again, err := dk.Decapsulate(back); err != nil || !bytes.Equal(again, key) {
			t.Fatal("the decoded ciphertext doesn't give the same key")
		}
		if !bytes.Equal(enc[kem768ULen:], ct[ct768ULen:]) {
			t.Fatal("v isn't sent as it is")
		}
	}
	if rate := float64(ok) / n; math.Abs(rate-0.77) > 0.04 {
		t.Fatalf("%.3f of encodings succeeded, want about 0.77", rate)
	}
	if _, err := kemeleonEncode768(make([]byte, ct768Len-1)); err == nil {
		t.Fatal("encoded a short ciphertext")
	}
	if _, err := kemeleonDecode768(make([]byte, Kem768Len+1)); err == nil {
		t.Fatal("decoded a long encoding")
	}
}

// v's 0s fail the encoding one time in 209: with every coefficient 0, about
// (208/209)^256 = 29% of tries survive that rule alone.
func TestKemeleonZeroRule(t *testing.T) {
	ct := make([]byte, ct768Len) // u all 0s and v all 0s
	ok := 0
	const n = 3000
	for range n {
		if _, err := kemeleonEncode768(ct); err == nil {
			ok++
		}
	}
	// u all 0 widens to values in {3328, 0, 1}, whose number is often over
	// the cut-off: measure the cut-off's share alone with v nonzero.
	ct2 := bytes.Clone(ct)
	for i := ct768ULen; i < ct768Len; i++ {
		ct2[i] = 0x11
	}
	ok2 := 0
	for range n {
		if _, err := kemeleonEncode768(ct2); err == nil {
			ok2++
		}
	}
	want := math.Pow(208.0/209, 256)
	if got := float64(ok) / float64(ok2); math.Abs(got-want) > 0.05 {
		t.Fatalf("the zero rule kept %.3f, want about %.3f", got, want)
	}
}

// llrMLKEM768 is the best simple test for "is this an ML-KEM-768 ciphertext,
// or random bytes?": the log-likelihood ratio of its 768 ten-bit u patterns
// (lab/pq-inbox/distinguish.go). A pattern standing for 4 values mod q is
// 4·1024/3329 ≈ 1.23 times likelier in a ciphertext than in random bytes.
func llrMLKEM768(b []byte) float64 {
	var s float64
	for _, c := range unpack10(b[:ct768ULen], u768Count) {
		s += math.Log(float64(len(preimageCount[c])) * 1024 / kemQ)
	}
	return s
}

var preimageCount = func() (t [1 << 10][]uint16) {
	for c := range t {
		t[c] = preimages(uint16(c))
	}
	return t
}()

// fours counts the u patterns standing for 4 values mod q, all that
// llrMLKEM768 depends on. In random bytes each one does with probability
// 257/1024 (TestSamplePreimage10's bins).
func fours(b []byte) (k int) {
	for _, c := range unpack10(b[:ct768ULen], u768Count) {
		if len(preimageCount[c]) == 4 {
			k++
		}
	}
	return k
}

// binomialPMF is the probability that a Binomial(n, p) count is k.
func binomialPMF(n, k int, p float64) float64 {
	a, _ := math.Lgamma(float64(n + 1))
	b, _ := math.Lgamma(float64(k + 1))
	c, _ := math.Lgamma(float64(n - k + 1))
	return math.Exp(a - b - c + float64(k)*math.Log(p) + float64(n-k)*math.Log1p(-p))
}

// binomialRange returns the counts lo..hi that a Binomial(n, p) count falls
// outside by chance with probability at most alpha (at most alpha/2 each
// side), adding up the exact probabilities from each end. Counts less likely
// than 10^-30 each are left out: together they're far too small to matter.
func binomialRange(n int, p, alpha float64) (lo, hi int) {
	lo = int(float64(n+1) * p) // the most likely count
	hi = lo
	for lo > 0 && binomialPMF(n, lo-1, p) > 1e-30 {
		lo--
	}
	for hi < n && binomialPMF(n, hi+1, p) > 1e-30 {
		hi++
	}
	for tail := binomialPMF(n, lo, p); tail <= alpha/2; tail += binomialPMF(n, lo, p) {
		lo++
	}
	for tail := binomialPMF(n, hi, p); tail <= alpha/2; tail += binomialPMF(n, hi, p) {
		hi--
	}
	return lo, hi
}

// Encodings look random: the likelihood test flags raw ciphertexts nearly
// always and encodings (read as if they were ciphertexts) as often as random
// bytes, their patterns all together look like random bytes' too, their
// digits mod q are as spread out as random ones, and every bit position is
// balanced.
//
// Each run draws a fresh sample, so each bound comes from the exact binomial
// distribution, set so that a correct encoder falls outside it by bad luck
// with probability under 10^-8: the test fails by chance about once in 30
// million runs. Its first bounds, 6 standard deviations and "within n/50 of
// the random bytes" over 1,500 encodings, failed about once in 220 runs;
// over 3,000, any bias they caught at least one time in 12, these catch at
// least as often. A fixed seed wouldn't fix that, only hide it: any change in
// how randomness is drawn would deal a new sample with the same odds.
func TestKemeleonLooksRandom(t *testing.T) {
	dk, err := mlkem.GenerateKey768()
	if err != nil {
		t.Fatal(err)
	}
	const n = 3000
	const p4 = 257.0 / 1024
	var rawFlagged, encFlagged, randFlagged, encFours, encPlain int
	ones := make([]int, Kem768Len*8)
	rng := mrand.New(mrand.NewPCG(7, 8))
	for i := 0; i < n; {
		_, ct := dk.EncapsulationKey().Encapsulate()
		enc, err := kemeleonEncode768(ct)
		if err != nil {
			continue
		}
		i++
		if llrMLKEM768(ct) > 0 {
			rawFlagged++
		}
		if llrMLKEM768(enc) > 0 {
			encFlagged++
		}
		encFours += fours(enc)
		for _, x := range kemUnpack(enc) {
			if decompress10(compress10(x)) == x {
				encPlain++
			}
		}
		rb := make([]byte, ct768Len)
		for j := range rb {
			rb[j] = byte(rng.Uint32())
		}
		if llrMLKEM768(rb) > 0 {
			randFlagged++
		}
		for j, b := range enc {
			for k := range 8 {
				ones[j*8+k] += int(b >> k & 1)
			}
		}
	}
	// A ciphertext's patterns stand for 4 values with probability 1028/3329,
	// so it's flagged 96% of the time: 90% is beyond chance's reach.
	if rawFlagged < n*9/10 {
		t.Fatalf("the test flagged only %d of %d raw ciphertexts", rawFlagged, n)
	}
	// Random bytes are flagged when fours > 214, with probability pFlag ≈
	// 0.036. Theirs come from a fixed seed, so their count never changes: it
	// checks pFlag itself.
	a, b := math.Log(4*1024.0/kemQ), math.Log(3*1024.0/kemQ)
	pFlag := 0.0
	for k := range u768Count + 1 {
		if float64(k)*a+float64(u768Count-k)*b > 0 {
			pFlag += binomialPMF(u768Count, k, p4)
		}
	}
	lo, hi := binomialRange(n, pFlag, 1e-8)
	if encFlagged < lo || encFlagged > hi || randFlagged < lo || randFlagged > hi {
		t.Fatalf("encodings flagged %d times and random bytes %d, want %d to %d", encFlagged, randFlagged, lo, hi)
	}
	// All the encodings' patterns together catch a far smaller bias either
	// way than the flags do.
	lo, hi = binomialRange(n*u768Count, p4, 1e-8)
	if encFours < lo || encFours > hi {
		t.Fatalf("%d of the encodings' %d patterns stand for 4 values, want %d to %d", encFours, n*u768Count, lo, hi)
	}
	// Decoded, an encoding's digits are uniform mod q, so 1,024 in 3,329 of
	// them are the very value Decompress_10 gives for their pattern. Without
	// the widening every one would be, though the encoding would still
	// round-trip and its bits still look balanced.
	lo, hi = binomialRange(n*u768Count, 1024.0/kemQ, 1e-8)
	if encPlain < lo || encPlain > hi {
		t.Fatalf("%d of the encodings' %d digits are Decompress_10's own, want %d to %d", encPlain, n*u768Count, lo, hi)
	}
	// Each bit is 1 half the time, the 10^-8 shared among the 10,016 bits.
	lo, hi = binomialRange(n, 0.5, 1e-8/float64(len(ones)))
	for j, c := range ones {
		if c < lo || c > hi {
			t.Fatalf("bit %d was 1 in %d of %d encodings, want %d to %d", j, c, n, lo, hi)
		}
	}
}
