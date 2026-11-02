////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package store

// Cancel sets the transfer as failed on purpose, because its sender gave up
// on it: the send loop stops sending its parts (Wrapper.CancelUpload).
func (st *SentTransfer) Cancel() {
	st.markTransferFailed()
}
