// Package kdf turns a password into a key for Slynk's password links
// (web/src/password.ts) with Argon2id: slow and memory-hard, so every guess
// costs an attacker real time and memory.
//
// It runs in the small helper module (cmd/tools-wasm), not in the
// mixnet worker: the work would hold that worker up for a second or two, and
// its 64 MB would stay in that worker's memory for as long as the tab is open.
// The page closes the small worker after each use, which frees the memory.
package kdf

import (
	"errors"

	"golang.org/x/crypto/argon2"
)

const (
	KeyLen  = 32 // an AES-256 key
	SaltLen = 16

	// Limits on what a caller may ask for. The page picks fixed settings for
	// each version of its password format, but a crafted link mustn't be able
	// to make a recipient's tab allocate gigabytes or work for minutes.
	MaxPassword  = 1024 // bytes of UTF-8
	MaxMemoryKiB = 256 * 1024
	MaxTime      = 10
	MaxThreads   = 4
)

// Derive returns the Argon2id key for password and salt. memoryKiB is in
// kibibytes, as in RFC 9106.
func Derive(password, salt []byte, time, memoryKiB uint32, threads uint8) ([]byte, error) {
	switch {
	case len(password) == 0 || len(password) > MaxPassword:
		return nil, errors.New("kdf: password must be 1 to 1024 bytes")
	case len(salt) != SaltLen:
		return nil, errors.New("kdf: salt must be 16 bytes")
	case time < 1 || time > MaxTime:
		return nil, errors.New("kdf: time must be 1 to 10")
	case threads < 1 || threads > MaxThreads:
		return nil, errors.New("kdf: threads must be 1 to 4")
	// Argon2 needs at least 8 KiB per thread.
	case memoryKiB < 8*uint32(threads) || memoryKiB > MaxMemoryKiB:
		return nil, errors.New("kdf: memory out of range")
	}
	return argon2.IDKey(password, salt, time, memoryKiB, threads, KeyLen), nil
}
