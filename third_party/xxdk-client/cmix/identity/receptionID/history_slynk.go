package receptionID

// Slynk: added, so an app can tell how far a look-back through an
// identity's history has got (see HistoryLeft).

import (
	"time"

	"gitlab.com/xx_network/primitives/id"
)

// HistoryLeft counts the ephemeral identities of source that have ended by
// now but are still to be checked: those still being polled, and those
// chained behind them (ProcessNext) to be checked one after another. It is 0
// once a look-back added with history has been fully polled.
func (s *Store) HistoryLeft(source *id.ID, now time.Time) int {
	s.mux.Lock()
	defer s.mux.Unlock()
	n := 0
	for _, r := range s.active {
		if !r.Source.Cmp(source) || !now.After(r.End) {
			continue
		}
		for next := &r.Identity; next != nil; next = next.ProcessNext {
			n++
		}
	}
	return n
}

// HistoryPendingUntil is the latest End among the ephemeral identities of
// source that have ended by now but are still to be checked (those being
// polled and those chained behind them), or the zero time if there are none.
func (s *Store) HistoryPendingUntil(source *id.ID, now time.Time) time.Time {
	s.mux.Lock()
	defer s.mux.Unlock()
	var until time.Time
	for _, r := range s.active {
		if !r.Source.Cmp(source) || !now.After(r.End) {
			continue
		}
		for next := &r.Identity; next != nil; next = next.ProcessNext {
			if next.End.After(until) {
				until = next.End
			}
		}
	}
	return until
}
