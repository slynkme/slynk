////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package identity

import (
	"crypto/rand"
	"sync"
	"testing"
	"time"

	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/cmix/address"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/storage"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

var initSize uint8 = 8

// func TestManager_processIdentities_expired(t *testing.T) {
// 	// Initialization
// 	addrSpace := address.NewAddressSpace(initSize)
// 	addrSpace.UpdateAddressSpace(18)
// 	session := storage.InitTestingSession(t)
// 	m := &manager{
// 		tracked:        make([]TrackedID, 0),
// 		session:        session,
// 		newIdentity:    make(chan TrackedID, trackedIDChanSize),
// 		deleteIdentity: make(chan *id.ID, deleteIDChanSize),
// 		addrSpace:      addrSpace,
// 		ephemeral:      receptionID.NewOrLoadStore(session.GetKV()),
// 		mux:            &collective.Mutex{},
// 	}

// 	// Add some expired test IDs
// 	for i := uint64(0); i < 10; i++ {
// 		testId := id.NewIdFromUInt(i, id.User, t)
// 		validUntil := netTime.Now()
// 		m.tracked = append(m.tracked, TrackedID{
// 			NextGeneration: netTime.Now().Add(-time.Second),
// 			LastGeneration: time.Time{},
// 			Source:         testId,
// 			ValidUntil:     validUntil,
// 			Persistent:     false,
// 			Creation:       netTime.Now(),
// 		})
// 	}

// 	expected := m.tracked[0].ValidUntil
// 	nextEvent := m.processIdentities(addrSpace.GetAddressSpace())
// 	if len(m.tracked) != 0 {
// 		t.Errorf("Failed to remove expired identities, %d remain", len(m.tracked))
// 	}
// 	if nextEvent != expected {
// 		t.Errorf("Invalid nextEvent, expected %v got %v", expected, nextEvent)
// 	}
// }

func TestManager_processIdentities(t *testing.T) {
	jww.SetStdoutThreshold(jww.LevelDebug)
	// Initialization
	addrSpace := address.NewAddressSpace(initSize)
	addrSpace.UpdateAddressSpace(18)
	session := storage.InitTestingSession(t)
	m := &manager{
		tracked:   make([]*TrackedID, 0),
		session:   session,
		ops:       make(chan trackerOp, trackedIDChanSize),
		addrSpace: addrSpace,
		ephemeral: receptionID.NewOrLoadStore(session.GetKV()),
		mux:       &sync.Mutex{},
	}

	// Add some expired test IDs
	testId := id.NewIdFromUInt(0, id.User, t)
	validUntil := netTime.Now().Add(time.Minute)
	m.tracked = append(m.tracked, &TrackedID{
		NextGeneration: netTime.Now(),
		LastGeneration: time.Time{},
		Source:         testId,
		ValidUntil:     validUntil,
		Persistent:     true,
		Creation:       netTime.Now(),
	})

	_ = m.processIdentities(addrSpace.GetAddressSpace())
	if len(m.tracked) != 1 {
		t.Errorf("Unexpectedly removed identity, %d remain", len(m.tracked))
	}
}

// newTestManager builds a manager over a testing session, matching the wiring
// TestManager_processIdentities uses.
func newTestManager(t *testing.T) (*manager, uint8) {
	t.Helper()
	addrSpace := address.NewAddressSpace(initSize)
	addrSpace.UpdateAddressSpace(18)
	session := storage.InitTestingSession(t)
	return &manager{
		tracked:   make([]*TrackedID, 0),
		session:   session,
		ops:       make(chan trackerOp, trackedIDChanSize),
		addrSpace: addrSpace,
		ephemeral: receptionID.NewOrLoadStore(session.GetKV()),
		mux:       &sync.Mutex{},
	}, addrSpace.GetAddressSpace()
}

// TestManager_processIdentities_zeroNextGenerationRecovers pins the XXN-585
// latch: a TrackedID whose NextGeneration has become the zero time must recover,
// not perpetuate.
//
// The failure it reproduces is self-sustaining, which is what made it survive
// cold restarts on a real device for a day. With NextGeneration at the zero
// time, generateUntil.Sub(LastGeneration) is hugely negative, GetIdsByRange
// returns nothing, NewestIdentity is never assigned, and the function returns
// its zero End — which processIdentities writes straight back into
// NextGeneration. Every subsequent pass repeats it, and t.save() persists it.
//
// Two consequences, both asserted here because either alone is survivable and
// together they are fatal: the identity generates no ephemeral IDs, so the
// follower never polls for it and NOTHING addressed to it is ever received;
// and nextEvent is permanently in the past, so track()'s time.After fires
// instantly and the tracker hot-spins (~150k passes/minute on the S22).
func TestManager_processIdentities_zeroNextGenerationRecovers(t *testing.T) {
	m, addressSize := newTestManager(t)

	source := id.NewIdFromUInt(1, id.User, t)
	m.tracked = append(m.tracked, &TrackedID{
		// The wedged pair, exactly as read off the device: NextGeneration is the
		// zero value while LastGeneration holds a plausible recent timestamp.
		NextGeneration: time.Time{},
		LastGeneration: netTime.Now().Add(-24 * time.Hour),
		Source:         source,
		ValidUntil:     Forever,
		Persistent:     true,
		Creation:       netTime.Now().Add(-48 * time.Hour),
	})

	now := netTime.Now()
	nextEvent := m.processIdentities(addressSize)

	if !m.tracked[0].NextGeneration.After(now) {
		t.Errorf("NextGeneration did not recover: got %s, want a time after %s",
			m.tracked[0].NextGeneration, now)
	}
	if !nextEvent.After(now) {
		t.Errorf("nextEvent is not in the future (the tracker would hot-spin): "+
			"got %s, want a time after %s", nextEvent, now)
	}
	if !hasRealIdentity(t, m, addressSize, source) {
		t.Errorf("no ephemeral identity was generated for %s — the follower "+
			"would never poll for it, so nothing addressed to it can arrive", source)
	}
}

// TestGenerateIdentitiesOverRange_neverReturnsZero guards the return value
// directly. processIdentities latches whatever this returns into
// NextGeneration, so returning the zero time is the mechanism by which a
// one-off empty generation becomes permanent. Any window that yields no
// identities must still schedule a future retry.
func TestGenerateIdentitiesOverRange_neverReturnsZero(t *testing.T) {
	m, addressSize := newTestManager(t)

	// A window that cannot produce anything: it ends before it begins.
	tracked := &TrackedID{
		NextGeneration: time.Time{},
		LastGeneration: netTime.Now(),
		Source:         id.NewIdFromUInt(2, id.User, t),
		ValidUntil:     Forever,
		Persistent:     true,
		Creation:       netTime.Now(),
	}

	got := m.generateIdentitiesOverRange(tracked, addressSize)
	if got.IsZero() {
		t.Fatal("returned the zero time; processIdentities would latch it into " +
			"NextGeneration and the identity could never generate again")
	}
	if !got.After(netTime.Now()) {
		t.Errorf("returned %s, want a future time so the retry is scheduled "+
			"rather than spun on", got)
	}
}

// replayRounds is how many independent managers TestManager_replayIsOrdered
// drives. The defect it pins is a random select, so a single round can pass by
// luck; each round is an independent ~50/50, and sixteen of them make a passing
// run on the broken code a 1-in-65536 event.
const replayRounds = 16

// TestManager_replayIsOrdered pins XXN-628: a remove immediately followed by an
// add for the SAME identity must be applied in the order it was issued.
//
// That pair is exactly what channels.Manager.ReplayChannel issues — broadcast
// Stop() removes the channel's identity from cmix, and the re-created broadcast
// re-registers it with AddIdentityWithHistory backdated to the channel's
// creation. The backdate is the whole replay: it is what makes the tracker
// regenerate ephemeral IDs across the retention window so the history is
// re-retrieved.
//
// Issued order is not applied order when the two ops travel on two channels
// drained by one select, and both are buffered, so both sends return before
// either is processed. When the add is applied FIRST the identity is still
// tracked, so the handler takes its isOld branch — which copies Persistent and
// ValidUntil and discards LastGeneration, dropping the backdate — and the remove
// then deletes the identity outright. The replay re-pulls nothing, and the room
// is untracked for the rest of the session.
//
// Both ops are queued BEFORE the tracker starts so they are sitting in the
// buffers when the first select runs. That is the production condition, not a
// contrivance: the repair replays room after room while the tracker is busy at
// startup. (A send to a channel whose receiver is already parked hands off
// directly, which is why a test that starts the tracker first mostly gets the
// lucky order and proves nothing.)
//
// The assertion is Creation, because it is the one field that can only be fresh
// if a NEW TrackedID was appended: the isOld path preserves the existing one.
// LastGeneration deliberately is NOT asserted here — the tracker runs
// processIdentities on the very next pass, which consumes the backdate by moving
// LastGeneration up to NextGeneration, so it is already gone by the time any
// poll can see it. That the backdate is actually SPENT on regenerating history is
// TestManager_replayRegeneratesHistory's job, where the pass can be driven by
// hand.
func TestManager_replayIsOrdered(t *testing.T) {
	for round := 0; round < replayRounds; round++ {
		m, _ := newTestManager(t)

		source := id.NewIdFromUInt(uint64(round), id.User, t)
		created := netTime.Now().Add(-30 * 24 * time.Hour)

		// The identity as it stands before a replay: already tracked, and
		// created long enough ago that a stale Creation is unmistakable.
		m.tracked = append(m.tracked, &TrackedID{
			NextGeneration: netTime.Now().Add(time.Hour),
			LastGeneration: netTime.Now().Add(-time.Hour),
			Source:         source,
			ValidUntil:     Forever,
			Persistent:     true,
			Creation:       netTime.Now().Add(-48 * time.Hour),
		})

		issued := netTime.Now()
		m.RemoveIdentityInternal(source)
		m.AddIdentityWithHistoryInternal(source, Forever, created, true)

		stop := m.StartProcesses()
		err := awaitReplayed(m, source, issued, time.Second)
		if stopErr := stop.Close(); stopErr != nil {
			t.Errorf("round %d: failed to stop the tracker: %+v", round, stopErr)
		}
		// Close only SIGNALS the quit; wait for the goroutine to actually reach
		// stopped. A tracker still winding down outlives the round that started
		// it, and its logging then races the next test's jww threshold change —
		// which surfaces as a data race pointing at an unrelated test.
		for deadline := time.Now().Add(2 * time.Second); !stop.IsStopped(); {
			if time.Now().After(deadline) {
				t.Fatalf("round %d: the tracker did not stop", round)
			}
			time.Sleep(time.Millisecond)
		}

		if err != nil {
			t.Fatalf("round %d: the replay was not applied in issued order: %s\n"+
				"the identity must end up freshly re-registered (Creation at or "+
				"after %s), because only a fresh TrackedID carries the backdated "+
				"LastGeneration that makes this a replay", round, err, issued)
		}
	}
}

// awaitReplayed waits for source to be tracked under a TrackedID created at or
// after issued, and reports what it saw instead when it never is.
func awaitReplayed(m *manager, source *id.ID, issued time.Time,
	timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for {
		tid, err := m.GetIdentity(source)
		switch {
		case err != nil:
			last = errors.Errorf("the identity is not tracked at all — the "+
				"remove was applied after the add (%s)", err)
		case tid.Creation.Before(issued):
			last = errors.Errorf("the identity kept its old registration "+
				"(Creation %s) — the add was folded into the existing entry "+
				"instead of replacing it", tid.Creation)
		default:
			return nil
		}
		if time.Now().After(deadline) {
			return last
		}
		time.Sleep(time.Millisecond)
	}
}

// TestManager_replayRegeneratesHistory proves the ordered pair does the thing it
// exists to do, rather than merely being ordered: the re-registered identity
// carries the backdated window, and the very next pass spends it on generating
// ephemeral IDs reaching back across the retention period. Those are what the
// follower polls with, so they are the difference between a replay and a no-op.
//
// Driven by hand rather than through track(), because the tracker consumes the
// backdate on its next pass (LastGeneration moves up to NextGeneration) and it
// cannot be observed afterwards.
func TestManager_replayRegeneratesHistory(t *testing.T) {
	m, addressSize := newTestManager(t)

	source := id.NewIdFromUInt(100, id.User, t)
	created := netTime.Now().Add(-90 * 24 * time.Hour)

	// The steady state before a replay: tracked, with a current window, and
	// already generating only for today.
	m.AddIdentityWithHistoryInternal(source, Forever, netTime.Now(), true)
	m.handleAdd(*(<-m.ops).add)
	m.processIdentities(addressSize)

	// A freshly registered identity still reaches back one generation period —
	// AddIdentityWithHistoryInternal floors the beginning at now-GenerationDelta,
	// so ~25h is the FLOOR, not history. The replay's window is 500h, so the two
	// states are separated by a wide margin and the thresholds below sit inside it.
	if earliest := earliestStartValid(t, m, addressSize, source); earliest.Before(
		netTime.Now().Add(-48 * time.Hour)) {
		t.Fatalf("the pre-replay identity already reaches back to %s; this test "+
			"cannot tell a replay from the starting state", earliest)
	}

	// The replay pair, in the order ReplayChannel issues it.
	m.RemoveIdentityInternal(source)
	m.AddIdentityWithHistoryInternal(source, Forever, created, true)
	for i := 0; i < 2; i++ {
		op := <-m.ops
		if op.add != nil {
			m.handleAdd(*op.add)
		} else {
			m.handleRemove(op.remove)
		}
	}

	m.mux.Lock()
	tracked := *m.tracked[0]
	m.mux.Unlock()

	// created is older than retention, so the window opens at the retention floor.
	wantFloor := netTime.Now().Add(-NetworkRetention)
	if tracked.LastGeneration.After(wantFloor.Add(time.Minute)) {
		t.Fatalf("the re-registered identity opens its window at %s, not back at "+
			"the retention floor %s — nothing older would be re-retrieved",
			tracked.LastGeneration, wantFloor)
	}

	m.processIdentities(addressSize)

	// History is armed as a CHAIN, not as a shelf of identities the follower can
	// see at once: generateIdentitiesOverRange adds the currently-valid identity
	// plus the HEAD of a chain of expired ones, and each further link only goes
	// active when its predecessor is used up and pruned. So the store one instant
	// after a replay reaches back exactly one generation period, the same as a
	// fresh registration — the depth is only visible by walking it, which is what
	// the follower spends its first minutes doing.
	earliest := walkBackEarliest(t, m, addressSize, source, 500)
	if earliest.After(netTime.Now().Add(-7 * 24 * time.Hour)) {
		t.Errorf("walking the identity chain for %s only reached back to %s; the "+
			"follower would never poll the retention window and the replay would "+
			"return nothing", source, earliest)
	}
}

// walkBackEarliest iterates the ephemeral store the way the follower does and
// reports the earliest StartValid it ever sees for source. Each pass prunes the
// identities that are used up, which is what promotes the next link of a
// historical chain into the active set.
func walkBackEarliest(t *testing.T, m *manager, addressSize uint8, source *id.ID,
	passes int) time.Time {
	t.Helper()
	earliest := time.Time{}
	for i := 0; i < passes; i++ {
		got := earliestStartValid(t, m, addressSize, source)
		if earliest.IsZero() || got.Before(earliest) {
			earliest = got
		}
	}
	return earliest
}

// TestManager_replayOutOfOrderLosesTheChannel is the negative control for the
// two tests above: the same pair, applied in the order the broken tracker could
// pick, and the damage it does.
//
// Without it "the replay armed history" has nothing to be measured against — a
// test that only ever exercises the good order cannot show that the order is
// what matters. Both consequences are asserted because either alone understates
// it: nothing is re-retrieved (the add was folded into the existing entry, so no
// backdated window was ever installed) AND the identity is gone, so the room
// receives nothing further until the next launch re-registers it.
func TestManager_replayOutOfOrderLosesTheChannel(t *testing.T) {
	m, _ := newTestManager(t)

	source := id.NewIdFromUInt(102, id.User, t)
	created := netTime.Now().Add(-90 * 24 * time.Hour)

	m.AddIdentityWithHistoryInternal(source, Forever, netTime.Now(), true)
	m.handleAdd(*(<-m.ops).add)
	before := *m.tracked[0]

	m.RemoveIdentityInternal(source)
	m.AddIdentityWithHistoryInternal(source, Forever, created, true)
	ops := []trackerOp{<-m.ops, <-m.ops} // issued remove-first
	if ops[0].remove == nil || ops[1].add == nil {
		t.Fatal("the ops did not queue in issued order")
	}

	// The add wins the select. It lands on a still-tracked identity, so the
	// backdated window it carries is discarded.
	m.handleAdd(*ops[1].add)
	if got := m.tracked[0].LastGeneration; !got.Equal(before.LastGeneration) {
		t.Fatalf("the out-of-order add installed a window (%s); this control "+
			"assumes it does not, and the isOld path is what guarantees that",
			got)
	}

	// The remove then lands on top of it.
	m.handleRemove(ops[0].remove)
	if len(m.tracked) != 0 {
		t.Errorf("the identity survived (%d tracked); the replay would merely "+
			"have re-pulled nothing, rather than also taking the room off the air",
			len(m.tracked))
	}
}

// TestManager_handleAdd_keepsExistingWindow pins the isOld path deliberately:
// re-registering an ALREADY tracked identity must update Persistent and
// ValidUntil and leave the generation window alone, even when the incoming
// registration carries a backdated LastGeneration.
//
// This looks like the bug and is not it. Every joined channel is re-registered
// on every launch — setUpJoinedChannel calls initBroadcast, which calls
// AddIdentityWithHistory backdated to the channel's creation — so honouring the
// backdate here would re-pull the whole retention window of every room on every
// single start. A replay gets its backdate honoured because the remove that
// precedes it makes the identity genuinely new (XXN-628).
func TestManager_handleAdd_keepsExistingWindow(t *testing.T) {
	m, _ := newTestManager(t)

	source := id.NewIdFromUInt(101, id.User, t)
	last := netTime.Now().Add(-time.Hour)
	next := netTime.Now().Add(time.Hour)
	creation := netTime.Now().Add(-72 * time.Hour)
	m.tracked = append(m.tracked, &TrackedID{
		NextGeneration: next,
		LastGeneration: last,
		Source:         source,
		ValidUntil:     netTime.Now().Add(time.Minute),
		Persistent:     false,
		Creation:       creation,
	})

	validUntil := netTime.Now().Add(time.Hour)
	m.handleAdd(TrackedID{
		NextGeneration: netTime.Now().Add(-time.Second),
		LastGeneration: netTime.Now().Add(-NetworkRetention),
		Source:         source,
		ValidUntil:     validUntil,
		Persistent:     true,
		Creation:       netTime.Now(),
	})

	if len(m.tracked) != 1 {
		t.Fatalf("re-registering a tracked identity duplicated it: %d entries",
			len(m.tracked))
	}
	got := m.tracked[0]
	if !got.LastGeneration.Equal(last) || !got.NextGeneration.Equal(next) {
		t.Errorf("the generation window moved (LastGeneration %s, NextGeneration "+
			"%s; want %s / %s) — every launch would re-pull the whole retention "+
			"window of every room", got.LastGeneration, got.NextGeneration, last, next)
	}
	if !got.Creation.Equal(creation) {
		t.Errorf("Creation moved to %s, want %s; a replay is detected by a fresh "+
			"Creation, so this path must not forge one", got.Creation, creation)
	}
	if !got.Persistent || !got.ValidUntil.Equal(validUntil) {
		t.Errorf("the properties that SHOULD be updated were not: Persistent %t, "+
			"ValidUntil %s", got.Persistent, got.ValidUntil)
	}
}

// earliestStartValid returns the earliest StartValid among the live identities
// the ephemeral store holds for source. Historical pickup is armed as a chain of
// expired identities, and the store hands them out regardless of validity, so
// this reads how far back the follower will actually poll.
func earliestStartValid(t *testing.T, m *manager, addressSize uint8,
	source *id.ID) time.Time {
	t.Helper()
	earliest := time.Time{}
	err := m.ephemeral.ForEach(10, rand.Reader, addressSize,
		func(ids []receptionID.IdentityUse) error {
			for _, iu := range ids {
				if iu.Fake || !iu.Source.Cmp(source) {
					continue
				}
				if earliest.IsZero() || iu.StartValid.Before(earliest) {
					earliest = iu.StartValid
				}
			}
			return nil
		})
	if err != nil {
		t.Fatalf("ForEach: %+v", err)
	}
	if earliest.IsZero() {
		t.Fatalf("no live ephemeral identity for %s at all", source)
	}
	return earliest
}

// hasRealIdentity reports whether the ephemeral store holds a live (non-fake)
// identity for source. ForEach synthesises a fake identity when the store is
// empty — which is precisely the "polling for nobody" state — so the Fake flag
// is the assertion that matters, not merely getting an identity back.
func hasRealIdentity(t *testing.T, m *manager, addressSize uint8, source *id.ID) bool {
	t.Helper()
	found := false
	err := m.ephemeral.ForEach(10, rand.Reader, addressSize,
		func(ids []receptionID.IdentityUse) error {
			for _, iu := range ids {
				if !iu.Fake && iu.Source.Cmp(source) {
					found = true
				}
			}
			return nil
		})
	if err != nil {
		t.Fatalf("ForEach: %+v", err)
	}
	return found
}
