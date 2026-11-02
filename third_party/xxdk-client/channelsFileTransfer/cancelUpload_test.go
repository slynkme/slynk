////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"gitlab.com/elixxir/client/v4/channelsFileTransfer/store"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/stoppable"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

func (c *trackingCmix) sends() int {
	c.Lock()
	defer c.Unlock()
	return len(c.sendManyCalls)
}

// A cancelled upload sends nothing more, from any queue, and is closed out.
func Test_CancelUpload_StopsSending(t *testing.T) {
	m, c := newByRoundTestManager(t, true)
	st, parts, done := startByRoundUpload(t, m)
	fid := st.GetFileID()

	require.True(t, m.cancelSend(fid))
	require.Equal(t, store.Failed, st.Status())
	_, stillThere := m.sent.GetTransfer(fid)
	require.False(t, stillThere, "the cancelled upload wasn't closed")
	require.Nil(t, m.byRound.get(fid))

	// Parts in a batch waiting to go are skipped.
	m.sendCmix(parts)
	require.Zero(t, c.sends(), "a cancelled upload's parts were sent")

	// Parts waiting to be batched are dropped.
	stop := m.startBatchBuilder(t)
	for _, p := range parts {
		m.batchQueue <- p
	}
	time.Sleep(3 * unfilledPacketTimeout)
	close(stop)
	require.Empty(t, m.sendQueue, "a cancelled upload's parts were batched")

	// Parts re-queued after a failed round aren't put back.
	m.requeueAfter(parts, 0, make(chan struct{}))
	require.Empty(t, m.batchQueue, "a cancelled upload's parts were re-queued")

	// A round that carried some of it before the cancel doesn't complete it.
	m.roundResultsCallback(parts)(
		true, false, map[id.Round]cmix.RoundResult{0: {Status: cmix.Succeeded}})
	time.Sleep(100 * time.Millisecond)
	require.Empty(t, done, "a cancelled upload completed")

	// Cancelling again finds nothing to do.
	require.False(t, m.cancelSend(fid))
}

// The same file uploaded again after a cancel starts afresh.
func Test_CancelUpload_SameFileAgain(t *testing.T) {
	m, _ := newByRoundTestManager(t, true)
	st1, _, _ := startByRoundUpload(t, m)
	require.True(t, m.cancelSend(st1.GetFileID()))

	st2, parts, done := startByRoundUpload(t, m)
	require.NotSame(t, st1, st2)
	require.Equal(t, store.Running, st2.Status())
	require.NotEqual(t, st1.GetRecipient(), st2.GetRecipient())

	m.sendCmix(parts)
	select {
	case fl := <-done:
		require.Equal(t, st2.GetRecipient(), fl.RecipientID)
	case <-time.After(5 * time.Second):
		t.Fatal("the new upload never completed")
	}
}

// Through the wrapper, the event model hears of the cancel; an upload that
// has already completed is left as it is.
func Test_CancelUpload_Wrapper(t *testing.T) {
	m, _ := newByRoundTestManager(t, true)
	ev := newMockEventModel(func(ModelFile) {}, nil, t)
	w := &Wrapper{m: m, ev: ev}

	st, _, _ := startByRoundUpload(t, m)
	fid := st.GetFileID()
	require.NoError(t, ev.ReceiveFile(fid, nil, nil, netTime.Now(), Uploading))
	require.NoError(t, w.CancelUpload(fid))
	f, err := ev.GetFile(fid)
	require.NoError(t, err)
	require.Equal(t, Error, f.Status)

	// Already closed out: nothing changes.
	done := Complete
	require.NoError(t, ev.UpdateFile(fid, []byte("link"), nil, nil, &done))
	require.NoError(t, w.CancelUpload(fid))
	f, err = ev.GetFile(fid)
	require.NoError(t, err)
	require.Equal(t, Complete, f.Status)

	// Never uploaded at all: nothing to do.
	require.NoError(t, w.CancelUpload(ftCrypto.NewID([]byte("never sent"))))
}

// startBatchBuilder runs the batch builder until the returned channel closes.
func (m *manager) startBatchBuilder(t *testing.T) chan struct{} {
	t.Helper()
	stop := make(chan struct{})
	single := stoppable.NewSingle("cancelUploadBatchBuilder")
	go m.batchBuilderThread(single)
	go func() {
		<-stop
		_ = single.Close()
	}()
	return stop
}
