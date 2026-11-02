package transfer

import (
	"bytes"
	"crypto/rand"
	"io"
	"math/big"
	"math/bits"

	"github.com/pkg/errors"
)

// An ML-KEM ciphertext is easy to tell from random bytes. Its first part, u,
// is k×256 numbers mod q = 3329, each squeezed ("compressed") into 10 bits.
// 3329 values don't share out evenly over 1,024 bit patterns: 257 patterns
// stand for 4 values and 767 for 3, so some patterns turn up a third more
// often than others, and over 768 of them that's strong evidence. The second
// part, v, is 256 numbers in 4 bits, where 0 stands for 209 values and every
// other pattern for 208.
//
// Kemeleon (draft-irtf-cfrg-kemeleon-02, Günther, Stebila and Veitch, from
// their "Obfuscated Key Exchange", CCS 2024) removes the bias. This is the
// draft's rejection variant, section 5.1, Kemeleon.EncodeCtxtR and
// DecodeCtxtR with the helpers of section 5.1.1, for ML-KEM-768:
//
//   - Each 10-bit pattern of u is widened back to one of the values mod q it
//     stands for, chosen at random (SamplePreimage, section 4.1). u is, as
//     far as anyone can tell, uniformly random mod q, so the widened values
//     are exactly uniform mod q.
//   - The values are read as one big number in base q, the first value the
//     least significant digit (VectorEncodeR). It's uniform below q^768,
//     which isn't a power of two: if it doesn't fit in floor(log2(q^768)) =
//     8,986 bits, the encoding fails and the sender encapsulates again.
//   - v stays as it is, but each of its 0s fails the encoding one time in
//     ceil(q/16) = 209, which makes its patterns exactly even.
//   - The number is written in 1,124 bytes, most significant byte first,
//     with the 6 bits above its 8,986 random (IntegerRandomizeUnused), then
//     v's 128 bytes: 1,252 in all (the draft's Table 2), against ML-KEM's
//     1,088.
//
// A failed encoding must start again from a fresh encapsulation: encoding
// the same ciphertext again would bias which ciphertexts get sent. About 77%
// of encodings succeed. The receiver reads the number back, compresses each
// value again and gets the exact ciphertext, so ML-KEM itself is untouched.
//
// The draft asks that the encoding's random choices stay secret (section
// 6.2: someone who knew them could re-encode a decoded string and compare)
// and warns that big-number arithmetic can leak through timing (6.3). They
// come from crypto/rand and are used once, and the arithmetic here works on
// fixed-size words in the same steps whatever the values (kemPack). Choosing
// among 3 values can take another draw, which only depends on random bits
// that are thrown away. Decoding works on public bytes, so it needn't be
// constant time. Only the encoding's own pages run any of this, never the
// network, which sees when a round goes, not how long the sealing took.
//
// The draft has no test vectors (none were published as of 2026-10-18), so
// kemeleon_test.go checks this against a plain transcription of the draft's
// pseudocode and the lab prototype's independent decoder. Its byte order is
// -02's; an open issue on the draft (#17) asks for the integer's byte order
// to be pinned down, and a later revision might change it. Either order is
// uniformly random, and only Slynk reads Slynk's notices, so nothing would
// need to follow.

const (
	kemQ = 3329

	// ML-KEM-768: u is 3×256 values compressed to 10 bits (d_u), v is 256
	// values in 4 bits (d_v).
	ct768ULen = 3 * 256 * 10 / 8
	ct768VLen = 256 * 4 / 8
	ct768Len  = ct768ULen + ct768VLen // 1088
	u768Count = 3 * 256

	// kem768Bits is floor(log2(q^768)): numbers below 2^8986 are kept.
	kem768Bits = 8986
	// kem768ULen is those bits in whole bytes; the 6 spare bits are random.
	kem768ULen = (kem768Bits + 7) / 8 // 1124
	// Kem768Len is an encoded ML-KEM-768 ciphertext.
	Kem768Len = kem768ULen + ct768VLen // 1252

	// vZeroBin is how many values mod q compress to a 4-bit 0: ceil(q/16).
	vZeroBin = (kemQ + 15) / 16

	// The number is built in kemLimbs 64-bit words, least significant first,
	// and built and taken apart kemGroup base-q digits (one word) at a time.
	kemLimbs = (kem768Bits + 1 + 63) / 64 // 141: room for anything below q^768
	kemGroup = 5
	kemQ5    = uint64(kemQ) * kemQ * kemQ * kemQ * kemQ // q^5 < 2^59
)

var errKemeleonReject = errors.New("this ciphertext's encoding would be biased: encapsulate again")

// compress10 is FIPS 203's Compress_10: round(1024·x/q) mod 1024, halves
// rounding up.
func compress10(x uint16) uint16 {
	return uint16((uint32(x)<<10+kemQ/2)/kemQ) & 0x3ff
}

// decompress10 is FIPS 203's Decompress_10: round(q·y/1024), halves rounding
// up.
func decompress10(y uint16) uint16 {
	return uint16((uint32(y)*kemQ + 512) >> 10)
}

// unpack10 reads n 10-bit numbers, least significant bit first (FIPS 203's
// ByteDecode_10).
func unpack10(b []byte, n int) []uint16 {
	out := make([]uint16, n)
	for i := range out {
		bit := i * 10
		v := uint32(b[bit/8]) | uint32(b[bit/8+1])<<8
		if bit/8+2 < len(b) {
			v |= uint32(b[bit/8+2]) << 16
		}
		out[i] = uint16(v>>(bit%8)) & 0x3ff
	}
	return out
}

// pack10 is unpack10's inverse (ByteEncode_10).
func pack10(c []uint16) []byte {
	out := make([]byte, len(c)*10/8)
	for i, v := range c {
		bit := i * 10
		w := uint32(v) << (bit % 8)
		out[bit/8] |= byte(w)
		out[bit/8+1] |= byte(w >> 8)
		if bit/8+2 < len(out) {
			out[bit/8+2] |= byte(w >> 16)
		}
	}
	return out
}

// kemRandBuf is how many random bytes kemRand reads at a time: about twice
// what an encoding uses.
const kemRandBuf = 512

// kemRand hands out random bits from crypto/rand (or, in tests, another
// reader), a buffer at a time.
type kemRand struct {
	src  io.Reader
	buf  [kemRandBuf]byte
	at   int
	bits uint // bits left in cur
	cur  byte
}

func newKemRand(src io.Reader) *kemRand {
	return &kemRand{src: src, at: kemRandBuf}
}

func (r *kemRand) byte() (byte, error) {
	if r.at == len(r.buf) {
		if _, err := io.ReadFull(r.src, r.buf[:]); err != nil {
			return 0, err
		}
		r.at = 0
	}
	b := r.buf[r.at]
	r.at++
	return b, nil
}

// two returns 2 random bits.
func (r *kemRand) two() (byte, error) {
	if r.bits == 0 {
		b, err := r.byte()
		if err != nil {
			return 0, err
		}
		r.cur, r.bits = b, 8
	}
	v := r.cur & 3
	r.cur >>= 2
	r.bits -= 2
	return v, nil
}

// samplePreimage10 is the draft's SamplePreimage(10, u, c) (section 4.1) for
// u = Decompress_10(c): one of the values mod q that compress to c, uniformly
// at random. They're u-1..u+1, plus u+2 or u-2 when that compresses to c too.
func samplePreimage10(c uint16, r *kemRand) (uint16, error) {
	u := int(decompress10(c))
	low, n := -1, 3 // rand <--$ {-1, 0, 1}
	switch {
	case compress10(uint16((u+2)%kemQ)) == c:
		low, n = -1, 4 // {-1, 0, 1, 2}
	case compress10(uint16((u-2+kemQ)%kemQ)) == c:
		low, n = -2, 4 // {-2, -1, 0, 1}
	}
	for {
		v, err := r.two()
		if err != nil {
			return 0, err
		}
		if int(v) < n {
			return uint16((u + low + int(v) + kemQ) % kemQ), nil
		}
	}
}

// below returns a uniformly random number below n (at most 256).
func (r *kemRand) below(n int) (int, error) {
	for {
		b, err := r.byte()
		if err != nil {
			return 0, err
		}
		if int(b) < 256/n*n {
			return int(b) % n, nil
		}
	}
}

// kemPack is VectorEncodeR and IntegerRandomizeUnused (section 5.1.1): the
// widened values w as one base-q number, least significant digit first,
// written in kem768ULen bytes, most significant first, with spare's top bits
// in the bits above kem768Bits. ok is false when the number needs bit
// kem768Bits (msb(r) = 1). Every value of w takes the same steps.
func kemPack(w []uint16, spare byte) (out []byte, ok bool) {
	var n [kemLimbs]uint64
	// Most significant digits first: the top group holds what's left over
	// after whole groups of kemGroup.
	top := len(w) % kemGroup
	if top == 0 {
		top = kemGroup
	}
	for end := len(w); end > 0; {
		start := end - kemGroup
		mul := kemQ5
		if end == len(w) {
			start = end - top
			mul = 1
			for range top {
				mul *= kemQ
			}
		}
		var d uint64
		for i := end - 1; i >= start; i-- {
			d = d*kemQ + uint64(w[i])
		}
		carry := d
		for j := range n {
			hi, lo := bits.Mul64(n[j], mul)
			var c uint64
			n[j], c = bits.Add64(lo, carry, 0)
			carry = hi + c
		}
		end = start
	}
	ok = n[kem768Bits/64]>>(kem768Bits%64) == 0
	out = make([]byte, kem768ULen)
	for k := range out {
		out[kem768ULen-1-k] = byte(n[k/8] >> (8 * (k % 8)))
	}
	out[0] |= spare &^ (0xff >> (8 - kem768Bits%8))
	return out, ok
}

// kemUnpack is IntegerClearUnused and VectorDecodeR: the base-q digits of the
// number in b, least significant first, with the bits above kem768Bits
// ignored. Any bytes give some digits. They're public, so math/big will do,
// kemGroup digits at a time.
func kemUnpack(b []byte) []uint16 {
	c := bytes.Clone(b[:kem768ULen])
	c[0] &= 0xff >> (8 - kem768Bits%8)
	n := new(big.Int).SetBytes(c)
	q5 := new(big.Int).SetUint64(kemQ5)
	m := new(big.Int)
	w := make([]uint16, u768Count)
	for i := 0; i < u768Count; i += kemGroup {
		n.QuoRem(n, q5, m)
		rem := m.Uint64()
		for t := i; t < i+kemGroup && t < u768Count; t++ {
			w[t] = uint16(rem % kemQ)
			rem /= kemQ
		}
	}
	return w
}

// kemeleonEncode768 encodes an ML-KEM-768 ciphertext as Kem768Len uniformly
// random-looking bytes, or returns errKemeleonReject (about 23% of the
// time), when the caller must encapsulate again.
func kemeleonEncode768(ct []byte) ([]byte, error) {
	return kemeleonEncode768With(ct, rand.Reader)
}

func kemeleonEncode768With(ct []byte, src io.Reader) ([]byte, error) {
	if len(ct) != ct768Len {
		return nil, errors.New("not an ML-KEM-768 ciphertext")
	}
	r := newKemRand(src)
	c := unpack10(ct[:ct768ULen], u768Count)
	w := make([]uint16, u768Count)
	for i, ci := range c {
		var err error
		if w[i], err = samplePreimage10(ci, r); err != nil {
			return nil, err
		}
	}
	spare, err := r.byte()
	if err != nil {
		return nil, err
	}
	enc, ok := kemPack(w, spare)
	// Each 0 in v fails the encoding with probability 1/209, drawn whether
	// or not the number already failed, so the draws don't depend on it.
	for _, b := range ct[ct768ULen:] {
		for _, x := range [2]byte{b & 15, b >> 4} {
			if x != 0 {
				continue
			}
			d, err := r.below(vZeroBin)
			if err != nil {
				return nil, err
			}
			if d == 0 {
				ok = false
			}
		}
	}
	if !ok {
		return nil, errKemeleonReject
	}
	return append(enc, ct[ct768ULen:]...), nil
}

// kemeleonDecode768 reverses kemeleonEncode768. Any Kem768Len bytes decode
// to some ciphertext; ones not made by the encoder simply won't open.
func kemeleonDecode768(enc []byte) ([]byte, error) {
	if len(enc) != Kem768Len {
		return nil, errors.New("bad encoded ciphertext length")
	}
	w := kemUnpack(enc[:kem768ULen])
	c := make([]uint16, u768Count)
	for i, x := range w {
		c[i] = compress10(x)
	}
	return append(pack10(c), enc[kem768ULen:]...), nil
}
