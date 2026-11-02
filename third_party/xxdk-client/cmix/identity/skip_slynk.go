package identity

// Slynk: added. An app that keeps what an identity has received (Slynk's
// kept inbox) needn't check again the past ephemeral identities it has
// already been through, so a look-back cut short can carry on from where it
// was rather than start again.

import (
	"time"

	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
	"gitlab.com/xx_network/primitives/netTime"
)

// AddIdentityWithHistorySkipping is AddIdentityWithHistoryInternal, except
// that past ephemeral identities lying wholly within [skipFrom, skipTo] are
// not checked. A zero skipTo skips nothing. Like a backdate, it applies only
// when the identity is new (see handleAdd).
func (t *manager) AddIdentityWithHistorySkipping(id *id.ID, validUntil,
	historicalBeginning, skipFrom, skipTo time.Time, persistent bool) {
	retention := netTime.Now().Add(-NetworkRetention)
	if historicalBeginning.Before(retention) {
		historicalBeginning = retention
	}

	if now := time.Now(); historicalBeginning.After(now) ||
		now.Sub(historicalBeginning) < GenerationDelta {
		historicalBeginning = now.Add(-GenerationDelta)
	}

	t.ops <- trackerOp{add: &TrackedID{
		NextGeneration: netTime.Now().Add(-time.Second),
		LastGeneration: historicalBeginning,
		Source:         id,
		ValidUntil:     validUntil,
		Persistent:     persistent,
		Creation:       netTime.Now(),
		SkipFrom:       skipFrom,
		SkipTo:         skipTo,
	}}
}

// skipHistory reports whether a past ephemeral identity lies wholly within
// the stretch the caller already has.
func skipHistory(t *TrackedID, eid ephemeral.ProtoIdentity) bool {
	return !t.SkipTo.IsZero() && !eid.Start.Before(t.SkipFrom) && !eid.End.After(t.SkipTo)
}
