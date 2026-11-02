package identity

// Slynk: added; see receptionID.Store.HistoryLeft.

import (
	"time"

	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

// HistoryLeft counts the past ephemeral identities of source still to be
// checked: 0 once its look-back has been fully polled.
func (t *manager) HistoryLeft(source *id.ID) int {
	return t.ephemeral.HistoryLeft(source, netTime.Now())
}

// HistoryPendingUntil is the end of the newest past ephemeral identity of
// source still to be checked, or the zero time if none is. Past identities
// are checked newest first (generateIdentitiesOverRange chains them so), so
// everything after it has been through its checks.
func (t *manager) HistoryPendingUntil(source *id.ID) time.Time {
	return t.ephemeral.HistoryPendingUntil(source, netTime.Now())
}
