////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"encoding/binary"
	"time"

	jww "github.com/spf13/jwalterweatherman"
	"go.uber.org/ratelimit"

	"gitlab.com/elixxir/client/v4/channelsFileTransfer/store"
	"gitlab.com/elixxir/client/v4/stoppable"
	"gitlab.com/elixxir/crypto/cyclic"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/xx_network/crypto/csprng"
)

const (
	// Duration to wait before adding a partially filled part packet to the send
	// channel.
	unfilledPacketTimeout = 100 * time.Millisecond
)

// batchBuilderThread creates batches of file parts as they become available and
// buffer them to send. Also rate limits adding to the buffer.
func (m *manager) batchBuilderThread(stop *stoppable.Single) {
	// Calculate rate and make rate limiter
	rl := newRateLimiter(m.params.MaxThroughput, m.cmixGroup)

	// Build each batch and add to the queue
	for {
		numParts := generateRandomPacketSize(m.rng, int(m.minParts.Load())) // Slynk: settable minimum
		packet := make([]*store.Part, 0, numParts)
		delayedTimer := NewDelayedTimer(unfilledPacketTimeout)
	loop:
		for cap(packet) > len(packet) {
			select {
			case <-stop.Quit():
				delayedTimer.Stop()
				jww.DEBUG.Printf("[FT] Stopping file part packing thread " +
					"while packing: stoppable triggered.")
				stop.ToStopped()
				return
			case <-*delayedTimer.C:
				break loop
			case p := <-m.batchQueue:
				// Drop parts of a transfer that has failed, completed or been
				// closed out. This is the one point every re-queue passes
				// through — from a failed send, a failed round, or a resend of
				// an unreceived part — so it is where a dead transfer stops
				// circulating. The packet keeps filling from live parts, and
				// the unfilled-packet timer stays unstarted so a packet holding
				// nothing but dead parts is never flushed.
				if p.TransferStatus() != store.Running {
					continue
				}

				packet = append(packet, p)
				delayedTimer.Start()
			}
		}

		// Rate limiter
		rl.Take()
		m.sendQueue <- packet
	}
}

// newRateLimiter generates a new ratelimit.Limiter that limits the bandwidth to
// the given max throughput (in bytes per second).
func newRateLimiter(
	maxThroughput int, cmixGroup *cyclic.Group) ratelimit.Limiter {
	// Calculate rate and make rate limiter if max throughput is set
	if maxThroughput > 0 {
		// Calculate the average amount of data sent in each batch
		messageSize := format.NewMessage(cmixGroup.GetP().ByteLen()).ContentsSize()
		avgNumMessages := (minPartsSendPerRound + maxPartsSendPerRound) / 2
		avgSendSize := avgNumMessages * messageSize

		jww.DEBUG.Printf("[FT] Rate limiting parameters: message size: %d, "+
			"average number of messages per send: %d, average size of send: %d",
			messageSize, avgNumMessages, avgSendSize)

		// Calculate the time window needed to achieve the desired bandwidth
		per := time.Second
		switch {
		case avgSendSize < maxThroughput:
			per = time.Second
		case avgSendSize < maxThroughput*60:
			per = time.Minute
		case avgSendSize < maxThroughput*60*60:
			per = time.Hour
		case avgSendSize < maxThroughput*60*60*24:
			per = time.Hour * 24
		case avgSendSize < maxThroughput*60*60*24*7:
			per = time.Hour * 24 * 7
		}

		// Calculate the rate of messages per time window
		rate := int((float64(maxThroughput) / float64(avgSendSize)) *
			float64(per/time.Second))

		jww.INFO.Printf("[FT] Max throughput is %d bytes/second. "+
			"File transfer will be rate limited to %d per %s.",
			maxThroughput, rate, per)

		return ratelimit.New(rate, ratelimit.WithoutSlack, ratelimit.Per(per))
	}

	// If the max throughput is zero, then create an unlimited rate limiter
	jww.WARN.Printf("[FT] Max throughput is %d bytes/second. "+
		"File transfer will not be rate limited.", maxThroughput)
	return ratelimit.NewUnlimited()
}

// generateRandomPacketSize returns a random number between minParts
// and maxPartsSendPerRound, inclusive.
func generateRandomPacketSize(rngGen *fastRNG.StreamGenerator, minParts int) int { // Slynk: minParts argument
	rng := rngGen.GetStream()
	defer rng.Close()

	// Generate random bytes
	b, err := csprng.Generate(8, rng)
	if err != nil {
		jww.FATAL.Panicf("[FT] Failed to generate random number of file "+
			"parts to send: %+v", err)
	}

	// Convert bytes to integer
	num := binary.LittleEndian.Uint64(b)

	if minParts < 1 || minParts > maxPartsSendPerRound { // Slynk: never 0 or over 11
		minParts = minPartsSendPerRound // Slynk:
	} // Slynk:

	// Return random number that is minParts <= num <= max
	// Slynk: the stock num%max+min only stays within max when min is 1; with
	// a higher min it overshoots the gateway's 11-message cap.
	return int(num%uint64(maxPartsSendPerRound-minParts+1)) + minParts // Slynk:
}
