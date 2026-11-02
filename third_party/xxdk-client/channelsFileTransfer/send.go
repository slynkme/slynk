////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"encoding/binary"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"

	"gitlab.com/elixxir/client/v4/channelsFileTransfer/sentRoundTracker"
	"gitlab.com/elixxir/client/v4/channelsFileTransfer/store"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/message"
	"gitlab.com/elixxir/client/v4/stoppable"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
)

// Error messages.
const (
	// manager.sendCmix
	errNoMoreRetries = "file transfer failed: ran our of retries."
)

const (
	// Duration to wait for round to finish before timing out.
	roundResultsTimeout = 15 * time.Second

	// Age when rounds that files were sent from are deleted from the tracker.
	clearSentRoundsAge = 10 * time.Second

	// Number of concurrent sending threads
	workerPoolThreads = 4

	// Tag that prints with cMix sending logs.
	cMixDebugTag = "FT.Part"

	// Prefix used for the name of a stoppable used for a sending thread
	sendThreadStoppableName = "FilePartSendingThread#"

	// sendRetryJitterDenom bounds the random reduction applied to a send
	// backoff: the wait lands uniformly in ((1 - 1/d) * wait, wait]. It is
	// subtractive only, so jitter can never push a transfer past its caller's
	// deadline. It exists so that several transfers that all failed on the same
	// dead round do not all come back on the same instant and re-collide.
	sendRetryJitterDenom = 4
)

// startSendingWorkerPool initialises a worker pool of file part sending
// threads.
func (m *manager) startSendingWorkerPool(multiStop *stoppable.Multi) {
	// Set up cMix sending parameters
	m.params.Cmix.SendTimeout = m.params.SendTimeout
	m.params.Cmix.ExcludedRounds =
		sentRoundTracker.NewManager(clearSentRoundsAge)

	if m.params.Cmix.DebugTag == cmix.DefaultDebugTag ||
		m.params.Cmix.DebugTag == "" {
		m.params.Cmix.DebugTag = cMixDebugTag
	}

	for i := 0; i < workerPoolThreads; i++ {
		stop := stoppable.NewSingle(sendThreadStoppableName + strconv.Itoa(i))
		go m.sendingThread(stop)
		multiStop.Add(stop)
	}

}

// sendingThread sends part packets that become available oin the send queue.
func (m *manager) sendingThread(stop *stoppable.Single) {
	healthChan := make(chan bool, 10)
	healthChanID := m.cmix.AddHealthCallback(func(b bool) { healthChan <- b })
	for {
		select {
		case <-stop.Quit():
			jww.DEBUG.Printf("[FT] Stopping file part sending thread (%s): "+
				"stoppable triggered.", stop.Name())
			m.cmix.RemoveHealthCallback(healthChanID)
			stop.ToStopped()
			return
		case healthy := <-healthChan:
			for !healthy {
				healthy = <-healthChan
			}
		case packet := <-m.sendQueue:
			m.sendCmix(packet)
		}
	}
}

// sendCmix sends the parts in the packet via Cmix.SendMany.
func (m *manager) sendCmix(packet []*store.Part) {
	// validParts will contain all parts in the original packet excluding those
	// that return an error from GetEncryptedPart
	validParts := make([]*store.Part, 0, len(packet))

	// Encrypt each part and to a TargetedCmixMessage
	messages := make([]cmix.TargetedCmixMessage, 0, len(packet))
	for _, p := range packet {
		// Skip parts of a transfer that is no longer running. GetEncryptedPart
		// pops a fingerprint BEFORE any network I/O, so attempting a part of a
		// dead transfer spends budget that a live transfer could have used,
		// re-reports errNoMoreRetries once per part of every batch, and — once
		// every part is dead — leaves messages empty for SendMany.
		if p.TransferStatus() != store.Running {
			continue
		}

		encryptedPart, mac, fp, err :=
			p.GetEncryptedPart(m.cmix.GetMaxMessageLength())
		if err != nil {
			jww.ERROR.Printf(
				"[FT] File transfer %s failed: %+v", p.GetFileID(), err)
			m.callbacks.Call(p.GetFileID(), errors.New(errNoMoreRetries))
			continue
		}

		validParts = append(validParts, p)

		messages = append(messages, cmix.TargetedCmixMessage{
			Recipient:   p.GetRecipient(),
			Payload:     encryptedPart,
			Fingerprint: fp,
			Service:     message.Service{},
			Mac:         mac,
		})
	}

	// Every part in this packet belongs to a transfer that has already given
	// up, so there is nothing to send and nothing to re-queue. SendMany with an
	// empty list builds a request gateways reject as a malformed message
	// object, and — should a gateway ever answer Accepted=false with no error —
	// trips the FATAL panic in cmix.SendManyCMIX.
	if len(messages) == 0 {
		jww.DEBUG.Printf("[FT] No sendable file parts in a packet of %d; "+
			"skipping send.", len(packet))
		return
	}

	// Clear all old rounds from the sent rounds list
	m.params.Cmix.ExcludedRounds.(*sentRoundTracker.Manager).RemoveOldRounds()

	jww.TRACE.Printf("[FT] Sending %d file parts via SendManyCMIX: %s",
		len(messages), validParts)

	rid, _, err := m.cmix.SendMany(messages, m.params.Cmix)
	if err != nil {
		jww.WARN.Printf("[FT] Failed to send %d file parts via "+
			"SendManyCMIX (%s): %+v", len(messages), validParts, err)

		// Re-queue behind the transfer's escalating backoff rather than
		// immediately, then RETURN. Falling through would ask for the results
		// of rid, which is the zero Round: that starts a historical lookup for
		// round 0 that times out roundResultsTimeout later and re-queues these
		// same parts a SECOND time, doubling the fingerprint burn per failed
		// batch and keeping a dead transfer sending long after it gave up.
		m.requeueFailedParts(groupPartsByFileID(validParts))
		return
	}

	m.cmix.GetRoundResults(
		roundResultsTimeout, m.roundResultsCallback(validParts), rid.ID)
}

func printGrouped(g map[ftCrypto.ID][]*store.Part) string {
	transfers := make([]string, 0, len(g))
	for fid, parts := range g {
		partNums := make([]string, len(parts))
		for i, part := range parts {
			partNums[i] = strconv.Itoa(int(part.PartNum()))
		}
		transfers = append(
			transfers, fid.String()+":["+strings.Join(partNums, ", ")+"]")
	}

	return strings.Join(transfers, " ")
}

// groupPartsByFileID groups file parts by the transfer they belong to. A single
// batch can span several transfers, and both the progress callbacks and the
// send backoff are per-transfer.
func groupPartsByFileID(parts []*store.Part) map[ftCrypto.ID][]*store.Part {
	grouped := make(map[ftCrypto.ID][]*store.Part, len(parts))
	for _, p := range parts {
		grouped[p.GetFileID()] = append(grouped[p.GetFileID()], p)
	}

	return grouped
}

// roundResultsCallback generates a network.RoundEventCallback that handles
// all parts in the packet once the round succeeds or fails.
func (m *manager) roundResultsCallback(
	packet []*store.Part) cmix.RoundEventCallback {
	// Group file parts by transfer
	grouped := groupPartsByFileID(packet)

	return func(
		allRoundsSucceeded, _ bool, rounds map[id.Round]cmix.RoundResult) {
		// Get round ID
		var rid id.Round
		for rid = range rounds {
			break
		}

		// Get send completion time
		var sendTimestamp time.Time
		for _, r := range rounds {
			sendTimestamp = r.Round.Timestamps[states.COMPLETED]
			break
		}

		succeeded := roundSucceeded(rounds) // Slynk: for uploads confirmed by round
		if allRoundsSucceeded {
			jww.TRACE.Printf("[FT] %d file parts sent on round %d (%s)",
				len(packet), rid, printGrouped(grouped))

			// If the round succeeded, then mark all parts as arrived and report
			// each transfer's progress on its progress callback
			for fid, parts := range grouped {
				if m.confirmByRound(fid, parts, succeeded) { // Slynk:
					continue // Slynk:
				} // Slynk:
				for _, p := range parts {
					p.MarkSent()
				}

				// Call the progress callback after all parts have been marked
				// so that the progress reported included all parts in the batch
				m.callbacks.Call(fid, nil)

				// This batch landed, so the link is working: the next failure
				// starts over at SendRetryWait instead of at the ceiling.
				m.clearSendBackoff(fid)
			}

			m.sentQueue <- &sentPartPacket{packet, sendTimestamp, false}
		} else {
			jww.DEBUG.Printf("[FT] %d file parts failed on round %d (%v)",
				len(packet), rid, grouped)

			// If the round failed, then return each part to the send queue
			// behind its transfer's escalating backoff.
			m.requeueFailedParts(grouped)
		}
	}
}

// resendUnreceived checks that all successfully sent file have been received
// after a set amount of times. Any unsent file parts are added back to the
// queue for sending.
func (m *manager) resendUnreceived(stop *stoppable.Single) {
	jww.DEBUG.Printf("[FT] Starting resend unreceived file part thread.")

	for i := 0; ; i++ {
		select {
		case <-stop.Quit():
			jww.DEBUG.Printf("[FT] Stopping file part resend thread (%s): "+
				"stoppable triggered.", stop.Name())
			stop.ToStopped()
			return
		case sentMessages := <-m.sentQueue:
			go func(sm *sentPartPacket) {
				waitTime := calcWaitTime(m.params.ResendWait, netTime.Now(), sm)

				jww.TRACE.Printf("[FT] Scheduled check for resend for %d "+
					"parts in %s: %v", len(sm.packet), waitTime, sm.packet)
				select {
				case <-time.After(waitTime):
					var resentParts []*store.Part
					for _, p := range sm.packet {
						if p.GetStatus() == store.SentPart {
							m.batchQueue <- p
							resentParts = append(resentParts, p)
						}
					}
					if len(resentParts) > 0 {
						jww.WARN.Printf("[FT] %d of %d parts not received; "+
							"resending parts: %v",
							len(resentParts), len(sm.packet), resentParts)
					} else {
						jww.TRACE.Printf("[FT] %d out of %d parts received.",
							len(sm.packet), len(sm.packet))
					}
				}
			}(sentMessages)
		}
	}
}

// calcWaitTime calculates the amount of time to wait before checking if the
// parts have been received.
func calcWaitTime(
	delay time.Duration, timeNow time.Time, spp *sentPartPacket) time.Duration {
	if spp.loaded {
		return delay
	}

	timeSinceSend := timeNow.Sub(spp.sentTime)
	if timeSinceSend >= delay {
		return 0
	}

	return delay - timeSinceSend
}

/* === Send backoff ========================================================= */

// A transfer's fingerprints are spent on every part ATTEMPT, before any network
// I/O, and are never returned. Re-queuing a failed batch immediately therefore
// spends the whole budget in a burst: a 9-part file exhausted all 27 of its
// fingerprints in five seconds on a flaky uplink, while plain messages over the
// same link at the same moment succeeded because they retry with a backoff.
//
// These helpers impose that missing backoff. They do not enlarge the budget —
// only the transfer's retry multiplier does that — they spread it over enough
// wall clock to outlast a transient outage.

// requeueFailedParts returns the parts of one or more failed batches to the
// batch queue after a per-transfer escalating backoff.
//
// It never blocks the caller, because neither caller may sleep: sendCmix runs
// on the sending worker pool, which is exactly workerPoolThreads goroutines
// shared by every concurrent transfer, and roundResultsCallback runs on a cMix
// round-results goroutine. batchBuilderThread is worse still — a single
// goroutine every transfer funnels through — which is why the wait is imposed
// here, on the way INTO batchQueue, rather than anywhere downstream of it.
func (m *manager) requeueFailedParts(grouped map[ftCrypto.ID][]*store.Part) {
	quit := m.stopChan()
	for fid, parts := range grouped {
		wait := m.nextSendBackoff(fid)
		jww.DEBUG.Printf("[FT] Re-queuing %d parts of file %s in %s.",
			len(parts), fid, wait)
		go m.requeueAfter(parts, wait, quit)
	}
}

// requeueAfter waits out a backoff and then returns the parts to the batch
// queue, abandoning them if the manager stops first.
func (m *manager) requeueAfter(
	parts []*store.Part, wait time.Duration, quit <-chan struct{}) {
	if wait > 0 {
		t := time.NewTimer(wait)
		defer t.Stop()

		select {
		case <-quit:
			return
		case <-t.C:
		}
	}

	for _, p := range parts {
		// The transfer may have failed, completed or been closed out while this
		// backoff was pending; do not resurrect its parts.
		if p.TransferStatus() != store.Running {
			continue
		}

		select {
		case m.batchQueue <- p:
		case <-quit:
			return
		}
	}
}

// nextSendBackoff records another consecutive failed send for the given file
// and returns how long to wait before its parts may be re-queued.
func (m *manager) nextSendBackoff(fid ftCrypto.ID) time.Duration {
	m.sendFailuresMux.Lock()
	m.sendFailures[fid]++
	failures := m.sendFailures[fid]
	m.sendFailuresMux.Unlock()

	return m.jitterBackoff(
		sendBackoffWait(m.params.SendRetryWait, m.params.MaxSendRetryWait,
			failures))
}

// clearSendBackoff resets a file's consecutive-failure count.
func (m *manager) clearSendBackoff(fid ftCrypto.ID) {
	m.sendFailuresMux.Lock()
	delete(m.sendFailures, fid)
	m.sendFailuresMux.Unlock()
}

// sendBackoffWait returns base doubled once per consecutive failure beyond the
// first, clamped to max. A base of 0 disables the backoff entirely, re-queuing
// failed parts immediately. A max below base is raised to base, so a max of 0
// means a constant wait of base with no escalation.
func sendBackoffWait(base, max time.Duration, failures uint) time.Duration {
	if base <= 0 || failures == 0 {
		return 0
	}

	if max < base {
		max = base
	}

	// Guarding the loop on wait < max both bounds it to log2(max/base)
	// iterations and keeps the doubling from overflowing time.Duration, which a
	// naive base << (failures-1) would do at around 63 failures.
	wait := base
	for i := uint(1); i < failures && wait < max; i++ {
		wait *= 2
	}

	if wait > max {
		wait = max
	}

	return wait
}

// jitterBackoff reduces a backoff by a random fraction of up to
// 1/sendRetryJitterDenom. It is subtractive only, so it can never extend a
// transfer's worst case past what MaxSendRetryWait implies.
func (m *manager) jitterBackoff(d time.Duration) time.Duration {
	if d <= 0 {
		return 0
	}

	maxReduction := int64(d) / sendRetryJitterDenom
	if maxReduction <= 0 {
		return d
	}

	rng := m.rng.GetStream()
	b, err := csprng.Generate(8, rng)
	rng.Close()
	if err != nil {
		// Deliberately not fatal: failing to jitter is not a reason to lose a
		// file transfer, let alone to take the process down.
		jww.WARN.Printf("[FT] Failed to generate send backoff jitter; using "+
			"the un-jittered wait %s: %+v", d, err)
		return d
	}

	return d - time.Duration(
		int64(binary.LittleEndian.Uint64(b)%uint64(maxReduction)))
}

// checkedReceivedParts returns a ReceivedProgressCallback that when passed to
// the received transfer handler, tracks which file parts have been received and
// updates their status in the store.SentTransfer. It also updates the sent
// progress callback on updates and clears the file from memory when the
// transfer completed.
func (m *manager) checkedReceivedParts(st *store.SentTransfer, fl *FileLink,
	completeCB sendCompleteCallback) ReceivedProgressCallback {
	return func(
		_ bool, _, _ uint16, rt ReceivedTransfer, t FilePartTracker, err error) {
		// Propagate the error to the sent progress callback
		if err != nil {
			m.callbacks.Call(st.GetFileID(), err)
			return
		}

		// Mark each received part as received in the SentTransfer
		var partsChanges []uint16
		for _, p := range st.GetUnsentParts() {
			if t.GetPartStatus(p.PartNum()) == FpReceived {
				p.MarkReceived()
				partsChanges = append(partsChanges, p.PartNum())
			}
		}
		for _, p := range st.GetSentParts() {
			if t.GetPartStatus(p.PartNum()) == FpReceived {
				p.MarkReceived()
				partsChanges = append(partsChanges, p.PartNum())
			}
		}

		// Call the progress callback if any parts were updated
		if len(partsChanges) > 0 {
			jww.TRACE.Printf(
				"[FT] %d file parts set as received for file %s (%d)",
				len(partsChanges), st.GetFileID(), partsChanges)
			m.callbacks.Call(st.GetFileID(), nil)
		}

		// Once the transfer is complete, close out both the sent and received
		// sides of the transfer
		if st.Status() == store.Completed {
			jww.DEBUG.Printf("[FT] Completed sending and receiving file %s.",
				st.GetFileID())
			if err = m.closeSend(st); err != nil {
				jww.ERROR.Printf("[FT] Failed to close file transfer send %s: "+
					"%+v", st.GetFileID(), err)
			}
			if _, err = m.receiveFromID(rt.GetFileID()); err != nil {
				jww.ERROR.Printf(
					"[FT] Failed to receive file transfer: %+v", err)
			}

			// FIXME: Possible bug: The send thinks it failed, but the receiver
			//  actually gets all the parts. This will cause the (sent) progress
			//  callback to return with an error but the completed callback to
			//  be called successfully.
			go completeCB(*fl)
		}
	}
}
