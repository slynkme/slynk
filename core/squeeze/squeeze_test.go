package squeeze

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"io"
	"strings"
	"testing"

	"github.com/andybalholm/brotli"
)

func text(n int) []byte {
	var b strings.Builder
	for i := 0; b.Len() < n; i++ {
		b.WriteString("<p class=\"note\">Line ")
		b.WriteString(strings.Repeat("ab", i%7))
		b.WriteString(" of some page's text.</p>\n")
	}
	return []byte(b.String()[:n])
}

func random(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

func TestRoundTrip(t *testing.T) {
	for _, data := range [][]byte{
		{}, {0}, []byte("a"), text(100), text(1<<10 - 16), text(1<<10 - 15), text(70_000), random(5000), text(1_500_000),
	} {
		for _, q := range []int{0, 5, MaxQuality} {
			packed, err := Compress(data, q)
			if err != nil {
				t.Fatalf("%d bytes, q%d: %v", len(data), q, err)
			}
			got, err := Decompress(packed, len(data))
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("%d bytes, q%d: came back different (%v)", len(data), q, err)
			}
			// Another decoder reads it the same way.
			other, err := io.ReadAll(brotli.NewReader(bytes.NewReader(packed)))
			if err != nil || !bytes.Equal(other, data) {
				t.Fatalf("%d bytes, q%d: the library's reader disagrees", len(data), q)
			}
		}
	}
}

func TestSqueezesText(t *testing.T) {
	data := text(200_000)
	packed, err := Compress(data, MaxQuality)
	if err != nil {
		t.Fatal(err)
	}
	if len(packed) > len(data)/10 {
		t.Errorf("200 KB of repetitive text came to %d bytes", len(packed))
	}
}

func TestWindow(t *testing.T) {
	for n, want := range map[int]int{0: 10, 1008: 10, 1009: 11, 65520: 16, 65521: 17, 16_777_200: 24, 16_777_201: 24, MaxSize: 24} {
		if got := window(n); got != want {
			t.Errorf("window(%d) = %d, want %d", n, got, want)
		}
	}
}

// A stream made by Google's own encoder (Node's zlib, quality 11) of
// "Slynk squeezes this, Slynk squeezes that.\n" reads as it should.
func TestReadsGooglesStreams(t *testing.T) {
	stream, _ := hex.DecodeString("1b2900f8c56dec7b56f33bb6ab08421ad58228928c42920494741ad6758667a597134489214700")
	want := "Slynk squeezes this, Slynk squeezes that.\n"
	got, err := Decompress(stream, len(want))
	if err != nil || string(got) != want {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestDecompressRefuses(t *testing.T) {
	data := text(50_000)
	packed, err := Compress(data, MaxQuality)
	if err != nil {
		t.Fatal(err)
	}
	flipped := bytes.Clone(packed)
	flipped[len(flipped)/2] ^= 0x40
	for name, c := range map[string]struct {
		stream []byte
		size   int
	}{
		"one byte short":    {packed, len(data) + 1},
		"one byte too many": {packed, len(data) - 1},
		"cut off":           {packed[:len(packed)-3], len(data)},
		"bytes after it":    {append(bytes.Clone(packed), 0), len(data)},
		"a bit flipped":     {flipped, len(data)},
		"empty":             {nil, 0},
		"garbage":           {random(200), 1000},
		"negative size":     {packed, -1},
		"too big a size":    {packed, MaxSize + 1},
		// WBITS 0x11 asks for "Large Window Brotli", windows up to 1 GB.
		"a large window": {[]byte{0x11, 0x00, 0x00, 0x00}, 10},
	} {
		if out, err := Decompress(c.stream, c.size); err != ErrDamaged || out != nil {
			t.Errorf("%s: %d bytes, %v", name, len(out), err)
		}
	}
}

func TestCompressRefuses(t *testing.T) {
	for _, q := range []int{-1, MaxQuality + 1} {
		if _, err := Compress([]byte("x"), q); err == nil {
			t.Errorf("quality %d accepted", q)
		}
	}
}

// FuzzDecoder looks for streams that make the library's decoder panic,
// without Decompress's recover. A general net: it doesn't reach
// CVE-2026-111497's panic (5 minutes and 4.4 million streams against v1.2.6
// found nothing, 2026-10-26), which needs a carefully built stream. Run it for
// a while after updating the library:
//
//	go test ./squeeze/ -run '^$' -fuzz FuzzDecoder -fuzztime 10m
func FuzzDecoder(f *testing.F) {
	for _, data := range [][]byte{nil, []byte("Slynk"), text(3000), random(300)} {
		for _, q := range []int{1, 6, MaxQuality} {
			packed, err := Compress(data, q)
			if err != nil {
				f.Fatal(err)
			}
			f.Add(packed)
		}
	}
	f.Fuzz(func(t *testing.T, stream []byte) {
		r := brotli.NewReader(bytes.NewReader(stream))
		io.Copy(io.Discard, io.LimitReader(r, 4<<20))
	})
}

// A stream crafted as in the adversarial review of 2026-10-26: metablocks of
// one byte each, every one with 256 literal block types and a 16,384-entry
// context map of 255s, so the decoder's inverse move-to-front step moves its
// whole table for every entry. The library's byte-at-a-time loop made 2 MB of
// these take 24 s in the browser; its copy (third_party/andybalholm-brotli,
// SLYNK.md) must still give the same bytes.
func TestManyContextMaps(t *testing.T) {
	const n = 300
	w := &bitWriter{}
	w.put(0, 1) // WBITS = 16
	for range n {
		craftedMetablock(w, 256, 256)
	}
	w.put(1, 1) // ISLAST
	w.put(1, 1) // ISLASTEMPTY
	got, err := Decompress(w.flush(), n)
	if err != nil || !bytes.Equal(got, bytes.Repeat([]byte("A"), n)) {
		t.Fatalf("got %q…, %v", got[:min(len(got), 8)], err)
	}
}

// bitWriter writes bits least significant first, as Brotli reads them.
type bitWriter struct {
	buf  []byte
	acc  uint64
	nacc uint
}

func (w *bitWriter) put(v uint64, n uint) {
	for i := range n {
		w.acc |= ((v >> i) & 1) << w.nacc
		if w.nacc++; w.nacc == 8 {
			w.buf = append(w.buf, byte(w.acc))
			w.acc, w.nacc = 0, 0
		}
	}
}

func (w *bitWriter) flush() []byte {
	if w.nacc > 0 {
		w.buf = append(w.buf, byte(w.acc))
	}
	return w.buf
}

// varlen writes a VarLenUint8 (0 to 255).
func (w *bitWriter) varlen(v int) {
	if v == 0 {
		w.put(0, 1)
		return
	}
	w.put(1, 1)
	n := 0
	for 1<<(n+1) <= v {
		n++
	}
	w.put(uint64(n), 3)
	w.put(uint64(v-1<<n), uint(n))
}

// one writes a simple prefix code of one symbol.
func (w *bitWriter) one(sym int, alphabetBits uint) {
	w.put(1, 2) // HSKIP 1: simple
	w.put(0, 2) // NSYM-1
	w.put(uint64(sym), alphabetBits)
}

func bitsFor(n int) uint {
	b := uint(0)
	for 1<<b < n {
		b++
	}
	return b
}

// craftedMetablock writes a metablock that gives "A", with nbl literal block
// types and ntrees literal trees, its context map all ntrees-1 (zero bits each).
func craftedMetablock(w *bitWriter, nbl, ntrees int) {
	w.put(0, 1)  // ISLAST
	w.put(0, 2)  // MNIBBLES = 4
	w.put(0, 16) // MLEN-1 = 0
	w.put(0, 1)  // ISUNCOMPRESSED
	w.varlen(nbl - 1)
	w.one(0, bitsFor(nbl+2)) // block type code
	w.one(0, 5)              // block count code
	w.put(3, 2)              // the first block count's extra bits
	w.varlen(0)              // NBLTYPESI = 1
	w.varlen(0)              // NBLTYPESD = 1
	w.put(0, 2)              // NPOSTFIX
	w.put(0, 4)              // NDIRECT
	for range nbl {
		w.put(0, 2) // context mode LSB6
	}
	w.varlen(ntrees - 1)
	w.put(0, 1) // RLEMAX = 0
	w.one(ntrees-1, bitsFor(ntrees))
	w.put(1, 1) // IMTF: inverse move-to-front
	w.varlen(0) // NTREESD = 1
	for range ntrees {
		w.one('A', 8)
	}
	w.one(8, 10) // insert-and-copy: insert 1, copy 2
	w.one(0, 6)  // distance
}
