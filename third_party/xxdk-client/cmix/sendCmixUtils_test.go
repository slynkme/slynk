////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package cmix

import (
	"testing"
	"time"

	pb "gitlab.com/elixxir/comms/mixmessages"
	"gitlab.com/elixxir/primitives/states"
)

// roundAtOffset builds a minimal RoundInfo whose QUEUED slot is `offset`
// from now. Lets boundary tests dial the QUEUED-relative state without
// depending on a live network.
func roundAtOffset(offset time.Duration) *pb.RoundInfo {
	ts := make([]uint64, states.COMPLETED+1)
	ts[states.QUEUED] = uint64(time.Now().Add(offset).UnixNano())
	return &pb.RoundInfo{Timestamps: ts}
}

// TestCalculateSendTimeoutDetailed_HealthyHeadroom — XXN-264 Strand E.
// Round QUEUED is comfortably in the future. PreClamp matches the clamped
// timeout (both positive, both well below the max cap). No floor or cap
// fires.
func TestCalculateSendTimeoutDetailed_HealthyHeadroom(t *testing.T) {
	round := roundAtOffset(5 * time.Second)
	max := 30 * time.Second
	timeout, preClamp := calculateSendTimeoutDetailed(round, max)

	if timeout <= 0 || timeout > max {
		t.Fatalf("expected clamped timeout in (0, %s]; got %s", max, timeout)
	}
	if preClamp != timeout {
		t.Fatalf("expected preClamp == timeout in healthy case; preClamp=%s timeout=%s",
			preClamp, timeout)
	}
	if preClamp <= 0 {
		t.Fatalf("expected preClamp > 0 with 5s future QUEUED; got %s", preClamp)
	}
}

// TestCalculateSendTimeoutDetailed_CapFires — XXN-264 Strand E.
// Round QUEUED is far in the future (10 min); preClamp is large and
// positive, the clamp brings the timeout down to max. PreClamp must
// preserve the raw value so analysis can detect the cap fired.
func TestCalculateSendTimeoutDetailed_CapFires(t *testing.T) {
	round := roundAtOffset(10 * time.Minute)
	max := 30 * time.Second
	timeout, preClamp := calculateSendTimeoutDetailed(round, max)

	if timeout != max {
		t.Fatalf("expected clamped timeout == max=%s; got %s", max, timeout)
	}
	if preClamp <= max {
		t.Fatalf("expected preClamp > max (cap fired); preClamp=%s max=%s",
			preClamp, max)
	}
}

// TestCalculateSendTimeoutDetailed_FloorFires — XXN-264 Strand E.
// Round QUEUED is in the past (-2s); preClamp is negative, the floor
// clamps the timeout to 100ms. PreClamp must preserve the negative raw
// value — that's the load-bearing "too-late send" signal.
func TestCalculateSendTimeoutDetailed_FloorFires(t *testing.T) {
	round := roundAtOffset(-2 * time.Second)
	max := 30 * time.Second
	timeout, preClamp := calculateSendTimeoutDetailed(round, max)

	if timeout != 100*time.Millisecond {
		t.Fatalf("expected clamped timeout == 100ms floor; got %s", timeout)
	}
	if preClamp >= 0 {
		t.Fatalf("expected preClamp < 0 with past QUEUED; got %s", preClamp)
	}
}

// TestCalculateSendTimeoutDetailed_NearBoundary — XXN-264 Strand E.
// Round QUEUED is 200ms in the future. The 250ms-after-start subtraction
// pushes preClamp negative (~-50ms), floor fires. Confirms the boundary
// is at QUEUED + 250ms, not at QUEUED itself.
func TestCalculateSendTimeoutDetailed_NearBoundary(t *testing.T) {
	round := roundAtOffset(200 * time.Millisecond)
	max := 30 * time.Second
	timeout, preClamp := calculateSendTimeoutDetailed(round, max)

	if timeout != 100*time.Millisecond {
		t.Fatalf("expected floor at QUEUED+200ms (inside the 250ms shoulder); got %s", timeout)
	}
	if preClamp >= 0 {
		t.Fatalf("expected preClamp < 0 inside the 250ms shoulder; got %s", preClamp)
	}
}

// TestShouldSkipTooLateRound_AboveThreshold — XXN-267.
// PreClamp comfortably above the threshold; helper returns false (no skip).
// The mechanism should not fire on healthy rounds.
func TestShouldSkipTooLateRound_AboveThreshold(t *testing.T) {
	if shouldSkipTooLateRound(600*time.Millisecond, 500*time.Millisecond) {
		t.Fatal("expected false (no skip) when preClamp > threshold")
	}
}

// TestShouldSkipTooLateRound_BoundaryAndBelow — XXN-267.
// Pins boundary semantics: preClamp == threshold passes through (strict
// <), preClamp just below threshold skips, and negative preClamp
// (round's QUEUED slot already passed) skips. Table-driven so a future
// boundary change is one row to edit.
func TestShouldSkipTooLateRound_BoundaryAndBelow(t *testing.T) {
	threshold := 500 * time.Millisecond
	cases := []struct {
		name     string
		preClamp time.Duration
		want     bool
	}{
		{"at_boundary_passes", 500 * time.Millisecond, false},
		{"just_below_skips", 499 * time.Millisecond, true},
		{"negative_skips", -50 * time.Millisecond, true},
		{"deeply_negative_skips", -2 * time.Second, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldSkipTooLateRound(tc.preClamp, threshold)
			if got != tc.want {
				t.Fatalf("preClamp=%s threshold=%s: want=%v got=%v",
					tc.preClamp, threshold, tc.want, got)
			}
		})
	}
}

// TestShouldSkipTooLateRound_ZeroThresholdDisables — XXN-267.
// threshold == 0 must short-circuit to false even on a deeply-negative
// preClamp, preserving the pre-XXN-267 100ms-floor-clamp behavior for
// callers that opt out (or default-zero CMIXParams from JSON unmarshal).
func TestShouldSkipTooLateRound_ZeroThresholdDisables(t *testing.T) {
	if shouldSkipTooLateRound(-1*time.Second, 0) {
		t.Fatal("expected false (mechanism disabled) when threshold == 0")
	}
}

// TestCalculateSendTimeout_Compat — XXN-264 Strand E.
// The pre-existing calculateSendTimeout wrapper must still produce
// identical clamped output to the detailed form, so the cmix.Client
// callers that don't need preClamp aren't affected.
func TestCalculateSendTimeout_Compat(t *testing.T) {
	cases := []time.Duration{
		5 * time.Second,           // healthy
		10 * time.Minute,          // cap fires
		-2 * time.Second,          // floor fires
		200 * time.Millisecond,    // boundary
	}
	max := 30 * time.Second
	for _, offset := range cases {
		round := roundAtOffset(offset)
		want, _ := calculateSendTimeoutDetailed(round, max)
		got := calculateSendTimeout(round, max)
		// Allow a 5ms drift because two consecutive netTime.Now() reads
		// can differ slightly between the wrapper and the detailed call.
		drift := want - got
		if drift < 0 {
			drift = -drift
		}
		if drift > 5*time.Millisecond {
			t.Fatalf("offset=%s: wrapper diverged from detailed; want=%s got=%s drift=%s",
				offset, want, got, drift)
		}
	}
}
