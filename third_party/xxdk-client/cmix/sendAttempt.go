////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package cmix

import (
	"time"

	"gitlab.com/xx_network/primitives/id"
)

// SendAttemptInfo describes one gateway send attempt initiated from
// inside sendCmixHelper / sendManyCmix — fired just before the
// comms.SendPutMessage / SendPutManyMessages call.
//
// Multiple SendAttemptInfo values MAY fire per single SendCMIX /
// SendManyCMIX call if gateway.SendToPreferred retries against
// proxies. AttemptIndex distinguishes them (0,1,2... within one
// SendToPreferred invocation; resets per SendCMIX call).
//
// Used by Courier (XXN-264 Strand B) to surface the calculateSendTimeout
// output so post-hoc analysis can correlate small per-call timeouts with
// the 1-5 s failed-send-duration cluster observed in XXN-263 Strand 4
// mainnet bursts.
type SendAttemptInfo struct {
	// RoundID is the id of the round selected by findBestRound for this
	// attempt. Non-zero — selection has already happened by the time the
	// observer fires.
	RoundID uint64

	// TargetGateway is the intended target — the *id.ID arg to
	// gateway.SendToPreferred. Differs from HostGateway on a
	// SendToPreferred retry that contacted a proxy.
	TargetGateway *id.ID

	// HostGateway is the gateway actually contacted on this attempt.
	// On attempt 0 it equals TargetGateway; on attempt 1+ it can be a
	// proxy from the host pool.
	HostGateway *id.ID

	// HostAddr is host:port from connect.Host.GetAddress().
	HostAddr string

	// Timeout is the per-call timeout calculateSendTimeout produced for
	// this SendPutMessage invocation (after the [100ms, max] clamp).
	Timeout time.Duration

	// TimeoutPreClamp is calculateSendTimeout's raw subtraction
	// (roundStart - (now + 250ms)) BEFORE the [100ms, max] clamp. Can be
	// negative: signals the call is firing AFTER the round's
	// QUEUED + 250ms slot has passed, the 100ms floor has activated,
	// and the round is too-late to plausibly succeed. Added by
	// XXN-264 Strand E to characterize the serialization-decay
	// mechanism surfaced in Strand D — distinguishes "comfortable
	// headroom" (large positive) from "floor fired" (negative) without
	// the clamp masking the underlying state.
	TimeoutPreClamp time.Duration

	// AttemptIndex is the 0-based attempt index within one
	// SendToPreferred call. 0 = first attempt (target pool), 1+ = proxy
	// fan-out retries.
	AttemptIndex int
}

// SendAttemptObserver is invoked once per gateway send attempt.
// Implementations MUST NOT block — the observer runs on the send
// goroutine and a slow callback stalls the SendCMIX path. Register via
// cmix.Client.RegisterSendAttemptObserver.
type SendAttemptObserver interface {
	OnSendAttempt(info SendAttemptInfo)

	// OnSendSkipped fires when sendCmixHelper / sendManyCmix's round-tries
	// loop selects a round but skips it BEFORE reaching the sendFunc /
	// SendPutMessage call — i.e. before OnSendAttempt would have fired.
	// Lets adopters see why a SendCMIX call burned a round-try without
	// emitting an attempt event. Same non-blocking contract as
	// OnSendAttempt.
	OnSendSkipped(info SendSkipInfo)
}

// SendSkipInfo describes a sendCmixHelper / sendManyCmix outer-loop skip
// — a round-tries iteration that did NOT progress to comms.SendPutMessage.
//
// Concrete skip causes:
//   - "best_round_nil"        — findBestRound returned nil (XXN-264 Strand E)
//   - "contains_blacklisted"  — selected round had a blacklisted node (XXN-264 Strand E)
//   - "process_round_err"     — processRound failed (host pool / keys) (XXN-264 Strand E)
//   - "too_late_round"        — preClamp below CMIXParams.TooLateThreshold (XXN-267)
//
// SkipReason is a stable string so adopters can switch on it without
// pulling in xxDK-internal enums.
type SendSkipInfo struct {
	// Recipient identifies the intended cMix recipient (same value the
	// caller passed to SendCMIX). Useful when one observer is registered
	// for a multi-recipient client. Nil for SendManyCMIX paths — see
	// SendCMIXMulti for the multi-recipient analog (not currently
	// surfaced separately; nil here means "skip fired from sendMany").
	Recipient *id.ID

	// RoundID is the selected round's ID. Zero when SkipReason ==
	// "best_round_nil" (no round was selected).
	RoundID uint64

	// SkipReason is one of the constants documented on the type.
	SkipReason string

	// SkipError is the wrapped error when applicable (process_round_err);
	// nil for best_round_nil, contains_blacklisted, and too_late_round.
	SkipError error

	// NumRoundTries is the round-tries counter at the moment of skip
	// (0-based). Distinguishes "skipped on first round-try" from "skipped
	// after several rounds were searched".
	NumRoundTries uint

	// TimeoutPreClamp is calculateSendTimeoutDetailed's raw subtraction
	// (roundStart - (now + 250ms)) BEFORE the [100ms, max] clamp.
	// Populated only when SkipReason == "too_late_round" — carries the
	// raw preClamp value (negative-allowed) so the operator can see
	// *how* late the round was. Zero for other skip reasons.
	TimeoutPreClamp time.Duration
}

// Stable SkipReason values for SendSkipInfo. Constants live here so
// adopters compile-check their switches.
const (
	SendSkipReasonBestRoundNil      = "best_round_nil"
	SendSkipReasonContainsBlacklist = "contains_blacklisted"
	SendSkipReasonProcessRoundErr   = "process_round_err"
	SendSkipReasonTooLateRound      = "too_late_round"
)
