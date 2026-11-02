////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package channels

import (
	"math/rand"
	"sync"
	"testing"
	"time"

	"github.com/pkg/errors"

	"gitlab.com/elixxir/client/v4/cmix/identity"
	"gitlab.com/elixxir/client/v4/cmix/message"
	"gitlab.com/elixxir/client/v4/collective"
	cryptoBroadcast "gitlab.com/elixxir/crypto/broadcast"
	cryptoChannel "gitlab.com/elixxir/crypto/channel"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/ekv"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

// XXN-628. ReplayChannel used to return nil unconditionally, so a replay that
// armed nothing was indistinguishable from one that worked — and the one-shot
// repair built on it stamped its marker over a no-op, spending its only attempt.
// These tests cover the contract that replaces that: a nil return means the
// channel's identity was re-registered, and anything else is an error.

// mockReplayClient records the identity calls a replay makes and controls what
// the read-back sees.
type mockReplayClient struct {
	mockBroadcastClient

	mu sync.Mutex
	// calls is the identity call sequence, "remove" / "add", in order. Order is
	// the property under test: the remove must be issued before the add.
	calls []string
	// beginning is the backdate the re-registration carried.
	beginning time.Time

	// creation is what GetIdentity reports. A registration that lands on an
	// untracked identity moves it, exactly as the tracker does.
	creation time.Time
	// foldAdds models the tracker's isOld path — a registration for an identity
	// that is still tracked updates its properties and leaves Creation alone —
	// and gone models the identity having been removed outright. Those are the
	// two states an out-of-order replay leaves behind.
	foldAdds bool
	gone     bool
}

func (m *mockReplayClient) AddIdentityWithHistory(_ *id.ID, _, beginning time.Time,
	_ bool, _ message.Processor) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, "add")
	m.beginning = beginning
	if !m.foldAdds {
		m.creation = netTime.Now()
	}
}

func (m *mockReplayClient) RemoveIdentity(*id.ID) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, "remove")
}

func (m *mockReplayClient) GetIdentity(get *id.ID) (identity.TrackedID, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.gone {
		return identity.TrackedID{}, errors.Errorf("could not find id %s", get)
	}
	return identity.TrackedID{Source: get, Creation: m.creation}, nil
}

func (m *mockReplayClient) sequence() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.calls...)
}

func (m *mockReplayClient) historyBeginning() time.Time {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.beginning
}

// newReplayTestManager builds a manager holding one joined channel over
// mockReplayClient, and returns both plus the channel.
func newReplayTestManager(t *testing.T) (
	*manager, *mockReplayClient, *cryptoBroadcast.Channel) {
	t.Helper()

	pi, err := cryptoChannel.GenerateIdentity(rand.New(rand.NewSource(64)))
	if err != nil {
		t.Fatalf("GenerateIdentity error: %+v", err)
	}

	// Registered identities read as fresh until a test says otherwise, so the
	// join below does not trip the replay confirmation.
	net := &mockReplayClient{creation: netTime.Now()}

	kv := collective.TestingKV(t, ekv.MakeMemstore(), collective.StandardPrefexs, nil)
	mFace, err := NewManagerBuilder(pi, kv, net,
		fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG),
		mockEventModelBuilder, nil, mockAddServiceFn, newMockNM(),
		&dummyUICallback{})
	if err != nil {
		t.Fatalf("NewManagerBuilder error: %+v", err)
	}
	m := mFace.(*manager)

	stream := m.rng.GetStream()
	ch, _, err := newTestChannel("replay", "replay", stream, cryptoBroadcast.Public)
	stream.Close()
	if err != nil {
		t.Fatalf("newTestChannel error: %+v", err)
	}
	if err = m.addChannel(ch, true); err != nil {
		t.Fatalf("addChannel error: %+v", err)
	}

	// Drop the join's own calls; only the replay's are interesting.
	net.mu.Lock()
	net.calls = nil
	net.mu.Unlock()

	return m, net, ch
}

// shortenReplayWait shrinks the confirmation bound for the duration of a test,
// so the failure paths do not have to wait out the production timeout.
func shortenReplayWait(t *testing.T) {
	t.Helper()
	timeout, poll := replayArmedTimeout, replayArmedPoll
	replayArmedTimeout, replayArmedPoll = 100*time.Millisecond, 5*time.Millisecond
	t.Cleanup(func() { replayArmedTimeout, replayArmedPoll = timeout, poll })
}

// TestManager_ReplayChannel pins the successful contract: the identity is
// removed BEFORE it is re-added, the re-add carries the channel's creation time
// as its backdate, and the call reports success only once the re-registration
// has been read back.
//
// The order is the load-bearing assertion. Re-adding an identity that is still
// tracked folds into the existing entry and discards the backdated window, and
// the remove then drops the identity outright — which is how this replay came to
// re-pull nothing at all on mainnet.
func TestManager_ReplayChannel(t *testing.T) {
	m, net, ch := newReplayTestManager(t)

	if err := m.ReplayChannel(ch.ReceptionID); err != nil {
		t.Fatalf("ReplayChannel error: %+v", err)
	}

	got := net.sequence()
	if len(got) != 2 || got[0] != "remove" || got[1] != "add" {
		t.Errorf("identity calls were %v, want [remove add]; an add applied "+
			"before its remove arms no history and then loses the identity", got)
	}
	if !net.historyBeginning().Equal(ch.Created) {
		t.Errorf("re-registered from %s, want the channel's creation %s — the "+
			"backdate is what makes this a replay rather than a re-join",
			net.historyBeginning(), ch.Created)
	}
}

// TestManager_ReplayChannel_notRearmed covers the case the confirmation exists
// for: the identity is still tracked, but under its ORIGINAL registration. That
// is what an out-of-order add leaves behind, and nothing will be re-retrieved.
func TestManager_ReplayChannel_notRearmed(t *testing.T) {
	shortenReplayWait(t)
	m, net, ch := newReplayTestManager(t)

	net.mu.Lock()
	net.foldAdds = true
	net.creation = netTime.Now().Add(-48 * time.Hour)
	net.mu.Unlock()

	err := m.ReplayChannel(ch.ReceptionID)
	if err == nil {
		t.Fatal("ReplayChannel reported success over a registration that was " +
			"never refreshed; a one-shot repair would record this as done")
	}

	// The broadcast must still have been re-created. The stop already happened,
	// so bailing out before the re-add would leave the channel off the air —
	// strictly worse than an unreplayed channel.
	if got := net.sequence(); len(got) != 2 || got[1] != "add" {
		t.Errorf("identity calls were %v; the channel must be re-registered even "+
			"when the replay cannot be confirmed", got)
	}
}

// TestManager_ReplayChannel_untracked covers the other failure: the identity is
// gone entirely, which is the out-of-order case at the moment the remove lands
// last. The channel receives nothing further until the next launch re-registers
// it, so this must never be reported as a completed replay.
func TestManager_ReplayChannel_untracked(t *testing.T) {
	shortenReplayWait(t)
	m, net, ch := newReplayTestManager(t)

	net.mu.Lock()
	net.gone = true
	net.mu.Unlock()

	if err := m.ReplayChannel(ch.ReceptionID); err == nil {
		t.Fatal("ReplayChannel reported success over an identity that is not " +
			"tracked at all")
	}
}

// TestManager_ReplayChannel_notJoined keeps the pre-existing contract intact:
// an unjoined channel is reported as such, and distinguishably, so a one-shot
// repair can skip a channel that was left between enumerating and replaying
// rather than failing the whole pass.
func TestManager_ReplayChannel_notJoined(t *testing.T) {
	m, _, _ := newReplayTestManager(t)

	err := m.ReplayChannel(id.NewIdFromString("nope", id.User, t))
	if err != ChannelDoesNotExistsErr {
		t.Errorf("got %v, want ChannelDoesNotExistsErr", err)
	}
}
