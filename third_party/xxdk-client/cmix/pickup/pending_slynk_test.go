package pickup

// Slynk: tests for the pickup counts behind Pending.

import (
	"testing"

	"github.com/pkg/errors"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/client/v4/stoppable"
	pb "gitlab.com/elixxir/comms/mixmessages"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
)

func TestPendingPickups(t *testing.T) {
	var p pendingPickups
	a, b := id.NewIdFromString("a", id.User, t), id.NewIdFromString("b", id.User, t)
	var eph ephemeral.Id
	split := func(s *id.ID) [2]int {
		inFlight, failed := p.count(s)
		return [2]int{inFlight, failed}
	}

	if split(a) != [2]int{0, 0} {
		t.Fatal("a new count isn't 0")
	}
	p.start(a)
	p.start(a)
	p.start(b)
	if split(a) != [2]int{2, 0} || split(b) != [2]int{1, 0} {
		t.Fatalf("in flight: a=%v b=%v, want 2 and 1", split(a), split(b))
	}

	// A failed pickup still counts until a later one for the round succeeds.
	p.finish(5, a, eph, true)
	p.finish(6, a, eph, false)
	if split(a) != [2]int{0, 1} {
		t.Fatalf("after one failure: %v, want 0 in flight and 1 failed", split(a))
	}
	p.start(a) // the retry
	if split(a) != [2]int{1, 1} {
		t.Fatalf("retrying: %v, want 1 and 1", split(a))
	}
	p.finish(5, a, eph, false)
	if split(a) != [2]int{0, 0} {
		t.Fatalf("after the retry worked: %v, want 0", split(a))
	}
	p.finish(9, b, eph, false)
	if split(b) != [2]int{0, 0} {
		t.Fatalf("b: %v, want 0", split(b))
	}

	// More finishes than starts never go below 0.
	p.finish(7, b, eph, false)
	if split(b) != [2]int{0, 0} {
		t.Fatalf("b went below 0: %v", split(b))
	}
	p.start(nil)
	p.finish(1, nil, eph, true)
}

// noRound is a RoundGetter without the round in memory, so pickups go
// through the historical lookup.
type noRound struct{}

func (noRound) GetRound(id.Round) (*pb.RoundInfo, error) { return nil, errors.New("not in memory") }

// failingHistory answers every lookup the way the historical manager does
// after its last retry: an empty Round and success false.
type failingHistory struct{}

func (failingHistory) StartProcesses() *stoppable.Single { return nil }
func (failingHistory) LookupHistoricalRound(_ id.Round, cb rounds.RoundResultCallback) error {
	cb(rounds.Round{}, false)
	return nil
}

// A failed historical lookup is counted as a failed pickup and left for the
// sweep, not passed on as an empty round (whose nil topology panicked).
func TestFailedHistoricalLookup(t *testing.T) {
	m := newManager(t)
	m.instance = noRound{}
	m.historical = failingHistory{}
	m.lookupRoundMessages = make(chan roundLookup, 1)
	source := id.NewIdFromString("inbox", id.User, t)
	var eph ephemeral.Id

	m.GetMessagesFromRound(42, receptionID.EphemeralIdentity{EphId: eph, Source: source})

	select {
	case rl := <-m.lookupRoundMessages:
		t.Fatalf("a failed lookup was passed on: round %d", rl.Round.ID)
	default:
	}
	if inFlight, failed := m.PendingDetail(source); inFlight != 0 || failed != 1 || m.Pending(source) != 1 {
		t.Fatalf("PendingDetail = %d, %d, want 0 in flight and 1 failed", inFlight, failed)
	}
	if _, ok := m.unchecked.GetRound(42, source, eph); !ok {
		t.Fatal("the round isn't left for the sweep to retry")
	}
	if _, ok := m.unchecked.GetRound(0, source, eph); ok {
		t.Fatal("a phantom round 0 was stored")
	}
}
