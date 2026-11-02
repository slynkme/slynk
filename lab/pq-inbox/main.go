// Command pq-inbox measures what a quantum-safe inbox notice would cost:
// the real size of a cMix message, what each candidate leaves for text, how
// long sealing and opening take (run it natively, and as WebAssembly under
// Node to see a browser's speed), and whether the pieces look random. It
// works offline and never touches the network. See README.md.
package main

import (
	"crypto/mlkem"
	"crypto/rand"
	"encoding/base64"
	"flag"
	"fmt"
	"math"
	"runtime"
	"sort"
	"time"

	"gitlab.com/elixxir/primitives/format"
)

func main() {
	samples := flag.Int("n", 2000, "samples for the randomness checks")
	flag.Parse()
	fmt.Printf("pq-inbox lab, %s/%s, %s\n\n", runtime.GOOS, runtime.GOARCH, runtime.Version())

	pieceSizes()
	candidates()
	addresses()
	timings()
	randomness(*samples)
}

// mainnetPrimeBytes is the mainnet cMix group's prime: 4096 bits (read from
// the signed NDF, 2026-10-13).
const mainnetPrimeBytes = 512

func pieceSizes() {
	m := format.NewMessage(mainnetPrimeBytes)
	contents := m.ContentsSize()
	fmt.Println("## One cMix message on mainnet")
	fmt.Printf("whole message:              %d bytes (two %d-byte payloads)\n", 2*mainnetPrimeBytes, mainnetPrimeBytes)
	fmt.Printf("contents (what Slynk fills): %d bytes\n", contents)
	fmt.Printf("key fingerprint + MAC:      %d + %d bytes, top bit of each fixed at 0\n", format.KeyFPLen, format.MacLen)
	fmt.Printf("contents + fingerprint + MAC, as xx DMs use them: %d bytes\n", contents+format.KeyFPLen+format.MacLen-2)
	fmt.Printf("recipient ID + service tag: %d + %d bytes (the network's)\n", format.EphemeralRIDLen, format.SIHLen)
	fmt.Printf("today's notice: %d key + 16 tag + %d header = %d overhead, %d bytes of text\n\n",
		keyRepLen, noticeHeaderLen, keyRepLen+16+noticeHeaderLen, contents-keyRepLen-16-noticeHeaderLen)
}

// kemeleonLen is the Kemeleon size of an ML-KEM ciphertext with k×256 u
// values (du bits each, before) and v in dv bits: the base-q number's bits
// below q^(k·256), rounded down (the rejection rule), in bytes, plus v.
func kemeleonLen(k, dv int) (int, float64) {
	bits := float64(k*256) * math.Log2(kemQ)
	keep := math.Floor(bits)
	return int(keep+7)/8 + 256*dv/8, math.Pow(2, keep-bits)
}

func candidates() {
	contents := format.NewMessage(mainnetPrimeBytes).ContentsSize()
	wide := contents + format.KeyFPLen + format.MacLen - 2
	k512, a512 := kemeleonLen(2, 4)
	k768, a768 := kemeleonLen(3, 4)
	k1024, a1024 := kemeleonLen(4, 5)
	if k768 != Kem768Len {
		panic("Kemeleon size mismatch")
	}
	type cand struct {
		name     string
		pk, ct   int // public key and ciphertext as sent
		random   string
		pieceSet []int
	}
	const x = 32 // an Elligator-encoded X25519 key
	cs := []cand{
		{"X25519 (today, v3)", 32, x, "yes (Elligator 2)", []int{1}},
		{"ML-KEM-512 alone, raw", 800, 768, "no", []int{1}},
		{"ML-KEM-512 alone, Kemeleon", 800, k512, "yes", []int{1}},
		{"ML-KEM-512 + X25519, raw", 832, 768 + x, "no", []int{1}},
		{"ML-KEM-512 + X25519, Kemeleon", 832, k512 + x, "yes", []int{1, 2}},
		{"X-Wing (ML-KEM-768 + X25519), raw", 1216, mlkem.CiphertextSize768 + x, "no", []int{2}},
		{"X-Wing, Kemeleon (the prototype)", 1216, k768 + x, "yes", []int{2, 3}},
		{"ML-KEM-1024 + X25519, Kemeleon", 1600, k1024 + x, "yes", []int{2, 3}},
		{"Classic McEliece 348864 + X25519", 261120 + 32, 96 + x, "unclear", []int{1}},
		{"CSIDH-512 alone (NIKE)", 64, 64, "with work", []int{1}},
	}
	fmt.Println("## What each candidate leaves for text")
	fmt.Printf("Kemeleon sizes: ML-KEM-512 %d (keeps %.0f%%), -768 %d (keeps %.0f%%), -1024 %d (keeps %.0f%%)\n",
		k512, 100*a512, k768, 100*a768, k1024, 100*a1024)
	fmt.Printf("Each notice also carries a 16-byte tag and an %d-byte header.\n\n", noticeHeaderLen)
	fmt.Printf("| %-36s | %7s | %6s | %-17s | %s |\n", "seal", "pub key", "ct", "looks random", "text room (926 / 988 per message)")
	fmt.Println("|---|---|---|---|---|")
	for _, c := range cs {
		var room []string
		for _, n := range c.pieceSet {
			a := n*contents - c.ct - 16 - noticeHeaderLen
			b := n*wide - c.ct - 16 - noticeHeaderLen
			room = append(room, fmt.Sprintf("%d piece(s): %s / %s", n, roomStr(a), roomStr(b)))
		}
		fmt.Printf("| %-36s | %7d | %6d | %-17s | %s |\n", c.name, c.pk, c.ct, c.random, join(room))
	}
	fmt.Println()
}

func roomStr(n int) string {
	if n < 0 {
		return "doesn't fit"
	}
	return fmt.Sprint(n)
}

func join(s []string) string {
	out := ""
	for i, v := range s {
		if i > 0 {
			out += "; "
		}
		out += v
	}
	return out
}

func addresses() {
	key := mustKey()
	b := key.Address.Bytes()
	if _, err := ParseAddress4(b); err != nil {
		panic(err)
	}
	fmt.Println("## Addresses as links")
	for _, a := range []struct {
		name string
		n    int
	}{
		{"v3 (today)", 33},
		{"ML-KEM-512 + ed25519", 1 + 32 + 800},
		{"v4: X-Wing + ed25519 (prototype)", len(b)},
		{"ML-KEM-1024 + ed25519", 1 + 32 + 1568},
	} {
		chars := base64.RawURLEncoding.EncodedLen(a.n)
		fmt.Printf("%-34s %5d bytes, %5d characters after the #, link %d characters\n",
			a.name, a.n, chars, len("https://slynk.me/#")+chars)
	}
	fmt.Println()
}

func mustKey() *Key4 {
	entropy := make([]byte, 16)
	rand.Read(entropy)
	k, err := key4FromEntropy(entropy)
	if err != nil {
		panic(err)
	}
	return k
}

// timeIt runs f n times and reports the median.
func timeIt(n int, f func()) time.Duration {
	d := make([]time.Duration, n)
	for i := range d {
		t := time.Now()
		f()
		d[i] = time.Since(t)
	}
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
	return d[n/2]
}

func timings() {
	const msgLen = 926
	key := mustKey()
	body := make([]byte, MaxBody4(msgLen))
	rand.Read(body)
	entropy := make([]byte, 16)

	fmt.Println("## Speed (median)")
	fmt.Printf("keys from the words:  %v\n", timeIt(50, func() { key4FromEntropy(entropy) }))
	tries = 0
	const seals = 100
	sealT := timeIt(seals, func() {
		if _, err := sealNotice4(key.Address, body, time.Now(), msgLen); err != nil {
			panic(err)
		}
	})
	fmt.Printf("seal a notice:        %v (%.2f encapsulations each on average)\n", sealT, float64(tries)/seals)
	ps, _ := sealNotice4(key.Address, body, time.Now(), msgLen)
	fmt.Printf("open a notice:        %v\n", timeIt(100, func() {
		if _, err := openPair(key, ps[0], ps[1]); err != nil {
			panic(err)
		}
	}))
	other := randomMessage(msgLen)
	fmt.Printf("try a wrong pair:     %v\n", timeIt(100, func() { openPair(key, ps[0], other) }))
	ct := make([]byte, ct768Len)
	var enc []byte
	for enc == nil {
		_, c := key.Address.ek.Encapsulate()
		copy(ct, c)
		enc, _ = kemeleonEncode768(ct)
	}
	fmt.Printf("Kemeleon encode/decode: %v / %v\n",
		timeIt(100, func() { kemeleonEncode768(ct) }),
		timeIt(100, func() { kemeleonDecode768(enc) }))
	// The worst case: a round whose messages hold no notice (or hold one
	// tried last) costs every ordered pair, n(n-1).
	for _, n := range []int{2, 5, 10, 20} {
		var msgs [][]byte
		for len(msgs) < n {
			msgs = append(msgs, randomMessage(msgLen))
		}
		var tried int
		t := timeIt(5, func() {
			var found []opened4
			found, tried = openRound(key, msgs)
			if len(found) != 0 {
				panic("found a notice in junk")
			}
		})
		fmt.Printf("a round of %2d messages, none a notice: %v (%d pairs tried)\n", n, t, tried)
	}
	fmt.Println()
}

func randomness(n int) {
	const msgLen = 926
	key := mustKey()
	fmt.Println("## Do the pieces look random?")
	fmt.Printf("evidence per u pattern in a raw ML-KEM ciphertext: %.4f nats; %d patterns: %.2f nats\n",
		klPerPattern(), u768Count, klPerPattern()*u768Count)
	fmt.Printf("evidence per v pattern, before the fix for 0s: %.2e nats; 256 patterns: %.2e nats\n", klV(), klV()*256)

	// The best simple test on raw ciphertexts, against random strings.
	var rawHit, rndHit, kemHit int
	for range n {
		_, ct := key.Address.ek.Encapsulate()
		if llrMLKEM768(ct) > 0 {
			rawHit++
		}
		if llrMLKEM768(randomMessage(ct768Len)) > 0 {
			rndHit++
		}
		ps, err := sealNotice4(key.Address, nil, time.Now(), msgLen)
		if err != nil {
			panic(err)
		}
		stream := append(append([]byte{}, ps[0]...), ps[1]...)
		if llrMLKEM768(stream[keyRepLen:]) > 0 {
			kemHit++
		}
	}
	fmt.Printf("the test says \"ML-KEM\" for: %.1f%% of raw ciphertexts, %.1f%% of random strings, %.1f%% of encoded notices\n",
		100*float64(rawHit)/float64(n), 100*float64(rndHit)/float64(n), 100*float64(kemHit)/float64(n))

	// Without the rejection step, the base-q number's top bit would give it
	// away: count how often it would have been set.
	var top int
	for range n {
		_, ct := key.Address.ek.Encapsulate()
		if _, err := kemeleonEncode768(ct); err == errKemeleonReject {
			top++
		}
	}
	keepU := math.Pow(2, kem768Bits-float64(u768Count)*math.Log2(kemQ))
	keepV := math.Pow(1-1.0/16/vZeroBin, 256)
	fmt.Printf("encodings rejected (top bit, or a 0 in v): %.1f%% (expected %.1f%%)\n",
		100*float64(top)/float64(n), 100*(1-keepU*keepV))

	// Bit balance across every bit position of both pieces.
	ones := make([]int, 2*msgLen*8)
	for range n {
		ps, _ := sealNotice4(key.Address, nil, time.Now(), msgLen)
		stream := append(append([]byte{}, ps[0]...), ps[1]...)
		for i := range ones {
			ones[i] += int(stream[i/8] >> (i % 8) & 1)
		}
	}
	worst, worstAt := 0.0, 0
	for i, c := range ones {
		z := math.Abs(float64(c)-float64(n)/2) / math.Sqrt(float64(n)/4)
		if z > worst {
			worst, worstAt = z, i
		}
	}
	// How often fair random bits would do at least this badly somewhere.
	p := 1 - math.Pow(1-math.Erfc(worst/math.Sqrt2), float64(len(ones)))
	fmt.Printf("bit balance over %d bit positions: worst |z| = %.2f at bit %d; fair random bits do as badly %.0f%% of the time\n\n",
		len(ones), worst, worstAt, 100*p)
}
