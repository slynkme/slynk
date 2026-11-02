package pickup

// Slynk: added. Counts, per tracked identity, the round pickups that haven't
// finished, so an app looking back through an identity's history can tell
// when everything found so far has been collected (see Pending).

import (
	"sync"

	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
)

// pendingKey is one round's pickup for one ephemeral identity.
type pendingKey struct {
	round  id.Round
	source id.ID
	ephID  ephemeral.Id
}

// pendingPickups tracks lookups queued or under way, and rounds whose last
// pickup failed and wait for a retry. A round that answered with no
// messages (a bloom false positive) counts as finished, though the unchecked
// store keeps it for later re-checks.
type pendingPickups struct {
	mux      sync.Mutex
	inFlight map[id.ID]int
	failed   map[pendingKey]struct{}
}

func (p *pendingPickups) start(source *id.ID) {
	if source == nil {
		return
	}
	p.mux.Lock()
	defer p.mux.Unlock()
	if p.inFlight == nil {
		p.inFlight = make(map[id.ID]int)
	}
	p.inFlight[*source]++
}

// finish ends one lookup started with start, recording whether it failed.
func (p *pendingPickups) finish(rid id.Round, source *id.ID, ephID ephemeral.Id, failed bool) {
	if source == nil {
		return
	}
	p.mux.Lock()
	defer p.mux.Unlock()
	if p.inFlight[*source] > 0 {
		p.inFlight[*source]--
	}
	if p.failed == nil {
		p.failed = make(map[pendingKey]struct{})
	}
	key := pendingKey{rid, *source, ephID}
	if failed {
		p.failed[key] = struct{}{}
	} else {
		delete(p.failed, key)
	}
}

func (p *pendingPickups) count(source *id.ID) (inFlight, failed int) {
	p.mux.Lock()
	defer p.mux.Unlock()
	for key := range p.failed {
		if key.source == *source {
			failed++
		}
	}
	return p.inFlight[*source], failed
}

// Pending reports how many round pickups for source haven't finished: those
// queued or under way, plus those whose last attempt failed and wait for a
// retry. Only counts pickups made through processMessageRetrieval (batch
// retrieval is off by default).
func (m *pickup) Pending(source *id.ID) int {
	inFlight, failed := m.pending.count(source)
	return inFlight + failed
}

// PendingDetail splits Pending: pickups queued or under way, and those whose
// last attempt failed. A failed one waits for the unchecked sweep, whose
// retries back off from seconds to hours (backOffTable).
func (m *pickup) PendingDetail(source *id.ID) (inFlight, failed int) {
	return m.pending.count(source)
}

// finishPending ends the count for a lookup processMessageRetrieval has dealt
// with. Round 0 never comes from GetMessagesFromRound (rounds start at 1), so
// a lookup for it was never counted.
func (m *pickup) finishPending(rl roundLookup, failed bool) {
	if rl.Round.ID == 0 {
		return
	}
	m.pending.finish(id.Round(rl.Round.ID), rl.Identity.Source, rl.Identity.EphId, failed)
}
