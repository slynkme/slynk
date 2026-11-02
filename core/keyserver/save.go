package keyserver

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
)

// The shutdown file. While running, shares live only in memory. A clean
// shutdown writes them here (Save), and the next start reads them back and
// destroys the file before answering anything (Load), so a copy can never
// bring back a share used in the meantime. Deleted data can linger in a
// disk's freed blocks, so this is the one moment shares touch the disk:
// docs/findings/one-time-links.md.
//
// Layout: saveMagic, then int64s (big-endian): when saved, when last started
// without shares, the rate limit's tok and tm, and the clean-up line's counts
// (stats, its usual rate as float64 bits); then the number of records
// (uint32) and each record (its 16-byte key, then recordBytes: kind, mode,
// flags, exp and at as uint32s, hr, s, hc); then SHA-256 of everything
// before it.
//
// Load also reads the format before compact records (saveMagicV1, until
// 2026-10-21), so the first start of this version keeps the waiting shares:
// the same, but 32-byte keys and 116-byte records (a 1, kind, mode,
// flags, exp and at as int64s, then hr, s and hc, the hashes whole). The
// first 16 bytes of its key and hashes are what's kept now.
const (
	saveMagic     = "SLYKS\x00\x00\x02"
	recordBytes   = 3 + 4 + 4 + 16 + 32 + 16
	slotBytes     = 16 + recordBytes
	saveMagicV1   = "SLYKS\x00\x00\x01"
	recordBytesV1 = 116
	saveInts      = 4 + 9
	saveHead      = len(saveMagic) + 8*saveInts + 4
)

// saveFormats are the shutdown files Load reads, by their magic: each one's
// key size and how to read a record.
var saveFormats = map[string]struct {
	keyBytes, recordBytes int
	unpack                func([]byte) (record, bool)
}{
	saveMagic:   {16, recordBytes, unpackRecord},
	saveMagicV1: {32, recordBytesV1, unpackRecordV1},
}

func packRecord(b []byte, r record) []byte {
	b = append(b, r.kind, r.mode, r.flags)
	b = binary.BigEndian.AppendUint32(b, r.exp)
	b = binary.BigEndian.AppendUint32(b, r.at)
	b = append(b, r.hr[:]...)
	b = append(b, r.s[:]...)
	return append(b, r.hc[:]...)
}

func validKind(k byte) bool { return k == 'W' || k == 'C' || k == 'T' }

func unpackRecord(b []byte) (record, bool) {
	var r record
	if len(b) != recordBytes || !validKind(b[0]) {
		return r, false
	}
	r.kind, r.mode, r.flags = b[0], b[1], b[2]
	r.exp = binary.BigEndian.Uint32(b[3:])
	r.at = binary.BigEndian.Uint32(b[7:])
	r.hr = [16]byte(b[11:27])
	r.s = [32]byte(b[27:59])
	r.hc = [16]byte(b[59:75])
	return r, true
}

// unpackRecordV1 reads a record of the format before (saveMagicV1).
func unpackRecordV1(b []byte) (record, bool) {
	var r record
	if len(b) != recordBytesV1 || b[0] != 1 || !validKind(b[1]) {
		return r, false
	}
	r.kind, r.mode, r.flags = b[1], b[2], b[3]
	r.exp = u32(int64(binary.BigEndian.Uint64(b[4:])))
	r.at = u32(int64(binary.BigEndian.Uint64(b[12:])))
	r.hr = [16]byte(b[20:36]) // of 20:52
	r.s = [32]byte(b[52:84])
	r.hc = [16]byte(b[84:100]) // of 84:116
	return r, true
}

// Save writes every record to path, through a temporary file renamed into
// place and synced, so a crash leaves the old file or the new one, never part.
// It streams, so a full store needs no second copy in memory. It also closes
// the store: from then on every request is answered "down" and changes
// nothing, so nothing can happen after the snapshot. Call it at shutdown,
// once requests have stopped.
func (st *Store) Save(path string, restartedAt, now int64) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	st.closed = true

	tmp := path + ".tmp"
	if err := wipe(tmp); err != nil {
		return err
	}
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	h := sha256.New()
	w := bufio.NewWriterSize(io.MultiWriter(f, h), 64<<10)
	head := make([]byte, 0, saveHead)
	head = append(head, saveMagic...)
	s := st.stats
	for _, v := range []int64{now, restartedAt, st.tok, st.tm,
		s.rep, s.puts, s.slow, s.full, int64(math.Float64bits(s.usual)), s.wat, s.wn, s.wr, s.wu} {
		head = binary.BigEndian.AppendUint64(head, uint64(v))
	}
	head = binary.BigEndian.AppendUint32(head, uint32(len(st.recs)))
	_, err = w.Write(head)
	slot := make([]byte, 0, slotBytes)
	for k, r := range st.recs {
		if err != nil {
			break
		}
		slot = packRecord(append(slot[:0], k[:]...), r)
		_, err = w.Write(slot)
	}
	clear(slot[:cap(slot)])
	if err == nil {
		err = w.Flush()
	}
	if err == nil {
		_, err = f.Write(h.Sum(nil))
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = wipe(tmp)
		return err
	}
	return syncDir(filepath.Dir(path))
}

// Load reads the shutdown file into a new store of at most max records, then
// destroys the file, before the server answers anything. It returns when the
// server last started without its shares: now, if there was no complete file
// (after a crash), otherwise as the file says. An error means the file
// couldn't be destroyed: don't serve, as a later start could bring its shares
// back.
func Load(path string, max int, now int64) (*Store, int64, error) {
	st := NewStore(max)
	restartedAt := now
	f, err := os.Open(path)
	switch {
	case errors.Is(err, os.ErrNotExist):
		// no file: shares from before, if any, are lost
	case err != nil:
		return nil, 0, err
	default:
		if at, ok := st.restore(f, now); ok {
			restartedAt = at
		}
		_ = f.Close()
	}
	for _, p := range []string{path, path + ".tmp"} {
		if err := wipe(p); err != nil {
			return nil, 0, fmt.Errorf("can't destroy %s: %w", filepath.Base(p), err)
		}
	}
	return st, restartedAt, nil
}

// restore fills an empty store from a shutdown file, if it's whole: its
// records are kept only once its checksum, at the end, is checked.
func (st *Store) restore(f io.Reader, now int64) (int64, bool) {
	h := sha256.New()
	br := bufio.NewReaderSize(f, 64<<10)
	r := io.TeeReader(br, h)
	head := make([]byte, saveHead)
	if _, err := io.ReadFull(r, head); err != nil {
		return 0, false
	}
	format, ok := saveFormats[string(head[:len(saveMagic)])]
	if !ok {
		return 0, false
	}
	var v [saveInts]int64
	for i := range v {
		v[i] = int64(binary.BigEndian.Uint64(head[len(saveMagic)+8*i:]))
	}
	n := int(binary.BigEndian.Uint32(head[saveHead-4:]))
	recs := make(map[[16]byte]record, min(n, st.max))
	slot := make([]byte, format.keyBytes+format.recordBytes)
	defer clear(slot)
	for i := 0; i < n; i++ {
		if _, err := io.ReadFull(r, slot); err != nil {
			return 0, false
		}
		k := [16]byte(slot[:16]) // all of it, or the first 16 bytes of a 32-byte key
		rec, ok := format.unpack(slot[format.keyBytes:])
		if !ok {
			return 0, false
		}
		if c, keep := clean(rec, now); keep {
			recs[k] = c
		}
	}
	sum := make([]byte, sha256.Size)
	if _, err := io.ReadFull(br, sum); err != nil || !bytes.Equal(sum, h.Sum(nil)) {
		return 0, false
	}
	if _, err := br.ReadByte(); err != io.EOF {
		return 0, false // something after the checksum: not a file Save wrote
	}
	st.recs = recs
	st.tok, st.tm = min(max(v[2], 0), BurstPuts), v[3]
	st.stats = stats{rep: v[4], puts: v[5], slow: v[6], full: v[7], usual: math.Float64frombits(uint64(v[8])),
		wat: v[9], wn: v[10], wr: v[11], wu: v[12]}
	return v[1], true
}

// wipe overwrites a file with zeros, syncs it, then deletes it (best effort
// against the disk keeping old copies: see the top of this file). A missing
// file is fine.
func wipe(path string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi, err := f.Stat(); err == nil && fi.Size() > 0 {
		zero := make([]byte, 64<<10)
		for left := fi.Size(); left > 0; left -= int64(len(zero)) {
			if _, err := f.Write(zero[:min(left, int64(len(zero)))]); err != nil {
				break
			}
		}
		_ = f.Sync()
	}
	_ = f.Close()
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDir(filepath.Dir(path))
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
