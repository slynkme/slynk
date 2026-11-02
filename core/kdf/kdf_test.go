package kdf

import (
	"bytes"
	"encoding/hex"
	"testing"
)

// The settings of the page's password format v1 (web/src/password.ts).
const (
	v1Time      = 3
	v1MemoryKiB = 64 * 1024
	v1Threads   = 1
)

// Known answers for format v1's settings, worked out independently with
// OpenSSL's Argon2id (Node's crypto.argon2Sync). web/test/password.test.ts
// checks the WebAssembly build against the same values.
func TestDeriveKnownAnswers(t *testing.T) {
	seq := make([]byte, SaltLen)
	for i := range seq {
		seq[i] = byte(i)
	}
	for _, c := range []struct {
		password string
		salt     []byte
		want     string
	}{
		{"spider ocean wagon trophy lunar", seq, "df1888df579deb05d20193f0a75a61b1225372631cb196a01e04234c9ff473f1"},
		{"pässwörd ☃", bytes.Repeat([]byte{0xa5}, SaltLen), "5d7ca6da107134c58541112d36f2b7102e70710e9945b8691ac37ee2dd8405d3"},
	} {
		got, err := Derive([]byte(c.password), c.salt, v1Time, v1MemoryKiB, v1Threads)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(got) != c.want {
			t.Errorf("Derive(%q) = %x, want %s", c.password, got, c.want)
		}
	}
}

func TestDeriveRefusesBadInput(t *testing.T) {
	salt := make([]byte, SaltLen)
	pw := []byte("password")
	for name, f := range map[string]func() ([]byte, error){
		"empty password":  func() ([]byte, error) { return Derive(nil, salt, 1, 8, 1) },
		"long password":   func() ([]byte, error) { return Derive(make([]byte, MaxPassword+1), salt, 1, 8, 1) },
		"short salt":      func() ([]byte, error) { return Derive(pw, salt[:15], 1, 8, 1) },
		"no time":         func() ([]byte, error) { return Derive(pw, salt, 0, 8, 1) },
		"too much time":   func() ([]byte, error) { return Derive(pw, salt, MaxTime+1, 8, 1) },
		"no threads":      func() ([]byte, error) { return Derive(pw, salt, 1, 8, 0) },
		"too many":        func() ([]byte, error) { return Derive(pw, salt, 1, 64, MaxThreads+1) },
		"too little mem":  func() ([]byte, error) { return Derive(pw, salt, 1, 15, 2) },
		"too much memory": func() ([]byte, error) { return Derive(pw, salt, 1, MaxMemoryKiB+1, 1) },
	} {
		if k, err := f(); err == nil || k != nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// The limits themselves are allowed.
	if _, err := Derive(make([]byte, MaxPassword), salt, 1, 8, 1); err != nil {
		t.Errorf("longest password: %v", err)
	}
}
