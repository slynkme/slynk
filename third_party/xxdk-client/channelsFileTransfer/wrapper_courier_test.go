////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"math/rand"
	"testing"
	"time"

	json "github.com/goccy/go-json"
	"github.com/stretchr/testify/require"

	"gitlab.com/elixxir/client/v4/channels"
	cryptoChannel "gitlab.com/elixxir/crypto/channel"
	"gitlab.com/elixxir/crypto/fastRNG"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
)

// Courier fork additions (XXN-574): coverage for Download's file-link
// precedence and for CloseReceive.
//
// Both exist for the same reason. File IDs are content-addressed, so the same
// bytes always produce the same ID — which means a file whose FileLink expired
// can be re-announced only under that same ID, with a fresh link. Recovering
// from that requires two things upstream did not have: Download must keep the
// NEWER of the inbound and stored links (and start the transfer from the same
// one it persists), and there must be a way to abandon the dead transfer so a
// retry does not short-circuit onto it.

// newCourierTestWrapper builds a single wired Wrapper over mock cMix, storage
// and event model. Unlike Test_FileTransfer_Smoke it does not start processes
// or pair a second client: these tests drive Download directly and assert on
// the event model and the received-transfer list, so no parts ever move.
func newCourierTestWrapper(t *testing.T, name string) (*Wrapper, *mockEventModel) {
	t.Helper()

	prng := rand.New(rand.NewSource(1978))
	rngGen := fastRNG.NewStreamGenerator(1000, 10, csprng.NewSystemRNG)

	myID := id.NewIdFromString(name, id.User, t)
	storage := newMockStorage()
	cMix := newMockCmix(myID, newMockCmixHandler(), storage)
	user := newMockE2e(myID, cMix, storage, rngGen)

	w, eb, err := NewWrapper(user, DefaultParams())
	require.NoError(t, err)

	me, err := cryptoChannel.GenerateIdentity(prng)
	require.NoError(t, err)

	ch, err := newMockChannelsManager(me)
	require.NoError(t, err)

	ev := newMockEventModel(
		func(ModelFile) {}, func(channels.ModelMessage) {}, t)

	_, err = eb(ev, ch, me)
	require.NoError(t, err)

	return w, ev
}

// courierTestLink builds a syntactically complete FileLink. recipient doubles
// as the key/MAC seed so a test can identify which link won by its recipient
// ID alone.
func courierTestLink(
	t *testing.T, fid ftCrypto.ID, recipient string, sent time.Time) FileLink {
	t.Helper()

	var key ftCrypto.TransferKey
	copy(key[:], recipient)

	return FileLink{
		FileID:        fid,
		RecipientID:   id.NewIdFromString(recipient, id.User, t),
		SentTimestamp: sent,
		Key:           key,
		Mac:           []byte(recipient + "-mac"),
		Size:          16,
		NumParts:      1,
		Retry:         1.0,
	}
}

func courierTestInfo(fl FileLink) []byte {
	fi := FileInfo{
		Name:     "courier.opus",
		Type:     "opus",
		Preview:  []byte("preview"),
		FileLink: fl,
	}
	b, _ := json.Marshal(&fi)
	return b
}

// storedLinkRecipient reads back the recipient ID of the link the event model
// currently holds for fid — i.e. the link a restart would resume from.
func storedLinkRecipient(t *testing.T, ev *mockEventModel, fid ftCrypto.ID) *id.ID {
	t.Helper()

	f, err := ev.GetFile(fid)
	require.NoError(t, err)

	var fl FileLink
	require.NoError(t, json.Unmarshal(f.Link, &fl))

	return fl.RecipientID
}

// Test_Wrapper_Download_KeepsTheNewerInboundLink covers the case the inverted
// conditional got backwards: an existing non-Complete row whose stored link is
// OLDER than the one that just arrived. The fresh link must win, because the
// stale one's parts are the ones that are gone.
func Test_Wrapper_Download_KeepsTheNewerInboundLink(t *testing.T) {
	w, ev := newCourierTestWrapper(t, "inboundNewer")

	fid := ftCrypto.NewID([]byte("inbound-newer-payload"))
	now := time.Now()

	stored := courierTestLink(t, fid, "staleRecipient", now.Add(-2*time.Hour))
	storedJSON, err := json.Marshal(stored)
	require.NoError(t, err)
	require.NoError(t,
		ev.ReceiveFile(fid, storedJSON, nil, now.Add(-2*time.Hour), Downloading))

	inbound := courierTestLink(t, fid, "freshRecipient", now)
	_, err = w.Download(courierTestInfo(inbound), nil, 100*time.Millisecond)
	require.NoError(t, err)

	require.Equal(t, inbound.RecipientID, storedLinkRecipient(t, ev, fid),
		"the newer inbound link must be the one persisted")

	rt, exists := w.m.received.GetTransfer(fid)
	require.True(t, exists, "a transfer must have been started")
	require.Equal(t, inbound.RecipientID, rt.GetRecipient(),
		"the started transfer must use the same link that was persisted")
}

// Test_Wrapper_Download_KeepsTheNewerStoredLink is the other arm: a re-announce
// carrying an OLDER link must not clobber a newer stored one. Together with the
// test above this pins the precedence in both directions — the pre-fix code got
// both wrong, one by inverting the comparison and one by falling through.
func Test_Wrapper_Download_KeepsTheNewerStoredLink(t *testing.T) {
	w, ev := newCourierTestWrapper(t, "storedNewer")

	fid := ftCrypto.NewID([]byte("stored-newer-payload"))
	now := time.Now()

	stored := courierTestLink(t, fid, "freshRecipient", now)
	storedJSON, err := json.Marshal(stored)
	require.NoError(t, err)
	require.NoError(t, ev.ReceiveFile(fid, storedJSON, nil, now, Downloading))

	inbound := courierTestLink(t, fid, "staleRecipient", now.Add(-2*time.Hour))
	_, err = w.Download(courierTestInfo(inbound), nil, 100*time.Millisecond)
	require.NoError(t, err)

	require.Equal(t, stored.RecipientID, storedLinkRecipient(t, ev, fid),
		"the newer stored link must be retained")

	rt, exists := w.m.received.GetTransfer(fid)
	require.True(t, exists, "a transfer must have been started")
	require.Equal(t, stored.RecipientID, rt.GetRecipient(),
		"the started transfer must use the same link that was persisted")
}

// Test_Wrapper_CloseReceive_RemovesTheTransferAndKeepsTheRow pins the contract:
// the transfer goes, the event-model row stays (its owner decides that).
func Test_Wrapper_CloseReceive_RemovesTheTransferAndKeepsTheRow(t *testing.T) {
	w, ev := newCourierTestWrapper(t, "closeReceive")

	fid := ftCrypto.NewID([]byte("close-receive-payload"))
	inbound := courierTestLink(t, fid, "someRecipient", time.Now())

	_, err := w.Download(courierTestInfo(inbound), nil, 100*time.Millisecond)
	require.NoError(t, err)

	_, exists := w.m.received.GetTransfer(fid)
	require.True(t, exists, "precondition: the download registered a transfer")

	require.NoError(t, w.CloseReceive(fid))

	_, exists = w.m.received.GetTransfer(fid)
	require.False(t, exists, "CloseReceive must remove the received transfer")

	_, err = ev.GetFile(fid)
	require.NoError(t, err, "CloseReceive must NOT touch the event model row")
}

// Test_Wrapper_CloseReceive_UnknownIDIsANoOp lets a caller close speculatively
// before a retry without first checking whether a transfer exists.
func Test_Wrapper_CloseReceive_UnknownIDIsANoOp(t *testing.T) {
	w, _ := newCourierTestWrapper(t, "closeReceiveUnknown")

	require.NoError(t, w.CloseReceive(ftCrypto.NewID([]byte("never-downloaded"))))
}

// Test_Wrapper_CloseReceive_ThenDownloadRebindsToTheFreshLink is the property
// the whole patch exists for, end to end: a download wedged on an expired link
// can be retried IN-PROCESS against a re-announce.
//
// Without CloseReceive the second Download short-circuits onto the still-
// registered dead transfer and returns without rebinding anything; without the
// link-precedence fix it rebinds to the stale stored link. Both halves are
// required, which is why they ship together.
func Test_Wrapper_CloseReceive_ThenDownloadRebindsToTheFreshLink(t *testing.T) {
	w, ev := newCourierTestWrapper(t, "closeReceiveRetry")

	fid := ftCrypto.NewID([]byte("retry-payload"))
	now := time.Now()

	first := courierTestLink(t, fid, "deadRecipient", now.Add(-3*time.Hour))
	_, err := w.Download(courierTestInfo(first), nil, 100*time.Millisecond)
	require.NoError(t, err)

	rt, exists := w.m.received.GetTransfer(fid)
	require.True(t, exists)
	require.Equal(t, first.RecipientID, rt.GetRecipient())

	// The link expires and the peer re-announces the same content under the
	// same content-addressed ID with a fresh link.
	require.NoError(t, w.CloseReceive(fid))

	second := courierTestLink(t, fid, "liveRecipient", now)
	_, err = w.Download(courierTestInfo(second), nil, 100*time.Millisecond)
	require.NoError(t, err)

	rt, exists = w.m.received.GetTransfer(fid)
	require.True(t, exists, "the retry must register a new transfer")
	require.Equal(t, second.RecipientID, rt.GetRecipient(),
		"the retry must listen on the FRESH link's recipient")
	require.Equal(t, second.RecipientID, storedLinkRecipient(t, ev, fid),
		"and must persist that same link for a later resume")
}
