//go:build js && wasm

// Command tools-wasm is the small helper module (about 3 MB, under 1 MB
// compressed): Argon2id for password links (package kdf) and Brotli for what's
// sent (package squeeze), exposed to JavaScript as globalThis.slynkTools. Each
// job runs in a worker of its own (web/src/kdf/, web/src/squeeze/), so the
// slow work never holds up the mixnet worker.
//
//	slynkTools.argon2id(password, salt, time, memoryKiB, threads) -> Promise<Uint8Array>
//	slynkTools.brotli(data, quality) -> Promise<Uint8Array>
//	slynkTools.unbrotli(stream, size) -> Promise<Uint8Array>
//
// password, salt, data and stream are Uint8Arrays; the key is 32 bytes.
// unbrotli gives exactly size bytes, or rejects.
package main

import (
	"math"
	"syscall/js"

	"slynk/core/kdf"
	"slynk/core/squeeze"
)

func main() {
	js.Global().Set("slynkTools", js.ValueOf(map[string]any{
		"argon2id": js.FuncOf(argon2id),
		"brotli":   js.FuncOf(brotli),
		"unbrotli": js.FuncOf(unbrotli),
	}))
	if ready := js.Global().Get("onSlynkToolsReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}

func argon2id(_ js.Value, args []js.Value) any {
	var (
		password, salt          []byte
		time, memoryKiB, thread int
	)
	if len(args) == 5 {
		password, salt = bytesArg(args[0], kdf.MaxPassword), bytesArg(args[1], kdf.MaxPassword)
		time, memoryKiB, thread = intArg(args[2]), intArg(args[3]), intArg(args[4])
	}
	return promise(func() (any, error) {
		defer clear(password)
		if time < 0 || memoryKiB < 0 || thread < 0 || thread > 255 {
			time, memoryKiB, thread = 0, 0, 0 // Derive refuses these
		}
		key, err := kdf.Derive(password, salt, uint32(time), uint32(memoryKiB), uint8(thread))
		if err != nil {
			return nil, err
		}
		defer clear(key)
		return bytesOut(key), nil
	})
}

func brotli(_ js.Value, args []js.Value) any {
	var (
		data    []byte
		quality = -1
	)
	if len(args) == 2 {
		data, quality = bytesArg(args[0], squeeze.MaxSize), intArg(args[1])
	}
	return promise(func() (any, error) {
		if data == nil {
			return nil, squeeze.ErrDamaged
		}
		packed, err := squeeze.Compress(data, quality)
		if err != nil {
			return nil, err
		}
		return bytesOut(packed), nil
	})
}

func unbrotli(_ js.Value, args []js.Value) any {
	var (
		stream []byte
		size   = -1
	)
	if len(args) == 2 {
		// No envelope is bigger than 2 MB; the size limit is the decoder's.
		stream, size = bytesArg(args[0], squeeze.MaxSize), intArg(args[1])
	}
	return promise(func() (any, error) {
		if stream == nil {
			return nil, squeeze.ErrDamaged
		}
		out, err := squeeze.Decompress(stream, size)
		if err != nil {
			return nil, err
		}
		return bytesOut(out), nil
	})
}

// promise runs fn on its own goroutine and settles a JS Promise with the
// result. Argon2 waits on goroutines of its own, which mustn't happen on the
// goroutine that serves a call from JavaScript.
func promise(fn func() (any, error)) js.Value {
	var executor js.Func
	executor = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer executor.Release()
			v, err := fn()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(v)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(executor)
}

// bytesArg copies a Uint8Array of at most max bytes, or returns nil for
// anything else. An empty one is an empty slice, not nil.
func bytesArg(v js.Value, max int) []byte {
	if !v.InstanceOf(js.Global().Get("Uint8Array")) || v.Length() > max {
		return nil
	}
	b := make([]byte, v.Length())
	js.CopyBytesToGo(b, v)
	return b
}

func bytesOut(b []byte) js.Value {
	out := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(out, b)
	return out
}

// intArg returns a whole number in int range, or -1.
func intArg(v js.Value) int {
	if v.Type() != js.TypeNumber {
		return -1
	}
	f := v.Float() // NaN fails every comparison below
	if !(f >= 0 && f <= 1<<30) || f != math.Trunc(f) {
		return -1
	}
	return int(f)
}
