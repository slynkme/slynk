// Package squeeze compresses what Slynk sends with Brotli, and decompresses
// what arrives (web/src/payload.ts). Brotli makes text, code and other files
// that aren't already compressed about a sixth smaller than deflate does, and
// a zip of them sent whole (web/src/zipInside.ts) about a third smaller.
//
// It runs in the small helper module (cmd/tools-wasm), in a worker of its own
// (web/src/squeeze/), never in the mixnet worker: compressing a big file at
// Brotli's best setting takes seconds, which would hold up that worker's
// traffic.
//
// Decompressing trusts nothing: the bytes come from whoever made the link.
// The decoder is Go, so a crafted stream can't corrupt memory (Google's C
// decoder could, CVE-2026-111497); it gives exactly the size the envelope
// declares or an error, and a panic in it becomes an error too.
package squeeze

import (
	"bytes"
	"errors"
	"fmt"
	"io"

	"github.com/andybalholm/brotli"
)

const (
	// MaxSize is the most Decompress gives: everything one envelope may hold
	// once decompressed (MAX_DECODED in web/src/payload.ts).
	MaxSize = 100_000_000
	// MaxQuality is Brotli's best and slowest setting.
	MaxQuality = 11

	minWindow = 10
	maxWindow = 24 // Brotli's own limit: 16 MB, without the "large window" extension the decoder refuses
)

// ErrDamaged is returned for any stream that isn't exactly what it claims.
var ErrDamaged = errors.New("squeeze: damaged")

// Compress returns data as one Brotli stream at quality (0 to 11), with a
// window just big enough for it, so the recipient's decoder needs no more
// memory than the data takes. The stream is decompressed again and compared
// before it's returned, so an encoder bug can only cost the space it would
// have saved, never send something the recipient can't open.
func Compress(data []byte, quality int) ([]byte, error) {
	if quality < 0 || quality > MaxQuality {
		return nil, fmt.Errorf("squeeze: quality %d", quality)
	}
	if len(data) > MaxSize {
		return nil, fmt.Errorf("squeeze: %d bytes is too many", len(data))
	}
	var out bytes.Buffer
	w := brotli.NewWriterOptions(&out, brotli.WriterOptions{Quality: quality, LGWin: window(len(data))})
	if _, err := w.Write(data); err != nil {
		return nil, err
	}
	if err := w.Close(); err != nil {
		return nil, err
	}
	back, err := Decompress(out.Bytes(), len(data))
	if err != nil || !bytes.Equal(back, data) {
		return nil, errors.New("squeeze: the stream didn't decompress to its input")
	}
	return out.Bytes(), nil
}

// window is the smallest Brotli window that covers n bytes (a window of 2^w
// bytes holds 2^w - 16 of them).
func window(n int) int {
	w := minWindow
	for w < maxWindow && 1<<w-16 < n {
		w++
	}
	return w
}

// Decompress returns exactly size bytes from one Brotli stream. A stream that
// is damaged, gives more or fewer bytes, or has anything after its end is
// ErrDamaged.
func Decompress(stream []byte, size int) (out []byte, err error) {
	if size < 0 || size > MaxSize {
		return nil, ErrDamaged
	}
	// The decoder is a translation of Google's C code; a mistake there shows
	// up in Go as a panic (an index out of range), never as a bad write.
	defer func() {
		if recover() != nil {
			out, err = nil, ErrDamaged
		}
	}()
	r := brotli.NewReader(bytes.NewReader(stream))
	out = make([]byte, size)
	if _, err := io.ReadFull(r, out); err != nil {
		return nil, ErrDamaged
	}
	// Then nothing more: the stream must end here, with no bytes after it.
	var one [1]byte
	for range 4 {
		n, err := r.Read(one[:])
		if n > 0 || (err != nil && err != io.EOF) {
			return nil, ErrDamaged
		}
		if err == io.EOF {
			return out, nil
		}
	}
	return nil, ErrDamaged
}
