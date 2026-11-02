//go:build js && wasm

package main

// The anonymous inbox's half of the bridge. The inbox being checked is
// opened from its words here, and its key stays in this worker. Lock ends
// the worker, which is the only way to be sure Go's memory is gone.

import (
	"encoding/hex"
	"errors"
	"sync"
	"syscall/js"
	"time"

	"slynk/core/transfer"
)

var (
	inboxMu sync.Mutex
	session *transfer.InboxSession
	// sessionKey is the open inbox's key, which a message to another inbox
	// may include so its owner can reply. It never leaves
	// this worker.
	sessionKey *transfer.InboxKey

	// noticeClient is the separate identity notices go from when this tab's
	// main identity also makes links or checks an inbox, so a node can't
	// tie the notice to them by its sender ID.
	noticeMu         sync.Mutex
	noticeClient     *transfer.Client
	noticeConnecting chan struct{} // closed when a connection attempt ends
	noticeStop       chan struct{} // closed to give up the attempt under way (noticeRestart)
	noticeSince      time.Time     // when the attempt under way began

	// fileNoticeStop is the stop of the file notice waiting for its moment,
	// closed by stopFileNotice. Cleared once the notice starts to
	// go, when it's too late. Its own lock: never held for long.
	fileNoticeMu   sync.Mutex
	fileNoticeStop chan struct{}
)

// lookbackSince is as far back as the network keeps messages; xxDK clamps
// anything earlier to its own retention.
const lookbackSince = 500 * time.Hour

var errNoInbox = errors.New("your inbox isn't open in this tab yet")

var errNoticeStopped = errors.New("the message telling the inbox was stopped before it went")

// errorCode names the errors the page has its own words for.
func errorCode(err error) string {
	switch {
	case errors.Is(err, transfer.ErrInboxPhrase):
		return "words"
	case errors.Is(err, transfer.ErrInboxAddress):
		return "address"
	case errors.Is(err, transfer.ErrNoticeSize):
		return "too-long"
	case errors.Is(err, transfer.ErrNoticeUnconfirmed):
		return "unconfirmed"
	case errors.Is(err, transfer.ErrNoticeFailed):
		return "undelivered"
	case errors.Is(err, transfer.ErrFromName):
		return "name"
	case errors.Is(err, transfer.ErrReplyKeys):
		return "reply-keys"
	case errors.Is(err, errNoInbox):
		return "no-inbox"
	case errors.Is(err, errNoticeStopped):
		return "stopped"
	case errors.Is(err, transfer.ErrConnectStalled):
		return "stalled"
	}
	return ""
}

// addressJS is an inbox's two addresses: address, the
// compact one, and address4, the quantum-safe one.
func addressJS(k *transfer.InboxKey) map[string]any {
	return map[string]any{"address": bytesToJS(k.Address.Bytes()), "address4": bytesToJS(k.Address4.Bytes())}
}

// inboxAddress checks an address of either kind that someone opened, before
// they write to it.
func inboxAddress(_ js.Value, args []js.Value) any {
	b := bytesArg(args, 0)
	return promise(func() (any, error) {
		if _, err := transfer.ParseInboxAddress(b); err != nil {
			return nil, err
		}
		return true, nil
	})
}

// inboxNew makes a new inbox: its words and address. Nothing is kept here.
func inboxNew(js.Value, []js.Value) any {
	return promise(func() (any, error) {
		words, err := transfer.NewInboxPhrase()
		if err != nil {
			return nil, err
		}
		key, err := transfer.InboxKeyFromPhrase(words)
		if err != nil {
			return nil, err
		}
		v := addressJS(key)
		v["words"] = words
		return js.ValueOf(v), nil
	})
}

// inboxCheckWords checks 12 words without connecting. With the address it
// gives the secret the page keeps the inbox on this device with, if its
// owner asks it to.
func inboxCheckWords(_ js.Value, args []js.Value) any {
	words := stringArg(args, 0)
	return promise(func() (any, error) {
		key, err := transfer.InboxKeyFromPhrase(words)
		if err != nil {
			return nil, err
		}
		v := addressJS(key)
		v["store"] = bytesToJS(key.StoreSecret())
		return js.ValueOf(v), nil
	})
}

// inboxOpen starts checking an inbox with the tab's main identity, looking
// back as far as the network keeps messages, or from since (Unix ms, if
// given and later): an owner who keeps their inbox on the device has what
// came before, so only what's new needs looking for. skipFrom and
// skipTo (Unix ms, if given) mark days already looked through by a
// look-back cut short, which aren't looked through again. onEvent("notice",
// {id, kind, body, at, quantumSafe, from, fromName, replyKeys}) hears each
// message once (id, in hex, is the same whenever a look-back finds it again;
// at is when it was sent, its round's time; quantumSafe says it came to the
// quantum-safe address, or as a reply sealed with reply keys this inbox gave;
// from is the sender's inbox address if they included it,
// proved, fromName the name they chose to show with it, and replyKeys their
// reply keys for this inbox, if a quantum-safe message gave them, which
// sendNotice takes back to answer quantum-safely);
// onEvent("lookback", {daysLeft, daysTotal, collecting, finished, missing})
// hears how the look-back is going. Calls never overlap and stop with
// inboxClose.
func inboxOpen(_ js.Value, args []js.Value) any {
	words := stringArg(args, 0)
	var onEvent js.Value
	if len(args) > 1 && args[1].Type() == js.TypeFunction {
		onEvent = args[1]
	}
	since := time.Now().Add(-lookbackSince)
	if len(args) > 2 && args[2].Type() == js.TypeNumber {
		if t := time.UnixMilli(int64(args[2].Float())); t.After(since) {
			since = t // xxDK still looks back at least about a day
		}
	}
	var skipFrom, skipTo time.Time
	if len(args) > 4 && args[3].Type() == js.TypeNumber && args[4].Type() == js.TypeNumber {
		from, to := time.UnixMilli(int64(args[3].Float())), time.UnixMilli(int64(args[4].Float()))
		if to.After(from) && to.Before(time.Now()) {
			skipFrom, skipTo = from, to
		}
	}
	return promise(func() (any, error) {
		c, err := connected()
		if err != nil {
			return nil, err
		}
		key, err := transfer.InboxKeyFromPhrase(words)
		if err != nil {
			return nil, err
		}
		inboxMu.Lock()
		defer inboxMu.Unlock()
		if session != nil {
			return nil, errors.New("an inbox is already open in this tab")
		}
		event := func(kind string, data map[string]any) {
			if onEvent.Truthy() {
				onEvent.Invoke(kind, js.ValueOf(data))
			}
		}
		session = c.OpenInboxSkipping(key, since, skipFrom, skipTo, func(n transfer.Notice) {
			at := int64(0) // unknown, rather than year 1
			if !n.RoundTime.IsZero() {
				at = n.RoundTime.UnixMilli()
			}
			notice := map[string]any{
				"id":          hex.EncodeToString(n.ID[:]),
				"kind":        int(n.Kind),
				"body":        bytesToJS(n.Body),
				"at":          at,
				"quantumSafe": n.QuantumSafe,
			}
			if n.From != nil {
				notice["from"] = bytesToJS(n.From.Bytes())
				notice["fromName"] = n.FromName
			}
			if n.ReplyKeys != nil {
				notice["replyKeys"] = bytesToJS(n.ReplyKeys.Bytes())
			}
			event("notice", notice)
		}, func(l transfer.Lookback) {
			event("lookback", map[string]any{
				"daysLeft":   l.DaysLeft,
				"daysTotal":  l.DaysTotal,
				"collecting": l.Collecting,
				"finished":   l.Finished,
				"missing":    l.Missing,
				"doneFrom":   unixMilliOrZero(l.DoneFrom),
			})
		})
		sessionKey = key
		return js.ValueOf(addressJS(key)), nil
	})
}

func unixMilliOrZero(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

func inboxClose(js.Value, []js.Value) any {
	inboxMu.Lock()
	s := session
	session, sessionKey = nil, nil
	inboxMu.Unlock()
	if s != nil {
		s.Close()
	}
	return nil
}

// fromArgs reads whether to include the open inbox (args[i]) and the name
// to show with it (args[i+1]), so its owner can reply. Read when called, so
// a Lock meanwhile can't change what goes.
func fromArgs(args []js.Value, i int) (*transfer.From, error) {
	if len(args) <= i || !args[i].Truthy() {
		return nil, nil
	}
	inboxMu.Lock()
	key := sessionKey
	inboxMu.Unlock()
	if key == nil {
		return nil, errNoInbox
	}
	return &transfer.From{Key: key, Name: stringArg(args, i+1)}, nil
}

// replyArg reads the reply keys a message is to be sealed with, if args[i]
// holds any: the ones the inbox it goes to gave this one.
func replyArg(args []js.Value, i int) (*transfer.ReplyKeys, error) {
	if len(args) <= i || !args[i].Truthy() {
		return nil, nil
	}
	return transfer.ParseReplyKeys(bytesArg(args, i))
}

// sendNotice sends a text message to an inbox, at either of its addresses.
// separate sends it from the tab's second identity, connecting it first if
// need be (its progress comes through onProgress like a connect's), rather
// than the main one. atRandom (the "Send at a random moment" setting) waits
// for the beat of cover messages first; otherwise it goes now. include adds
// the inbox open in this tab, with name, so the recipient can reply.
// compressed says the text is raw DEFLATE, which the core checks unpacks.
// replyKeys, the reply keys that inbox gave this one, seal it as a reply:
// quantum-safe, in one message, and only with include. apart (the
// page always asks for it since 2026-10-19) sends a message to a
// quantum-safe address as its two messages one at a time, each in a round of
// its own, and onProgress hears "apart" once the first has been delivered.
// slynk.me's page no longer sends atRandom (2026-10-18); file notices
// always wait.
func sendNotice(_ js.Value, args []js.Value) any {
	addr := bytesArg(args, 0)
	text := bytesArg(args, 1)
	separate := len(args) > 2 && args[2].Truthy()
	progress := progressFn(args, 3)
	atRandom := len(args) > 4 && args[4].Truthy()
	from, fromErr := fromArgs(args, 5)
	kind := byte(transfer.NoticeText)
	if len(args) > 7 && args[7].Truthy() {
		kind |= transfer.NoticeDeflate
	}
	reply, replyErr := replyArg(args, 8)
	when := transfer.NoticeTiming{AtRandom: atRandom, Apart: len(args) > 9 && args[9].Truthy()}
	// The inbox included is being checked by the main identity, so a message
	// carrying it always goes from the second one, whatever the page says.
	separate = separate || from != nil
	return promise(func() (any, error) {
		if fromErr != nil {
			return nil, fromErr
		}
		if replyErr != nil {
			return nil, replyErr
		}
		if reply != nil && from == nil {
			return nil, transfer.ErrReplyKeys // before connecting anything
		}
		to, err := transfer.ParseInboxAddress(addr)
		if err != nil {
			return nil, err
		}
		var c *transfer.Client
		if separate {
			c, err = noticeIdentity(progress)
		} else {
			c, err = connected()
		}
		if err != nil {
			return nil, err
		}
		at, err := c.SendNoticeAt(to, kind, text, from, reply, when, progress)
		if err != nil {
			return nil, err
		}
		return at.UnixMilli(), nil
	})
}

// sendFileNotice tells an inbox about an upload made for it (files to
// inboxes): a notice carrying the upload's v1 link, from the tab's
// second identity, never the one that uploaded. It waits until a random 1-3
// minutes after since (the upload's end, in Unix milliseconds), then for the
// beat of cover messages. progress hears the second identity's connect,
// then "waiting". include, name, replyKeys and apart: as for sendNotice.
func sendFileNotice(_ js.Value, args []js.Value) any {
	addr := bytesArg(args, 0)
	link := bytesArg(args, 1)
	since := time.Now()
	if len(args) > 2 && args[2].Type() == js.TypeNumber {
		since = time.UnixMilli(int64(args[2].Float()))
	}
	progress := progressFn(args, 3)
	from, fromErr := fromArgs(args, 4)
	reply, replyErr := replyArg(args, 6)
	when := transfer.NoticeTiming{AtRandom: true, Apart: len(args) > 7 && args[7].Truthy()}
	// Its stop is in place before this call returns, so a stopFileNotice the
	// page sends straight after always finds it.
	stop := make(chan struct{})
	fileNoticeMu.Lock()
	fileNoticeStop = stop
	fileNoticeMu.Unlock()
	return promise(func() (any, error) {
		defer func() {
			fileNoticeMu.Lock()
			if fileNoticeStop == stop {
				fileNoticeStop = nil
			}
			fileNoticeMu.Unlock()
		}()
		if fromErr != nil {
			return nil, fromErr
		}
		if replyErr != nil {
			return nil, replyErr
		}
		if reply != nil && from == nil {
			return nil, transfer.ErrReplyKeys // now, rather than after minutes of waiting
		}
		to, err := transfer.ParseInboxAddress(addr)
		if err != nil {
			return nil, err
		}
		// Connecting counts towards the wait: it starts from the upload.
		until := transfer.UploadNoticeTime(since, time.Now())
		c, err := noticeIdentity(progress)
		if err != nil {
			return nil, err
		}
		progress("waiting", 0, 0)
		select {
		case <-time.After(time.Until(until)):
		case <-stop:
			return nil, errNoticeStopped
		}
		// From here it goes: a stop that comes now is told it's too late.
		fileNoticeMu.Lock()
		select {
		case <-stop:
			fileNoticeMu.Unlock()
			return nil, errNoticeStopped
		default:
		}
		if fileNoticeStop == stop {
			fileNoticeStop = nil
		}
		fileNoticeMu.Unlock()
		at, err := c.SendNoticeAt(to, transfer.NoticeLink, link, from, reply, when, progress)
		if err != nil {
			return nil, err
		}
		return at.UnixMilli(), nil
	})
}

// stopFileNotice stops the file notice waiting for its moment: its
// promise rejects with the code "stopped". It reports whether it was in
// time; once the notice has started to go, it can't be called back.
func stopFileNotice(js.Value, []js.Value) any {
	fileNoticeMu.Lock()
	defer fileNoticeMu.Unlock()
	if fileNoticeStop == nil {
		return false
	}
	close(fileNoticeStop)
	fileNoticeStop = nil
	return true
}

// noticeConnect connects the separate identity ahead of a send: the page
// asks as soon as someone starts writing to another inbox, so Send needn't
// wait for it, and its registration doesn't mark the moment of sending.
func noticeConnect(_ js.Value, args []js.Value) any {
	progress := progressFn(args, 0)
	return promise(func() (any, error) {
		_, err := noticeIdentity(progress)
		return nil, err
	})
}

// noticeIdentity connects the separate identity notices go from, once. The
// lock is never held while connecting: JavaScript's calls into Go (cover)
// take it too, and must never wait on the network. A send that finds it
// still connecting (noticeConnect started it) says so while it waits.
func noticeIdentity(progress transfer.Progress) (*transfer.Client, error) {
	waited := false
	for {
		noticeMu.Lock()
		if c := noticeClient; c != nil {
			noticeMu.Unlock()
			if waited {
				progress("ready", 0, 0)
			}
			return c, nil
		}
		if wait := noticeConnecting; wait != nil {
			noticeMu.Unlock()
			if !waited {
				progress("identity", 0, 0)
				waited = true
			}
			<-wait
			continue
		}
		done := make(chan struct{})
		stop := make(chan struct{})
		noticeConnecting = done
		noticeStop = stop
		noticeSince = time.Now()
		noticeMu.Unlock()

		c, err := transfer.ConnectStoppable(progress, stop)
		noticeMu.Lock()
		noticeConnecting = nil
		noticeStop = nil
		if err == nil {
			noticeClient = c
			mu.Lock()
			on := coverOn
			mu.Unlock()
			c.SetCover(on)
		}
		noticeMu.Unlock()
		close(done)
		if errors.Is(err, transfer.ErrConnectStopped) {
			continue // restarted from the page: a fresh identity joins in its place
		}
		return c, err
	}
}

// noticeRestart gives up the second identity's join under way, if any: a
// send waiting for it carries on with a fresh identity once that has
// joined. Reports whether there was one to give up.
func noticeRestart(js.Value, []js.Value) any {
	noticeMu.Lock()
	defer noticeMu.Unlock()
	if noticeStop == nil {
		return false
	}
	close(noticeStop)
	noticeStop = nil
	return true
}

// noticeJoining is when the second identity's join under way began, in Unix
// milliseconds, or 0 when none is (status reports it, for Settings).
func noticeJoining() int64 {
	noticeMu.Lock()
	defer noticeMu.Unlock()
	if noticeStop == nil {
		return 0
	}
	return noticeSince.UnixMilli()
}

func setNoticeCover(on bool) {
	noticeMu.Lock()
	defer noticeMu.Unlock()
	if noticeClient != nil {
		noticeClient.SetCover(on)
	}
}

func stringArg(args []js.Value, i int) string {
	if len(args) <= i || args[i].Type() != js.TypeString {
		return ""
	}
	return args[i].String()
}
