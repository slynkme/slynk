////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"errors"
	"math/rand"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"gitlab.com/elixxir/client/v4/channelsFileTransfer/sentRoundTracker"
	"gitlab.com/elixxir/client/v4/channelsFileTransfer/store"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/message"
	"gitlab.com/elixxir/crypto/fastRNG"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
)

// trackingCmix counts every way an uploader could start polling a recipient.
type trackingCmix struct {
	*mockCmix
	tracked atomic.Int32
}

func (c *trackingCmix) AddIdentity(*id.ID, time.Time, bool, message.Processor) {
	c.tracked.Add(1)
}

func (c *trackingCmix) AddIdentityWithHistory(
	*id.ID, time.Time, time.Time, bool, message.Processor) {
	c.tracked.Add(1)
}

func newByRoundTestManager(t *testing.T, on bool) (*manager, *trackingCmix) {
	t.Helper()
	myID := id.NewIdFromString("byRoundTestID", id.User, t)
	storage := newMockStorage()
	c := &trackingCmix{mockCmix: newMockCmix(myID, newMockCmixHandler(), storage)}
	rngGen := fastRNG.NewStreamGenerator(1000, 10, csprng.NewSystemRNG)

	params := DefaultParams()
	params.MaxThroughput = 0
	params.SendRetryWait = 50 * time.Millisecond
	params.MaxSendRetryWait = 50 * time.Millisecond
	m, _, _, err := newManager(newMockE2e(myID, c, storage, rngGen), params)
	require.NoError(t, err)
	m.params.Cmix.ExcludedRounds = sentRoundTracker.NewManager(clearSentRoundsAge)
	quit := make(chan struct{})
	m.quit = quit
	t.Cleanup(func() { close(quit) })

	w := &Wrapper{m: m}
	w.SetConfirmByRound(on)
	return m, c
}

func startByRoundUpload(t *testing.T, m *manager) (
	*store.SentTransfer, []*store.Part, chan FileLink) {
	t.Helper()
	data := make([]byte, 4_000)
	rand.New(rand.NewSource(57)).Read(data)
	done := make(chan FileLink, 1)
	st, err := m.send(ftCrypto.NewID(data), data, 2, func(fl FileLink) { done <- fl }, nil)
	require.NoError(t, err)
	parts := st.GetUnsentParts()
	for range parts {
		<-m.batchQueue
	}
	return st, parts, done
}

// With confirm-by-round on, an upload completes from its rounds' results
// alone, and the uploader never starts tracking the recipient.
func Test_ConfirmByRound_CompletesWithoutTracking(t *testing.T) {
	m, c := newByRoundTestManager(t, true)
	st, parts, done := startByRoundUpload(t, m)
	require.Greater(t, len(parts), 1)

	m.sendCmix(parts) // the mock reports the round as Succeeded

	select {
	case fl := <-done:
		require.Equal(t, st.GetFileID(), fl.FileID)
		require.Equal(t, st.GetRecipient(), fl.RecipientID)
	case <-time.After(5 * time.Second):
		t.Fatal("the upload never completed")
	}
	require.Equal(t, store.Completed, st.Status())
	require.Zero(t, c.tracked.Load(), "the uploader tracked the recipient")
	_, stillThere := m.sent.GetTransfer(st.GetFileID())
	require.False(t, stillThere, "the completed upload wasn't closed")
	require.Nil(t, m.byRound.get(st.GetFileID()))
}

// "All rounds succeeded" with a round whose own status is still TimeOut must
// not confirm anything: the parts go back to the queue.
func Test_ConfirmByRound_UnknownRoundIsResent(t *testing.T) {
	m, _ := newByRoundTestManager(t, true)
	st, parts, done := startByRoundUpload(t, m)

	m.roundResultsCallback(parts)(
		true, false, map[id.Round]cmix.RoundResult{0: {Status: cmix.TimeOut}})

	require.Eventually(t, func() bool { return len(m.batchQueue) == len(parts) },
		2*time.Second, 10*time.Millisecond, "unconfirmed parts weren't re-queued")
	require.Equal(t, store.Running, st.Status())
	require.Zero(t, st.NumReceived())
	select {
	case <-done:
		t.Fatal("an unconfirmed upload completed")
	default:
	}
}

// A failed round re-queues its parts, as it always has.
func Test_ConfirmByRound_FailedRoundIsResent(t *testing.T) {
	m, _ := newByRoundTestManager(t, true)
	st, parts, _ := startByRoundUpload(t, m)

	m.roundResultsCallback(parts)(
		false, false, map[id.Round]cmix.RoundResult{0: {Status: cmix.Failed}})

	require.Eventually(t, func() bool { return len(m.batchQueue) == len(parts) },
		2*time.Second, 10*time.Millisecond, "failed parts weren't re-queued")
	require.Zero(t, st.NumReceived())
}

// Rounds that confirm parts in pieces complete the upload exactly once, even
// when their results arrive together.
func Test_ConfirmByRound_CompletesOnce(t *testing.T) {
	m, _ := newByRoundTestManager(t, true)
	st, parts, done := startByRoundUpload(t, m)

	ok := map[id.Round]cmix.RoundResult{0: {Status: cmix.Succeeded}}
	// A part confirmed again while the upload runs (it was re-sent after a
	// round with no result that had in fact succeeded) is harmless.
	m.roundResultsCallback(parts[:1])(true, false, ok)
	m.roundResultsCallback(parts[:1])(true, false, ok)
	for _, p := range parts[1:] {
		go m.roundResultsCallback([]*store.Part{p})(true, false, ok)
	}

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the upload never completed")
	}
	// So is one confirmed after the upload has completed.
	m.roundResultsCallback(parts[:1])(true, false, ok)
	time.Sleep(100 * time.Millisecond)
	require.Empty(t, done, "the upload completed twice")
	require.Equal(t, store.Completed, st.Status())
}

// A by-round upload that failed and was closed leaves nothing behind that
// could take over a later read-back upload of the same file.
func Test_ConfirmByRound_FailedUploadDoesNotLeak(t *testing.T) {
	m, c := newByRoundTestManager(t, true)
	data := make([]byte, 4_000)
	rand.New(rand.NewSource(57)).Read(data)
	fid := ftCrypto.NewID(data)

	// With no retries, one failed send spends every fingerprint, and the
	// next attempt fails the transfer.
	st1, err := m.send(fid, data, 0, func(FileLink) {}, nil)
	require.NoError(t, err)
	parts := st1.GetUnsentParts()
	for range parts {
		<-m.batchQueue
	}
	c.setSendManyErr(errors.New("no network"))
	m.sendCmix(parts)
	m.sendCmix(parts)
	require.Equal(t, store.Failed, st1.Status())
	require.NoError(t, m.closeSend(st1))

	// The same file again, read back this time.
	(&Wrapper{m: m}).SetConfirmByRound(false)
	c.setSendManyErr(nil)
	st2, err := m.send(fid, data, 2, func(FileLink) {}, nil)
	require.NoError(t, err)
	parts2 := st2.GetUnsentParts()
	for range parts2 {
		<-m.batchQueue
	}
	m.roundResultsCallback(parts2)(
		true, false, map[id.Round]cmix.RoundResult{0: {Status: cmix.Succeeded}})
	require.Zero(t, st2.NumReceived(), "a round result confirmed a read-back upload")
	require.Equal(t, uint16(len(parts2)), st2.NumSent())
}

// Off (the default), uploads still read their parts back.
func Test_ConfirmByRound_OffStillReadsBack(t *testing.T) {
	m, c := newByRoundTestManager(t, false)
	startByRoundUpload(t, m)
	require.NotZero(t, c.tracked.Load(), "the default upload stopped tracking")
}

func Test_roundSucceeded(t *testing.T) {
	ok := cmix.RoundResult{Status: cmix.Succeeded}
	for name, c := range map[string]struct {
		results map[id.Round]cmix.RoundResult
		want    bool
	}{
		"none":      {nil, false},
		"succeeded": {map[id.Round]cmix.RoundResult{1: ok}, true},
		"timed out": {map[id.Round]cmix.RoundResult{1: {Status: cmix.TimeOut}}, false},
		"failed":    {map[id.Round]cmix.RoundResult{1: {Status: cmix.Failed}}, false},
		"mixed":     {map[id.Round]cmix.RoundResult{1: ok, 2: {Status: cmix.TimeOut}}, false},
	} {
		require.Equal(t, c.want, roundSucceeded(c.results), name)
	}
}
