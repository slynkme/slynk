//go:build js && wasm

// Command wasm exposes Slynk's core to JavaScript as globalThis.slynkCore.
// It is meant to run inside a Web Worker. Every call returns a Promise:
//
//	slynkCore.connect(onProgress)                -> undefined
//	slynkCore.upload(bytes, varied, onProgress)  -> Uint8Array (link)
//	slynkCore.download(linkBytes, onProgress)    -> Uint8Array (data)
//	slynkCore.stopDownload()                     // the running download rejects
//	slynkCore.stopUpload()                       // the running upload rejects; nothing more of it is sent
//	slynkCore.cover(bool)                        // cover messages on or off
//	slynkCore.status()                           -> {registered, total, healthy, cover, noticeJoining}
//	slynkCore.verbose(bool)                      // xxDK logs to the console
//
// Anonymous inboxes (inbox.go):
//
//	slynkCore.inboxNew()                     -> {words, address, address4}
//	slynkCore.inboxAddress(bytes)            -> true (rejects a bad address)
//	slynkCore.inboxCheckWords(words)         -> {address, address4, store}
//	slynkCore.inboxOpen(words, onEvent, sinceMs, skipFromMs, skipToMs) -> {address, address4}
//	slynkCore.inboxClose()
//	slynkCore.sendNotice(address, text, separate, onProgress, atRandom, include, name, compressed, replyKeys) -> round time (ms)
//	slynkCore.sendFileNotice(address, link, sinceMs, onProgress, include, name, replyKeys) -> round time (ms)
//	slynkCore.noticeConnect(onProgress)      -> connects the second identity notices go from
//	slynkCore.noticeRestart()                -> gives up its join under way for a fresh one (bool)
//	slynkCore.stopFileNotice()               -> stops a file notice still waiting for its moment (bool: in time)
//
// onProgress(stage, done, total) is optional. varied picks 1-11 part batches
// instead of 9-11 (slower; see transfer.Client.SetVariedBatches). A download
// that goes quiet reports the stage "stalled" and keeps waiting. Errors may
// carry a code (inbox.go) the page turns into its own words.
package main

import (
	"errors"
	"sync"
	"syscall/js"

	"slynk/core/transfer"
)

var (
	mu     sync.Mutex
	client *transfer.Client
	// coverOn is the page's Cover messages setting, for identities
	// connected later (the separate one notices go from).
	coverOn bool

	// upStop is the running upload's stop, closed by stopUpload. It has a
	// lock of its own: mu is held for a whole join, and a call from the page
	// mustn't wait for that.
	upMu   sync.Mutex
	upStop chan struct{}
)

func main() {
	transfer.SetVerbose(false)
	js.Global().Set("slynkCore", js.ValueOf(map[string]any{
		"connect":  js.FuncOf(connect),
		"upload":   js.FuncOf(upload),
		"download": js.FuncOf(download),
		"stopDownload": js.FuncOf(func(js.Value, []js.Value) any {
			if c, err := connected(); err == nil {
				c.StopDownload()
			}
			return nil
		}),
		"stopUpload": js.FuncOf(func(js.Value, []js.Value) any {
			upMu.Lock()
			defer upMu.Unlock()
			if upStop != nil {
				close(upStop)
				upStop = nil
			}
			return nil
		}),
		"cover": js.FuncOf(func(_ js.Value, args []js.Value) any {
			on := len(args) > 0 && args[0].Truthy()
			mu.Lock()
			coverOn = on
			mu.Unlock()
			if c, err := connected(); err == nil {
				c.SetCover(on)
			}
			setNoticeCover(on)
			return nil
		}),
		"status": js.FuncOf(status),

		"inboxAddress":    js.FuncOf(inboxAddress),
		"inboxNew":        js.FuncOf(inboxNew),
		"inboxCheckWords": js.FuncOf(inboxCheckWords),
		"inboxOpen":       js.FuncOf(inboxOpen),
		"inboxClose":      js.FuncOf(inboxClose),
		"sendNotice":      js.FuncOf(sendNotice),
		"sendFileNotice":  js.FuncOf(sendFileNotice),
		"noticeConnect":   js.FuncOf(noticeConnect),
		"noticeRestart":   js.FuncOf(noticeRestart),
		"stopFileNotice":  js.FuncOf(stopFileNotice),
		"verbose": js.FuncOf(func(_ js.Value, args []js.Value) any {
			transfer.SetVerbose(len(args) > 0 && args[0].Truthy())
			return nil
		}),
	}))
	if ready := js.Global().Get("onSlynkCoreReady"); ready.Type() == js.TypeFunction {
		ready.Invoke()
	}
	select {}
}

func connect(_ js.Value, args []js.Value) any {
	progress := progressFn(args, 0)
	return promise(func() (any, error) {
		mu.Lock()
		defer mu.Unlock()
		if client != nil {
			return js.Undefined(), nil
		}
		c, err := transfer.Connect(progress)
		if err != nil {
			return nil, err
		}
		client = c
		return js.Undefined(), nil
	})
}

func upload(_ js.Value, args []js.Value) any {
	data := bytesArg(args, 0)
	varied := len(args) > 1 && args[1].Truthy()
	progress := progressFn(args, 2)
	// Its stop is in place before this call returns, so a stopUpload the page
	// sends straight after always finds it, even before the upload has begun.
	stop := make(chan struct{})
	upMu.Lock()
	upStop = stop
	upMu.Unlock()
	return promise(func() (any, error) {
		defer func() {
			upMu.Lock()
			if upStop == stop {
				upStop = nil
			}
			upMu.Unlock()
		}()
		c, err := connected()
		if err != nil {
			return nil, err
		}
		c.SetVariedBatches(varied)
		link, err := c.UploadStoppable(data, progress, stop)
		if err != nil {
			return nil, err
		}
		return bytesToJS(link), nil
	})
}

func download(_ js.Value, args []js.Value) any {
	link := bytesArg(args, 0)
	progress := progressFn(args, 1)
	return promise(func() (any, error) {
		c, err := connected()
		if err != nil {
			return nil, err
		}
		data, err := c.Download(link, progress)
		if err != nil {
			return nil, err
		}
		return bytesToJS(data), nil
	})
}

func status(js.Value, []js.Value) any {
	return promise(func() (any, error) {
		c, err := connected()
		if err != nil {
			return nil, err
		}
		registered, total, healthy := c.Status()
		return js.ValueOf(map[string]any{
			"registered": registered, "total": total, "healthy": healthy,
			"cover": c.CoverSent(),
			// When the second identity started joining (ms), or 0: Settings offers a restart.
			"noticeJoining": noticeJoining(),
		}), nil
	})
}

func connected() (*transfer.Client, error) {
	mu.Lock()
	defer mu.Unlock()
	if client == nil {
		return nil, errors.New("not connected to the mixnet yet")
	}
	return client, nil
}

// promise runs fn on its own goroutine and settles a JS Promise with the result.
func promise(fn func() (any, error)) js.Value {
	var executor js.Func
	executor = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer executor.Release()
			v, err := fn()
			if err != nil {
				e := js.Global().Get("Error").New(err.Error())
				if code := errorCode(err); code != "" {
					e.Set("code", code)
				}
				reject.Invoke(e)
				return
			}
			resolve.Invoke(v)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(executor)
}

func progressFn(args []js.Value, i int) transfer.Progress {
	if len(args) <= i || args[i].Type() != js.TypeFunction {
		return func(string, int, int) {}
	}
	fn := args[i]
	return func(stage string, done, total int) { fn.Invoke(stage, done, total) }
}

func bytesArg(args []js.Value, i int) []byte {
	if len(args) <= i {
		return nil
	}
	b := make([]byte, args[i].Get("length").Int())
	js.CopyBytesToGo(b, args[i])
	return b
}

func bytesToJS(b []byte) js.Value {
	a := js.Global().Get("Uint8Array").New(len(b))
	js.CopyBytesToJS(a, b)
	return a
}
