package cmix

// Slynk: added. xxDK doesn't say when a look-back through a tracked
// identity's history (AddIdentityWithHistory) has finished, so an app can't
// tell its user that everything has been found. LookbackStatus reports both
// halves of it. Neither the Client interface nor the identity.Tracker and
// pickup.Pickup interfaces change, so other implementations (tests' mocks)
// are untouched; callers reach it with a type assertion.

import (
	"time"

	"gitlab.com/elixxir/client/v4/cmix/message"
	"gitlab.com/xx_network/primitives/id"
)

// LookbackReporter is what the cmix client offers; callers type-assert a
// Client to it. Checked at compile time below, so a caller using this type
// can't fall out of step with the method.
type LookbackReporter interface {
	LookbackStatus(source *id.ID) (labelsLeft, inFlight, failed int)
	LookbackPendingUntil(source *id.ID) time.Time
	AddIdentityWithHistorySkipping(source *id.ID, validUntil, beginning, skipFrom, skipTo time.Time,
		persistent bool, fallthroughProcessor message.Processor)
}

var _ LookbackReporter = (*client)(nil)

// LookbackStatus reports, for a tracked identity, how many of its past
// ephemeral identities are still to be checked (labelsLeft), how many round
// pickups for it are queued or under way (inFlight), and how many failed and
// wait for the unchecked sweep to retry them (failed). The look-back is
// complete when all three are 0; with only failed ones left, it's as
// complete as the network allows for now.
func (c *client) LookbackStatus(source *id.ID) (labelsLeft, inFlight, failed int) {
	if t, ok := c.Tracker.(interface{ HistoryLeft(*id.ID) int }); ok {
		labelsLeft = t.HistoryLeft(source)
	}
	if p, ok := c.Pickup.(interface {
		PendingDetail(*id.ID) (int, int)
	}); ok {
		inFlight, failed = p.PendingDetail(source)
	}
	return labelsLeft, inFlight, failed
}

// LookbackPendingUntil is the end of the newest past ephemeral identity of
// source still to be checked, or the zero time if none is. Past identities
// are checked newest first, so everything after it has been: with nothing in
// flight or failed, an app holds everything delivered to source from then
// until now (Slynk's kept inbox remembers that).
func (c *client) LookbackPendingUntil(source *id.ID) time.Time {
	if t, ok := c.Tracker.(interface{ HistoryPendingUntil(*id.ID) time.Time }); ok {
		return t.HistoryPendingUntil(source)
	}
	return time.Time{}
}

// AddIdentityWithHistorySkipping is AddIdentityWithHistory, except that past
// ephemeral identities lying wholly within [skipFrom, skipTo] (a stretch the
// caller already has) aren't checked again. A zero skipTo skips nothing.
func (c *client) AddIdentityWithHistorySkipping(source *id.ID, validUntil, beginning, skipFrom,
	skipTo time.Time, persistent bool, fallthroughProcessor message.Processor) {
	if t, ok := c.Tracker.(interface {
		AddIdentityWithHistorySkipping(*id.ID, time.Time, time.Time, time.Time, time.Time, bool)
	}); ok {
		t.AddIdentityWithHistorySkipping(source, validUntil, beginning, skipFrom, skipTo, persistent)
	} else {
		c.AddIdentityWithHistoryInternal(source, validUntil, beginning, persistent)
	}
	if fallthroughProcessor != nil {
		c.Handler.AddFallthrough(source, fallthroughProcessor)
	}
}
