package main

import (
	"crypto/rand"
	"errors"
	"math/big"
)

// An ML-KEM ciphertext is easy to tell from random bytes. Its first part, u,
// is k×256 numbers mod q = 3329, each squeezed ("compressed") into 10 bits.
// 3329 values don't share out evenly over 1,024 bit patterns: 257 patterns
// stand for 4 values and 767 for 3, so some patterns turn up a third more
// often than others. Over 768 of them that adds up to strong evidence (see
// distinguish.go).
//
// The Kemeleon encoding (draft-irtf-cfrg-kemeleon; Günther, Stebila and
// Veitch) removes the bias:
//
//   - Each 10-bit pattern is widened back to one of the values mod q it stands
//     for, chosen at random. Since u is (as far as anyone can tell) uniformly
//     random mod q, the widened values are exactly uniform mod q.
//   - The values are written as one big number in base q, which is uniform
//     below q^(k·256). That isn't a power of two, so the top bit would be
//     biased: if the number doesn't fit in the bits below it, the sender
//     starts again with a fresh encapsulation. Re-widening the same
//     ciphertext instead would bias which ciphertexts get sent.
//   - The second part, v (256 numbers in 4 bits), stays compressed: 3329
//     values over 16 patterns are 208 each, except 0, which stands for 209.
//     So each 0 is rejected (start again) one time in 209, which makes the
//     patterns exactly even.
//
// That is the draft's rejection variant (draft-irtf-cfrg-kemeleon-02,
// section 5.1), the most compact: 1,252 bytes for ML-KEM-768. Its default
// never starts again but takes 1,536. The number is written most significant
// byte first with its spare top bits random, as the draft's section 5.1.1
// says; this hasn't been checked against test vectors.
//
// The receiver reads the number back, compresses each value again and gets
// the exact ciphertext, so ML-KEM itself is untouched. The raw ciphertext is
// never sent, and the draft (sections 6.2-6.3) asks that the random choices
// stay secret and fresh: they come from crypto/rand and are used once. It
// also warns that big-number timing can leak them; math/big isn't constant
// time, which a production version would have to deal with.

const (
	kemQ = 3329

	// ML-KEM-768: u is 3×256 values compressed to 10 bits, v is 256 values
	// in 4 bits.
	ct768ULen = 3 * 256 * 10 / 8
	ct768VLen = 256 * 4 / 8
	ct768Len  = ct768ULen + ct768VLen // 1088
	u768Count = 3 * 256

	// kem768Bits is how many bits the base-q number may use: q^768 is
	// 2^8986.27, so numbers below 2^8986 are kept (about 83% of them).
	kem768Bits = 8986
	// kem768ULen is those bits rounded up to whole bytes; the 6 spare bits
	// are random.
	kem768ULen = (kem768Bits + 7) / 8 // 1124
	// Kem768Len is an encoded ML-KEM-768 ciphertext.
	Kem768Len = kem768ULen + ct768VLen // 1252
)

var (
	errKemeleonReject = errors.New("this ciphertext's encoding would be biased: encapsulate again")

	// bins[c] lists the values mod q that compress to the 10-bit pattern c.
	bins = func() [1 << 10][]uint16 {
		var b [1 << 10][]uint16
		for x := range kemQ {
			c := compress10(uint16(x))
			b[c] = append(b[c], uint16(x))
		}
		return b
	}()

	bigQ     = big.NewInt(kemQ)
	limit768 = new(big.Int).Lsh(big.NewInt(1), kem768Bits)
)

// compress10 is FIPS 203's Compress_10: round(1024·x/q) mod 1024, halves
// rounding up.
func compress10(x uint16) uint16 {
	return uint16((uint32(x)<<10+kemQ/2)/kemQ) & 0x3ff
}

// unpack10 reads n 10-bit numbers, least significant bit first (FIPS 203's
// ByteDecode_10).
func unpack10(b []byte, n int) []uint16 {
	out := make([]uint16, n)
	for i := range out {
		bit := i * 10
		v := uint32(b[bit/8]) | uint32(b[bit/8+1])<<8 | uint32(get(b, bit/8+2))<<16
		out[i] = uint16(v>>(bit%8)) & 0x3ff
	}
	return out
}

func get(b []byte, i int) byte {
	if i < len(b) {
		return b[i]
	}
	return 0
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

// widen picks one of the values compressing to c, uniformly at random.
func widen(c uint16) (uint16, error) {
	b := bins[c]
	for {
		var r [1]byte
		if _, err := rand.Read(r[:]); err != nil {
			return 0, err
		}
		if i := int(r[0] & 3); i < len(b) {
			return b[i], nil
		}
	}
}

// kemeleonEncode768 encodes an ML-KEM-768 ciphertext as Kem768Len uniformly
// random-looking bytes, or returns errKemeleonReject (about 23% of the
// time), when the caller must encapsulate again.
func kemeleonEncode768(ct []byte) ([]byte, error) {
	if len(ct) != ct768Len {
		return nil, errors.New("not an ML-KEM-768 ciphertext")
	}
	c := unpack10(ct[:ct768ULen], u768Count)
	n := new(big.Int)
	x := new(big.Int)
	for i := u768Count - 1; i >= 0; i-- {
		w, err := widen(c[i])
		if err != nil {
			return nil, err
		}
		n.Mul(n, bigQ)
		n.Add(n, x.SetUint64(uint64(w)))
	}
	if n.Cmp(limit768) >= 0 {
		return nil, errKemeleonReject
	}
	keep, err := keepV(ct[ct768ULen:])
	if err != nil {
		return nil, err
	}
	if !keep {
		return nil, errKemeleonReject
	}
	out := make([]byte, Kem768Len)
	n.FillBytes(out[:kem768ULen]) // most significant byte first
	var spare [1]byte
	if _, err := rand.Read(spare[:]); err != nil {
		return nil, err
	}
	out[0] |= spare[0] << (kem768Bits % 8) // the 6 spare top bits
	copy(out[kem768ULen:], ct[ct768ULen:])
	return out, nil
}

// keepV decides whether v can be sent as it is: each 4-bit 0 survives with
// probability 208/209, so 0 turns up as often as every other pattern.
func keepV(v []byte) (bool, error) {
	for _, b := range v {
		for _, c := range []byte{b & 15, b >> 4} {
			if c != 0 {
				continue
			}
			r, err := below(vZeroBin)
			if err != nil {
				return false, err
			}
			if r == 0 {
				return false, nil
			}
		}
	}
	return true, nil
}

// vZeroBin is how many values mod q compress to a 4-bit 0: ceil(q/16).
const vZeroBin = (kemQ + 15) / 16

// below returns a uniformly random number below n (at most 256).
func below(n int) (int, error) {
	for {
		var r [1]byte
		if _, err := rand.Read(r[:]); err != nil {
			return 0, err
		}
		if int(r[0]) < 256/n*n {
			return int(r[0]) % n, nil
		}
	}
}

// kemeleonDecode768 reverses kemeleonEncode768. Any Kem768Len bytes decode
// to some ciphertext; ones not made by the encoder simply won't open.
func kemeleonDecode768(enc []byte) ([]byte, error) {
	if len(enc) != Kem768Len {
		return nil, errors.New("bad encoded ciphertext length")
	}
	b := make([]byte, kem768ULen)
	copy(b, enc[:kem768ULen])
	b[0] &= 1<<(kem768Bits%8) - 1
	n := new(big.Int).SetBytes(b)
	c := make([]uint16, u768Count)
	r := new(big.Int)
	for i := range c {
		n.QuoRem(n, bigQ, r)
		c[i] = compress10(uint16(r.Uint64()))
	}
	return append(pack10(c), enc[kem768ULen:]...), nil
}
