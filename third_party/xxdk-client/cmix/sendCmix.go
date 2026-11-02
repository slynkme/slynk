////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package cmix

import (
	"fmt"
	"strings"
	"time"

	"gitlab.com/elixxir/client/v4/cmix/attempts"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/primitives/states"

	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/cmix/gateway"
	"gitlab.com/elixxir/client/v4/cmix/nodes"
	"gitlab.com/elixxir/client/v4/event"
	"gitlab.com/elixxir/client/v4/stoppable"
	pb "gitlab.com/elixxir/comms/mixmessages"
	"gitlab.com/elixxir/comms/network"
	"gitlab.com/elixxir/crypto/cmix"
	"gitlab.com/elixxir/crypto/cyclic"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/primitives/excludedRounds"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/xx_network/comms/connect"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
	"gitlab.com/xx_network/primitives/netTime"
	"gitlab.com/xx_network/primitives/rateLimiting"
)

// Send sends a "raw" cMix message payload to the provided recipient.
// Returns the round ID of the round the payload was sent or an error if it
// fails.
// This does not have end-to-end encryption on it and is used exclusively as
// a send for higher order cryptographic protocols. Do not use unless
// implementing a protocol on top.
//
//	recipient - cMix ID of the recipient.
//	fingerprint - Key Fingerprint. 256-bit field to store a 255-bit
//	   fingerprint, highest order bit must be 0 (panic otherwise). If your
//	   system does not use key fingerprints, this must be random bits.
//	service - Reception Service. The backup way for a client to identify
//	   messages on receipt via trial hashing and to identify notifications.
//	   If unused, use message.GetRandomService to fill the field with
//	   random data.
//	payload - Contents of the message. Cannot exceed the payload size for a
//	   cMix message (panic otherwise).
//	mac - 256-bit field to store a 255-bit mac, highest order bit must be 0
//	   (panic otherwise). If used, fill with random bits.
//
// Will return an error if the network is unhealthy or if it fails to send
// (along with the reason). Blocks until successful sends or errors.
// WARNING: Do not roll your own crypto.
func (c *client) Send(recipient *id.ID, fingerprint format.Fingerprint,
	service Service, payload, mac []byte, cmixParams CMIXParams) (
	rounds.Round, ephemeral.Id, error) {
	// create an internal assembler function to pass to sendWithAssembler
	assembler := func(rid id.Round) (format.Fingerprint, Service,
		[]byte, []byte, error) {
		return fingerprint, service, payload, mac, nil
	}
	return c.sendWithAssembler(recipient, assembler, cmixParams)
}

// SendWithAssembler sends a variable cMix payload to the provided recipient.
// The payload sent is based on the MessageAssembler function passed in, which
// accepts a round ID and returns the necessary payload data.
// Returns the round ID of the round the payload was sent or an error if it
// fails.
// This does not have end-to-end encryption on it and is used exclusively as
// a send operation for higher order cryptographic protocols. Do not use unless
// implementing a protocol on top.
//
//	recipient - cMix ID of the recipient.
//	assembler - MessageAssembler function, accepting round ID and returning
//	fingerprint	format.Fingerprint, service message.Service, payload, mac []byte
//
// Will return an error if the network is unhealthy or if it fails to send
// (along with the reason). Blocks until successful sends or errors.
// WARNING: Do not roll your own crypto.
func (c *client) SendWithAssembler(recipient *id.ID, assembler MessageAssembler,
	cmixParams CMIXParams) (
	rounds.Round, ephemeral.Id, error) {
	// Critical messaging and assembler-based message payloads are not compatible
	if cmixParams.Critical {
		return rounds.Round{}, ephemeral.Id{},
			errors.New("Cannot send critical messages with a message assembler")
	}
	return c.sendWithAssembler(recipient, assembler, cmixParams)
}

// sendWithAssembler wraps the passed in MessageAssembler in a messageAssembler
// for sendCmixHelper, and sets up critical message handling where applicable.
func (c *client) sendWithAssembler(recipient *id.ID, assembler MessageAssembler,
	cmixParams CMIXParams) (
	rounds.Round, ephemeral.Id, error) {
	if !c.Monitor.IsHealthy() {
		return rounds.Round{}, ephemeral.Id{}, errors.New(
			"Cannot send cmix message when the network is not healthy")
	}

	// Create an internal messageAssembler which returns a format.Message
	assemblerFunc := func(rid id.Round) (format.Message, error) {
		fingerprint, service, payload, mac, err := assembler(rid)

		if err != nil {
			return format.Message{}, err
		}

		if len(payload) != c.maxMsgLen {
			return format.Message{}, errors.Errorf(
				"bad message length (%d, need %d)",
				len(payload), c.maxMsgLen)
		}

		// Build message. Will panic if inputs are not correct.
		msg := format.NewMessage(c.session.GetCmixGroup().GetP().ByteLen())
		msg.SetContents(payload)
		msg.SetKeyFP(fingerprint)
		sih, err := service.Hash(recipient, msg.GetContents())
		if err != nil {
			return format.Message{}, err
		}
		msg.SetSIH(sih)
		msg.SetMac(mac)

		jww.TRACE.Printf("sendCmix Contents: %v, KeyFP: %v, MAC: %v, SIH: %v",
			msg.GetContents(), msg.GetKeyFP(), msg.GetMac(),
			msg.GetSIH())

		if cmixParams.Critical {
			c.crit.AddProcessing(msg, recipient, cmixParams)
		}
		return msg, nil
	}

	r, ephID, msg, rtnErr := sendCmixHelper(c.Sender, assemblerFunc, recipient, cmixParams,
		c.instance, c.session.GetCmixGroup(), c.Registrar, c.rng, c.events,
		c.session.GetTransmissionID(), c.comms, c.attemptTracker, c.sendAttemptObs)

	if cmixParams.Critical {
		c.crit.handle(msg, recipient, r.ID, rtnErr)
	}

	return r, ephID, rtnErr
}

// sendCmixHelper is a helper function for client.SendCMIX.
//
// Round-tries semantic: the `attempted` excluded-rounds set is both
// consulted (passed to findBestRound to skip previously-attempted rounds)
// and maintained — failed sends Insert their round.ID so the round-tries
// loop doesn't re-pick a known-bad round inside one SendCMIX call.
// Blacklist and processRound paths intentionally do NOT exclude
// (XXN-264 Strand E).
//
// Too-late-round skip (XXN-267): when CMIXParams.TooLateThreshold is
// positive and calculateSendTimeoutDetailed's preClamp value falls below
// it, sendFunc returns ErrRoundTooLate before issuing the gRPC call.
// The outer handler detects the sentinel, fires OnSendSkipped with
// SendSkipReasonTooLateRound, Inserts the round into `attempted`, and
// continues. Zero threshold disables the mechanism — preserves the
// pre-XXN-267 100ms-floor-clamp behavior for backwards compatibility.
// NOTE: Payloads sent are not end-to-end encrypted; metadata is NOT protected
// with this call. See SendE2E for end-to-end encryption and full privacy
// protection.
// Internal SendCmix, which bypasses the network check, will attempt to send to
// the network without checking state. It has a built-in retry system which can
// be configured through the params object.
// If the message is successfully sent, the ID of the round sent it is returned,
// which can be registered with the network instance to get a callback on its
// status.
func sendCmixHelper(sender gateway.Sender, assembler messageAssembler,
	recipient *id.ID, cmixParams CMIXParams, instance *network.Instance,
	grp *cyclic.Group, nodes nodes.Registrar, rng *fastRNG.StreamGenerator,
	events event.Reporter, senderId *id.ID, comms SendCmixCommsInterface,
	attemptTracker attempts.SendAttemptTracker,
	sendAttemptObs SendAttemptObserver) (
	rounds.Round, ephemeral.Id, format.Message, error) {

	if cmixParams.RoundTries == 0 {
		return rounds.Round{}, ephemeral.Id{}, format.Message{},
			errors.Errorf("invalid parameter set, "+
				"RoundTries cannot be 0: %+v", cmixParams)
	}

	timeStart := netTime.Now()
	maxTimeout := sender.GetHostParams().SendTimeout

	var attempted excludedRounds.ExcludedRounds
	if cmixParams.ExcludedRounds != nil {
		attempted = cmixParams.ExcludedRounds
	} else {
		attempted = excludedRounds.NewSet()
	}

	stream := rng.GetStream()
	defer stream.Close()

	numAttempts := 0
	if !cmixParams.Probe {
		optimalAttempts, ready := attemptTracker.GetOptimalNumAttempts()
		if ready {
			numAttempts = optimalAttempts
			jww.INFO.Printf("[Send-%s] Looking for round to send cMix message to "+
				"%s, sending non probe with %d optimalAttempts", cmixParams.DebugTag, recipient, numAttempts)
		} else {
			numAttempts = 4
			jww.INFO.Printf("[Send-%s] Looking for round to send cMix message to "+
				"%s, sending non probe with %d non optimalAttempts, insufficient data",
				cmixParams.DebugTag, recipient, numAttempts)
		}
	} else {
		jww.INFO.Printf("[Send-%s] Looking for round to send cMix message to "+
			"%s, sending probe with %d Attempts, insufficient data",
			cmixParams.DebugTag, recipient, numAttempts)
		defer attemptTracker.SubmitProbeAttempt(numAttempts)
	}

	for numRoundTries := uint(0); numRoundTries < cmixParams.RoundTries; numRoundTries,
		numAttempts = numRoundTries+1, numAttempts+1 {
		elapsed := netTime.Since(timeStart)
		jww.TRACE.Printf("[Send-%s] try %d, elapsed: %s",
			cmixParams.DebugTag, numRoundTries, elapsed)

		if elapsed > cmixParams.Timeout {
			jww.INFO.Printf("[Send-%s] No rounds to send to %s "+
				"were found before timeout %s",
				cmixParams.DebugTag, recipient, cmixParams.Timeout)
			return rounds.Round{}, ephemeral.Id{}, format.Message{}, errors.New("Sending cmix message timed out")
		}

		if numRoundTries > 0 {
			jww.INFO.Printf("[Send-%s] Attempt %d to find round to send "+
				"message to %s", cmixParams.DebugTag,
				numRoundTries+1, recipient)
		}

		startSearch := netTime.Now()
		// Find the best round to send to, excluding attempted rounds
		remainingTime := cmixParams.Timeout - elapsed
		waitingRounds := instance.GetWaitingRounds()
		bestRound, _, err := waitingRounds.GetUpcomingRealtime(
			remainingTime, attempted, numAttempts, sendTimeBuffer)
		if err != nil {
			jww.WARN.Printf("[Send-%s] failed to GetUpcomingRealtime: "+
				"%+v", cmixParams.DebugTag, err)
		}

		if bestRound == nil {
			jww.WARN.Printf(
				"[Send-%s] Best round on send is nil",
				cmixParams.DebugTag)
			if sendAttemptObs != nil {
				sendAttemptObs.OnSendSkipped(SendSkipInfo{
					Recipient:     recipient,
					RoundID:       0,
					SkipReason:    SendSkipReasonBestRoundNil,
					NumRoundTries: numRoundTries,
				})
			}
			continue
		}

		jww.DEBUG.Printf("[Send-%s] Best round found, took %s: %d",
			cmixParams.DebugTag, netTime.Since(startSearch), bestRound.ID)

		startSend := time.Now()
		// Determine whether the selected round contains any
		// nodes that are blacklisted by the CMIXParams object
		containsBlacklisted := false
		if cmixParams.BlacklistedNodes != nil {
			blacklist := cmixParams.BlacklistedNodes
			for _, nodeId := range bestRound.Topology {
				var nid id.ID
				copy(nid[:], nodeId)
				_, isBlacklisted := blacklist[nid]
				if isBlacklisted {
					containsBlacklisted = true
					break
				}
			}
		}

		if containsBlacklisted {
			jww.WARN.Printf("[Send-%s] Round %d "+
				"contains blacklisted nodes, skipping...",
				cmixParams.DebugTag,
				bestRound.ID)
			if sendAttemptObs != nil {
				sendAttemptObs.OnSendSkipped(SendSkipInfo{
					Recipient:     recipient,
					RoundID:       bestRound.ID,
					SkipReason:    SendSkipReasonContainsBlacklist,
					NumRoundTries: numRoundTries,
				})
			}
			continue
		}

		msg, err := assembler(id.Round(bestRound.ID))
		if err != nil {
			jww.ERROR.Printf("Failed to compile message: %+v", err)
			return rounds.Round{}, ephemeral.Id{}, format.Message{}, err
		}

		// Flip leading bits randomly to thwart a tagging attack.
		// See cmix.SetGroupBits for more info.
		cmix.SetGroupBits(msg, grp, stream)

		// Retrieve host and key information from round
		firstGateway, roundKeys, err := processRound(
			nodes, bestRound, recipient.String(), msg.Digest())
		if err != nil {
			jww.WARN.Printf("[Send-%s] SendCmix failed to process round "+
				"(will retry): %v", cmixParams.DebugTag, err)
			if sendAttemptObs != nil {
				sendAttemptObs.OnSendSkipped(SendSkipInfo{
					Recipient:     recipient,
					RoundID:       bestRound.ID,
					SkipReason:    SendSkipReasonProcessRoundErr,
					SkipError:     err,
					NumRoundTries: numRoundTries,
				})
			}
			continue
		}

		jww.TRACE.Printf("[Send-%s] Round %v processed, firstGW: %s",
			cmixParams.DebugTag, bestRound, firstGateway)

		// Build the messages to send
		wrappedMsg, encMsg, ephID, err := buildSlotMessage(msg, recipient,
			firstGateway, stream, senderId, bestRound, roundKeys)
		if err != nil {
			return rounds.Round{}, ephemeral.Id{}, format.Message{}, err
		}

		timeRoundStart := time.Unix(0, int64(bestRound.Timestamps[states.QUEUED]))

		jww.INFO.Printf("[Send-%s] Sending to EphID %d (%s), on round %d "+
			"(msgDigest: %s, ecrMsgDigest: %s) via gateway %s starting "+
			"at %s (%s in the future)", cmixParams.DebugTag, ephID.Int64(),
			recipient, bestRound.ID, msg.Digest(), encMsg.Digest(),
			firstGateway.String(), timeRoundStart, netTime.Until(timeRoundStart))

		// Send the payload
		attemptIdx := 0 // 0-based attempt index within SendToPreferred (XXN-264 Strand B)
		// preClamp is hoisted to outer scope so the round-tries error
		// handler can read it when sendFunc returns ErrRoundTooLate
		// (XXN-267). Captured by reference via the sendFunc closure.
		var preClamp time.Duration
		sendFunc := func(host *connect.Host, target *id.ID,
			timeout time.Duration) (interface{}, error) {
			wrappedMsg.Target = target.Marshal()

			jww.TRACE.Printf(
				"[Send-%s] sendFunc %s", cmixParams.DebugTag, host)

			// XXN-265: collapsed the pre-existing botched-merge that
			// called calculateSendTimeout twice and min'd a pure value
			// against itself. Behavior preserved — production always
			// ended up with calculateSendTimeout's output anyway.
			// sendManyCmix.go's sendFunc has the correct min-of-two
			// pattern if the original intent ever needs restoring.
			//
			// XXN-264 Strand E: use the detailed form to surface the
			// pre-clamp value alongside the clamped output.
			timeout, preClamp = calculateSendTimeoutDetailed(bestRound, maxTimeout)

			// XXN-267: skip rounds whose QUEUED slot has drifted past
			// (or close to past). Without this, the 100ms floor inside
			// calculateSendTimeoutDetailed silently lets a doomed gRPC
			// call go out and burn a round-try on guaranteed-failure.
			// Refuse before firing OnSendAttempt — no gRPC call is
			// made, so firing the attempt observer would be misleading.
			// The outer error handler detects the sentinel and emits
			// OnSendSkipped with SendSkipReasonTooLateRound.
			if shouldSkipTooLateRound(preClamp, cmixParams.TooLateThreshold) {
				return nil, ErrRoundTooLate
			}

			// XXN-264 Strand B: fire the per-gateway-attempt observer
			// (if registered) just before SendPutMessage so Courier can
			// surface the computed timeout that xxDK is about to apply.
			if sendAttemptObs != nil {
				sendAttemptObs.OnSendAttempt(SendAttemptInfo{
					RoundID:         bestRound.ID,
					TargetGateway:   target,
					HostGateway:     host.GetId(),
					HostAddr:        host.GetAddress(),
					Timeout:         timeout,
					TimeoutPreClamp: preClamp,
					AttemptIndex:    attemptIdx,
				})
			}
			attemptIdx++

			// Send the message
			result, err := comms.SendPutMessage(host, wrappedMsg, timeout)
			jww.TRACE.Printf("[Send-%s] sendFunc %s put message",
				cmixParams.DebugTag, host)

			if err != nil {
				err := handlePutMessageError(
					firstGateway, nodes, recipient.String(), bestRound, err)
				jww.TRACE.Printf("[Send-%s] sendFunc %s error: %+v",
					cmixParams.DebugTag, host, err)
				return result, errors.WithMessagef(
					err, "SendCmix %s", unrecoverableError)
			}

			return result, err
		}

		jww.TRACE.Printf("[Send-%s] sendToPreferred %s",
			cmixParams.DebugTag, firstGateway)

		result, err := sender.SendToPreferred([]*id.ID{firstGateway}, sendFunc,
			cmixParams.Stop, cmixParams.SendTimeout)
		sendElapsed := netTime.Since(startSend)
		jww.DEBUG.Printf("[Send-%s] sendToPreferred %s returned after %s",
			cmixParams.DebugTag, firstGateway, sendElapsed)

		// Exit if the thread has been stopped
		if stoppable.CheckErr(err) {
			return rounds.Round{}, ephemeral.Id{}, format.Message{}, err
		}

		// If the comm errors or the message fails to send, continue retrying
		if err != nil {
			// XXN-267: too-late-round skip path. sendFunc refused the
			// gRPC call (no SendPutMessage attempted) because preClamp
			// was below CMIXParams.TooLateThreshold. Fire OnSendSkipped
			// with SendSkipReasonTooLateRound, exclude the round from
			// future picks, and continue. errors.Cause walks pkg/errors
			// wraps that SendToPreferred / handlePutMessageError may
			// have layered on.
			if errors.Cause(err) == ErrRoundTooLate {
				jww.INFO.Printf("[Send-%s] Round %d is too-late "+
					"(preClamp=%s, threshold=%s); skipping",
					cmixParams.DebugTag, bestRound.ID, preClamp,
					cmixParams.TooLateThreshold)
				if sendAttemptObs != nil {
					sendAttemptObs.OnSendSkipped(SendSkipInfo{
						Recipient:       recipient,
						RoundID:         bestRound.ID,
						SkipReason:      SendSkipReasonTooLateRound,
						TimeoutPreClamp: preClamp,
						NumRoundTries:   numRoundTries,
					})
				}
				attempted.Insert(id.Round(bestRound.ID))
				continue
			}

			if strings.Contains(err.Error(), rateLimiting.ClientRateLimitErr) {
				jww.ERROR.Printf("[Send-%s] SendCmix failed to send to "+
					"EphID %d (%s) on round %d: %+v", cmixParams.DebugTag,
					ephID.Int64(), recipient, bestRound.ID, err)
				return rounds.Round{}, ephemeral.Id{}, format.Message{}, err
			}

			jww.ERROR.Printf("[Send-%s] SendCmix failed to send to "+
				"EphID %d (%s) on round %d, trying a new round: %+v",
				cmixParams.DebugTag, ephID.Int64(), recipient, bestRound.ID, err)
			// XXN-264 Strand E: exclude the failed round from future
			// round-tries iterations within this SendCMIX call.
			// findBestRound consults `attempted`; without this Insert,
			// the loop can re-pick the same too-late round and burn
			// further round-tries on it. Targets exactly the
			// send-error-continue path — blacklist + processRound paths
			// intentionally do NOT exclude (blacklist is configuration-
			// driven, processRound is host-pool transient and re-pick
			// may legitimately succeed).
			attempted.Insert(id.Round(bestRound.ID))
			continue
		}

		// Return if it sends properly
		gwSlotResp := result.(*pb.GatewaySlotResponse)
		if gwSlotResp.Accepted {
			totalElapsed := netTime.Since(timeStart)
			m := fmt.Sprintf("[Send-%s] Successfully sent to EphID %v "+
				"(source: %s) in round %d (msgDigest: %s), elapsed: %s "+
				"numRoundTries: %d", cmixParams.DebugTag, ephID.Int64(),
				recipient, bestRound.ID, msg.Digest(), totalElapsed, numRoundTries)

			jww.INFO.Print(m)
			events.Report(1, "MessageSend", "Metric", m)

			return rounds.MakeRound(bestRound), ephID, msg, nil
		} else {
			jww.FATAL.Panicf("[Send-%s] Gateway %s returned no error, "+
				"but failed to accept message when sending to EphID %d (%s) "+
				"on round %d", cmixParams.DebugTag, firstGateway, ephID.Int64(),
				recipient, bestRound.ID)
		}

	}
	return rounds.Round{}, ephemeral.Id{}, format.Message{},
		errors.New("failed to send the message, out of round retries")
}
