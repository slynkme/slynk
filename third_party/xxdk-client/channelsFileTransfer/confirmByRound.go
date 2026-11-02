////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"sync"
	"sync/atomic"

	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/channelsFileTransfer/store"
	"gitlab.com/elixxir/client/v4/cmix"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/primitives/id"
)

// By default an uploader confirms its parts by downloading them back: it
// tracks the upload's recipient ID and registers the parts' fingerprints, and
// re-sends any part it hasn't seen after ResendWait. That polling ties the
// uploader's IP address to the recipient ID, which every downloader later
// polls too.
//
// With confirm-by-round on, a part counts as delivered once the round that
// carried it reports Succeeded, and the uploader never polls the recipient.
// That removes only the uploader's own poll. Gateways still share, for every
// round, its senders (with their IP addresses) and the recipient IDs it
// delivered to, so a sender whose parts fill several rounds for one recipient
// can still be matched to it, round by round.
//
// It is also best-effort. Succeeded means every node finished the round, not
// that this message passed every node's checks or that a gateway has stored
// it, and nothing re-sends a part lost after that. A round whose outcome is
// unknown counts as failed, and its parts are sent again.

// SetConfirmByRound chooses how later uploads confirm their parts: false (the
// default) downloads them back; true trusts each round's own result. Uploads
// already under way keep the mode they started with.
func (w *Wrapper) SetConfirmByRound(on bool) {
	w.m.byRound.on.Store(on)
}

// roundConfirmedUploads holds the uploads confirmed by round.
type roundConfirmedUploads struct {
	on        atomic.Bool
	mux       sync.Mutex
	transfers map[ftCrypto.ID]*roundConfirmedUpload
}

type roundConfirmedUpload struct {
	st         *store.SentTransfer
	fl         FileLink
	completeCB sendCompleteCallback
}

// add records an upload that will be confirmed by round.
func (r *roundConfirmedUploads) add(
	st *store.SentTransfer, fl *FileLink, completeCB sendCompleteCallback) {
	r.mux.Lock()
	defer r.mux.Unlock()
	if r.transfers == nil {
		r.transfers = make(map[ftCrypto.ID]*roundConfirmedUpload)
	}
	r.transfers[st.GetFileID()] = &roundConfirmedUpload{st, *fl, completeCB}
}

func (r *roundConfirmedUploads) get(fid ftCrypto.ID) *roundConfirmedUpload {
	r.mux.Lock()
	defer r.mux.Unlock()
	return r.transfers[fid]
}

// take removes an upload and reports whether this caller removed it, so only
// one caller ever completes it.
func (r *roundConfirmedUploads) take(fid ftCrypto.ID) bool {
	r.mux.Lock()
	defer r.mux.Unlock()
	_, ok := r.transfers[fid]
	delete(r.transfers, fid)
	return ok
}

// roundSucceeded is true only if every round reports Succeeded. The
// callback's own allRoundsSucceeded can be true for a round whose outcome is
// still unknown (TimeOut), which is safe when parts are read back but not
// when the round result is all there is.
func roundSucceeded(results map[id.Round]cmix.RoundResult) bool {
	if len(results) == 0 {
		return false
	}
	for _, rr := range results {
		if rr.Status != cmix.Succeeded {
			return false
		}
	}
	return true
}

// confirmByRound handles a round result for one file's parts if that file is
// confirmed by round, and reports whether it did. Confirmed parts are marked
// received; parts of a round that didn't succeed go back to the queue, after
// the usual backoff.
func (m *manager) confirmByRound(
	fid ftCrypto.ID, parts []*store.Part, succeeded bool) bool {
	// The entry must belong to the transfer now registered for this file: a
	// later upload of the same content may read its parts back.
	u := m.byRound.get(fid)
	if u == nil {
		return false
	}
	if st, ok := m.sent.GetTransfer(fid); !ok || st != u.st {
		return false
	}
	if !succeeded {
		m.requeueFailedParts(map[ftCrypto.ID][]*store.Part{fid: parts})
		return true
	}

	for _, p := range parts {
		// A part confirmed twice (sent again after a round with no result
		// that had in fact succeeded) must not be marked twice.
		if p.GetStatus() != store.ReceivedPart {
			p.MarkReceived()
		}
	}
	m.callbacks.Call(fid, nil)
	m.clearSendBackoff(fid)

	if u.st.Status() != store.Completed || !m.byRound.take(fid) {
		return true
	}
	jww.DEBUG.Printf("[FT] Completed sending file %s (confirmed by round).", fid)
	if err := m.closeSend(u.st); err != nil {
		jww.ERROR.Printf(
			"[FT] Failed to close file transfer send %s: %+v", fid, err)
	}
	go u.completeCB(u.fl)
	return true
}
