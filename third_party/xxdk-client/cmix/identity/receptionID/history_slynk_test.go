package receptionID

// Slynk: tests for HistoryLeft.

import (
	"math/rand"
	"testing"
	"time"

	"gitlab.com/elixxir/client/v4/collective/versioned"
	"gitlab.com/elixxir/ekv"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
	"gitlab.com/xx_network/primitives/netTime"
)

func historyIdentity(t *testing.T, prng *rand.Rand, source *id.ID, end time.Time) Identity {
	var eph ephemeral.Id
	prng.Read(eph[:])
	return Identity{
		EphemeralIdentity: EphemeralIdentity{EphId: eph, Source: source},
		AddressSize:       15,
		End:               end,
		ExtraChecks:       5,
		StartValid:        end.Add(-24 * time.Hour),
		EndValid:          end.Add(5 * time.Minute),
		Ephemeral:         true,
	}
}

func TestStore_HistoryLeft(t *testing.T) {
	s := NewOrLoadStore(versioned.NewKV(ekv.MakeMemstore()))
	prng := rand.New(rand.NewSource(57))
	now := netTime.Now()
	inbox, other := id.NewIdFromString("inbox", id.User, t), id.NewIdFromString("other", id.User, t)

	// Three past labels chained newest first, as the tracker adds them,
	// plus the current one.
	oldest := historyIdentity(t, prng, inbox, now.Add(-49*time.Hour))
	middle := historyIdentity(t, prng, inbox, now.Add(-25*time.Hour))
	middle.ProcessNext = &oldest
	newest := historyIdentity(t, prng, inbox, now.Add(-time.Hour))
	newest.ProcessNext = &middle
	for _, ident := range []Identity{newest, historyIdentity(t, prng, inbox, now.Add(23*time.Hour)),
		historyIdentity(t, prng, other, now.Add(-time.Hour))} {
		if err := s.AddIdentity(ident); err != nil {
			t.Fatal(err)
		}
	}

	if got := s.HistoryLeft(inbox, now); got != 3 {
		t.Fatalf("HistoryLeft = %d, want 3", got)
	}
	if got := s.HistoryLeft(other, now); got != 1 {
		t.Fatalf("HistoryLeft(other) = %d, want 1", got)
	}

	// Each label is pruned once its extra checks are used up, and the next
	// one in the chain takes its place.
	for want := 2; want >= 0; want-- {
		for _, r := range s.active {
			if r.Source.Cmp(inbox) && now.After(r.End) {
				r.ExtraChecks = 0
			}
		}
		s.prune(now)
		if got := s.HistoryLeft(inbox, now); got != want {
			t.Fatalf("after a prune, HistoryLeft = %d, want %d", got, want)
		}
	}
}

func TestStore_HistoryPendingUntil(t *testing.T) {
	s := NewOrLoadStore(versioned.NewKV(ekv.MakeMemstore()))
	prng := rand.New(rand.NewSource(58))
	now := netTime.Now()
	inbox := id.NewIdFromString("inbox", id.User, t)
	if got := s.HistoryPendingUntil(inbox, now); !got.IsZero() {
		t.Fatalf("nothing tracked: HistoryPendingUntil = %s", got)
	}
	oldest := historyIdentity(t, prng, inbox, now.Add(-49*time.Hour))
	newest := historyIdentity(t, prng, inbox, now.Add(-25*time.Hour))
	newest.ProcessNext = &oldest
	for _, ident := range []Identity{newest, historyIdentity(t, prng, inbox, now.Add(23*time.Hour))} {
		if err := s.AddIdentity(ident); err != nil {
			t.Fatal(err)
		}
	}
	// The newest past label is checked first; the current one doesn't count.
	if got := s.HistoryPendingUntil(inbox, now); !got.Equal(newest.End) {
		t.Fatalf("HistoryPendingUntil = %s, want %s", got, newest.End)
	}
	for _, r := range s.active {
		if r.Source.Cmp(inbox) && now.After(r.End) {
			r.ExtraChecks = 0
		}
	}
	s.prune(now)
	if got := s.HistoryPendingUntil(inbox, now); !got.Equal(oldest.End) {
		t.Fatalf("after the newest is done, HistoryPendingUntil = %s, want %s", got, oldest.End)
	}
}
