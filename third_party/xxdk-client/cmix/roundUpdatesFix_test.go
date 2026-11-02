////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package cmix

// Slynk: offline tests that pin down the comms v0.0.6 RoundUpdates bug and
// check requeueDroppedRounds repairs it without adding anything else.

import (
	"sort"
	"testing"
	"time"

	pb "gitlab.com/elixxir/comms/mixmessages"
	commNetwork "gitlab.com/elixxir/comms/network"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/comms/connect"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

// Slynk: an Instance that accepts unsigned round infos. Validation is None,
// as in the client (client.go:180-181).
func newRoundUpdatesTestInstance(t *testing.T) *commNetwork.Instance {
	pc := &connect.ProtoComms{Manager: connect.NewManagerTesting(t)}
	inst, err := commNetwork.NewInstance(pc, getNDF(), nil, nil,
		commNetwork.None, true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = pc.AddHost(&id.Permissioning, "0.0.0.0:4200", nil,
		connect.GetDefaultHostParams())
	if err != nil {
		t.Fatal(err)
	}
	return inst
}

// Slynk: two polls' updates, each in update-ID order as a gateway returns
// them. Round 95 is QUEUED in the first poll and fails before its start in
// the second.
func roundUpdatesTestPolls() (first, second []*pb.RoundInfo) {
	now := netTime.Now()
	mk := func(rid, uid uint64, st states.Round, start time.Duration) *pb.RoundInfo {
		ts := make([]uint64, states.NUM_STATES)
		ts[states.QUEUED] = uint64(now.Add(start).UnixNano())
		return &pb.RoundInfo{ID: rid, UpdateID: uid, State: uint32(st),
			Timestamps: ts}
	}
	first = []*pb.RoundInfo{mk(95, 1, states.QUEUED, 7*time.Second)}
	second = []*pb.RoundInfo{
		mk(100, 2, states.QUEUED, 5*time.Second),
		mk(90, 3, states.COMPLETED, -3*time.Second),
		mk(101, 4, states.QUEUED, 6*time.Second),
		mk(95, 5, states.FAILED, 7*time.Second), // failed before its start
		mk(103, 6, states.QUEUED, 9*time.Second),
		mk(103, 7, states.FAILED, 9*time.Second), // same poll, superseded
		mk(102, 8, states.QUEUED, 8*time.Second),
		mk(104, 9, states.QUEUED, -time.Second), // already started
	}
	return first, second
}

// Slynk: IDs of the rounds the waiting list offers, sorted.
func waitingRoundIDs(inst *commNetwork.Instance) []uint64 {
	var ids []uint64
	for _, ri := range inst.GetWaitingRounds().GetSlice() {
		ids = append(ids, ri.ID)
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
	return ids
}

func equalRoundIDs(a, b []uint64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func Test_requeueDroppedRounds(t *testing.T) {
	inst := newRoundUpdatesTestInstance(t)
	first, second := roundUpdatesTestPolls()
	for _, updates := range [][]*pb.RoundInfo{first, second} {
		if err := inst.RoundUpdates(updates); err != nil {
			t.Fatal(err)
		}
	}

	// The bug: QUEUED 100 and 101 are dropped (each is followed by a
	// COMPLETED/FAILED update), FAILED 103, the poll's last non-QUEUED
	// update, is inserted as sendable, and FAILED 95 is never removed.
	if got, want := waitingRoundIDs(inst), []uint64{95, 102, 103}; !equalRoundIDs(got, want) {
		t.Fatalf("stock RoundUpdates left %v, expected %v; has comms changed?",
			got, want)
	}

	// The fix puts back exactly 100 and 101: not 103 (its last update is
	// FAILED) and not 104 (already started).
	requeueDroppedRounds(inst, second)
	if got, want := waitingRoundIDs(inst), []uint64{95, 100, 101, 102, 103}; !equalRoundIDs(got, want) {
		t.Errorf("after the fix the waiting list is %v, expected %v", got, want)
	}

	// Running it again changes nothing.
	requeueDroppedRounds(inst, second)
	if got, want := waitingRoundIDs(inst), []uint64{95, 100, 101, 102, 103}; !equalRoundIDs(got, want) {
		t.Errorf("a second pass changed the waiting list to %v", got)
	}
}
