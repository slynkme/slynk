package main

import "math"

// llrMLKEM768 is the best simple test for "is this 1088-byte string an
// ML-KEM-768 ciphertext, or random bytes?": the log-likelihood ratio of its
// 768 ten-bit u patterns under the two hypotheses. A pattern that stands for
// 4 values mod q is 4·1024/3329 ≈ 1.23 times likelier in a ciphertext than in
// random bytes; one that stands for 3 is ≈ 0.92 times as likely. Positive
// means "ciphertext". (v adds almost nothing and is ignored.)
func llrMLKEM768(b []byte) float64 {
	var s float64
	for _, c := range unpack10(b[:ct768ULen], u768Count) {
		s += llrTable[c]
	}
	return s
}

var llrTable = func() [1 << 10]float64 {
	var t [1 << 10]float64
	for c := range t {
		t[c] = math.Log(float64(len(bins[c])) * 1024 / kemQ)
	}
	return t
}()

// klPerPattern is the expected evidence per u pattern, in nats, for a real
// ciphertext: the Kullback-Leibler divergence of the pattern distribution
// from uniform.
func klPerPattern() float64 {
	var s float64
	for c := range bins {
		p := float64(len(bins[c])) / kemQ
		s += p * math.Log(p*1024)
	}
	return s
}

// klV is the same for v's 4-bit patterns, which the encoding keeps.
func klV() float64 {
	counts := make([]int, 16)
	for x := range kemQ {
		counts[(uint32(x)<<4+kemQ/2)/kemQ&15]++
	}
	var s float64
	for _, n := range counts {
		p := float64(n) / kemQ
		s += p * math.Log(p*16)
	}
	return s
}
