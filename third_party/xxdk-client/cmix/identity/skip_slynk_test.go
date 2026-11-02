package identity

// Slynk: tests for AddIdentityWithHistorySkipping and HistoryPendingUntil.

import (
	"testing"
	"time"

	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
	"gitlab.com/xx_network/primitives/netTime"
)

// pastLabels is every past ephemeral identity of source from since to now.
func pastLabels(t *testing.T, source *id.ID, addressSize uint8, since time.Time) []ephemeral.ProtoIdentity {
	t.Helper()
	all, err := ephemeral.GetIdsByRange(source, uint(addressSize), since, netTime.Now().Sub(since))
	if err != nil {
		t.Fatal(err)
	}
	var past []ephemeral.ProtoIdentity
	for _, eid := range all {
		if netTime.Now().After(eid.End.Add(validityGracePeriod)) {
			past = append(past, eid)
		}
	}
	return past
}

func TestGenerateIdentitiesOverRange_skipsAStretchAlreadyChecked(t *testing.T) {
	source := id.NewIdFromUInt(57, id.User, t)
	since := netTime.Now().Add(-10 * 24 * time.Hour)
	m, addressSize := newTestManager(t)
	past := pastLabels(t, source, addressSize, since)
	if len(past) < 6 {
		t.Fatalf("only %d past labels to work with", len(past))
	}

	// Skip the three newest past labels but one: what a look-back cut short
	// three labels in would have been through.
	skipFrom, skipTo := past[len(past)-4].Start, past[len(past)-2].End
	tracked := &TrackedID{
		NextGeneration: netTime.Now().Add(-time.Second),
		LastGeneration: since,
		Source:         source,
		ValidUntil:     Forever,
		Creation:       netTime.Now(),
		SkipFrom:       skipFrom,
		SkipTo:         skipTo,
	}
	m.generateIdentitiesOverRange(tracked, addressSize)
	if got, want := m.ephemeral.HistoryLeft(source, netTime.Now()), len(past)-3; got != want {
		t.Errorf("HistoryLeft = %d, want %d: three labels lie within the stretch", got, want)
	}
	if !tracked.SkipFrom.IsZero() || !tracked.SkipTo.IsZero() {
		t.Error("the stretch applies to the first generation only")
	}
	if !hasRealIdentity(t, m, addressSize, source) {
		t.Error("the current label must never be skipped")
	}
	// The newest past label is outside the stretch, so it's checked first.
	if got := m.HistoryPendingUntil(source); !got.Equal(past[len(past)-1].End) {
		t.Errorf("HistoryPendingUntil = %s, want the newest past label's end %s", got, past[len(past)-1].End)
	}

	// Without a stretch, every past label is checked.
	plain, _ := newTestManager(t)
	plain.generateIdentitiesOverRange(&TrackedID{
		NextGeneration: netTime.Now().Add(-time.Second),
		LastGeneration: since,
		Source:         source,
		ValidUntil:     Forever,
		Creation:       netTime.Now(),
	}, addressSize)
	if got := plain.ephemeral.HistoryLeft(source, netTime.Now()); got != len(past) {
		t.Errorf("without a stretch, HistoryLeft = %d, want %d", got, len(past))
	}
}

func TestHistoryPendingUntil_nothingLeft(t *testing.T) {
	m, _ := newTestManager(t)
	if got := m.HistoryPendingUntil(id.NewIdFromUInt(58, id.User, t)); !got.IsZero() {
		t.Errorf("HistoryPendingUntil = %s, want the zero time", got)
	}
}
