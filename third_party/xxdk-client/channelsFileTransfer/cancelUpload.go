////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"

	"gitlab.com/elixxir/client/v4/channels"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/primitives/netTime"
)

// Upstream closes out an upload only once it has completed or failed, so a
// sender who changes their mind can only wait for it to finish. CancelUpload
// fails it on purpose instead. The send loop already drops every part of a
// transfer that isn't Running, wherever the part is: waiting to be batched,
// in a batch waiting to go, or re-queued after a failed round. So nothing
// more of it is sent, and the parts already handed to the network are all
// that leave: at most one batch per sending worker (workerPoolThreads, 4),
// each perhaps still waiting for its round. Those can't be called back.

// CancelUpload stops an upload under way and closes it out, so uploading the
// same file again starts afresh. Its progress callbacks aren't called again.
// It does nothing if the upload has already completed and been closed out.
func (w *Wrapper) CancelUpload(fid ftCrypto.ID) error {
	if !w.m.cancelSend(fid) {
		return nil
	}
	now, status := netTime.Now(), Error
	err := w.ev.UpdateFile(fid, nil, nil, &now, &status)
	if err != nil && !channels.CheckNoMessageErr(err) {
		return errors.Errorf("failed to mark cancelled upload %s: %+v", fid, err)
	}
	return nil
}

// cancelSend fails the sent transfer, if it's still registered, and closes it
// out. It reports whether there was one.
func (m *manager) cancelSend(fid ftCrypto.ID) bool {
	st, ok := m.sent.GetTransfer(fid)
	if !ok {
		return false
	}
	st.Cancel()
	if err := m.closeSend(st); err != nil {
		// Still failed, so nothing more is sent, and a new upload of the same
		// file closes it out before starting (Wrapper.Upload).
		jww.ERROR.Printf("[FT] Failed to close cancelled send %s: %+v", fid, err)
	}
	jww.DEBUG.Printf("[FT] Sent file %s was cancelled.", fid)
	return true
}
