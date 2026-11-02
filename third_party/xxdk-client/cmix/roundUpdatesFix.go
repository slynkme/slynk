////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package cmix

// Slynk: comms v0.0.6 Instance.RoundUpdates (network/instance.go:481) runs
// `addedRounds = append(removedRounds, rnd)` for every update past QUEUED, so
// each COMPLETED or FAILED update in a poll throws away the QUEUED rounds
// listed before it, and they never reach the waiting list that sends pick
// rounds from. On mainnet that hid about half of the announced upcoming rounds
// from the client, and a file upload spent most of its time waiting for a round.

import (
	"time"

	pb "gitlab.com/elixxir/comms/mixmessages"
	commNetwork "gitlab.com/elixxir/comms/network"
	ds "gitlab.com/elixxir/comms/network/dataStructures"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

// Slynk: requeueDroppedRounds puts back, after RoundUpdates has applied a
// poll's updates, every round whose last update in the poll is QUEUED, which
// hasn't started yet and which RoundUpdates left out of the waiting list.
// It only re-adds what the poll announced, in the wrapper RoundUpdates
// stored for it, so it never offers a round the stock code wouldn't have.
func requeueDroppedRounds(
	instance *commNetwork.Instance, updates []*pb.RoundInfo) {
	last := make(map[uint64]int, len(updates))
	for i, u := range updates {
		last[u.ID] = i
	}
	wr := instance.GetWaitingRounds()
	waiting := make(map[uint64]bool)
	for _, ri := range wr.GetSlice() {
		waiting[ri.ID] = true
	}

	now := netTime.Now()
	var requeue []*ds.Round
	for i, u := range updates {
		if states.Round(u.State) != states.QUEUED || last[u.ID] != i ||
			waiting[u.ID] || len(u.Timestamps) <= int(states.QUEUED) {
			continue
		}
		start := time.Unix(0, int64(u.Timestamps[states.QUEUED]))
		if !start.After(now) {
			continue
		}
		// GetWrappedRound can return (nil, nil) (roundData.go:60-70).
		r, err := instance.GetWrappedRound(id.Round(u.ID))
		if err == nil && r != nil && r.StartTime().Equal(start) {
			requeue = append(requeue, r)
		}
	}
	if len(requeue) > 0 {
		wr.Insert(requeue, nil)
	}
}
