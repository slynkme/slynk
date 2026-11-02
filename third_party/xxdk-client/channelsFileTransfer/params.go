////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	json "github.com/goccy/go-json"
	"time"

	"gitlab.com/elixxir/client/v4/cmix"
)

const (
	defaultMaxThroughput = 150_000 // 150 kB per second
	defaultSendTimeout   = 500 * time.Millisecond
	defaultResendWait    = 30 * time.Second

	defaultSendRetryWait    = 2 * time.Second
	defaultMaxSendRetryWait = 10 * time.Second
)

// Params contains parameters used for file transfer.
type Params struct {
	// MaxThroughput is the maximum data transfer speed to send file parts (in
	// bytes per second). If set to 0, rate limiting will be disabled.
	MaxThroughput int `json:"maxThroughput"`

	// SendTimeout is the duration, in nanoseconds, before sending on a round
	// times out. It is recommended that SendTimeout is not changed from its
	// default.
	SendTimeout time.Duration `json:"sendTimeout"`

	// ResendWait is the duration, in nanoseconds, to wait to receive a file
	// part before resending it.
	ResendWait time.Duration `json:"resendWait"`

	// SendRetryWait is the base duration, in nanoseconds, to wait before
	// returning the parts of a batch whose send failed to the send queue. Each
	// further CONSECUTIVE failure for the same file doubles the wait, up to
	// MaxSendRetryWait; a batch of that file landing on a successful round
	// resets it.
	//
	// A transfer's fingerprints are spent on every part ATTEMPT and are never
	// returned, so with no wait a flaky uplink spends the entire budget in a
	// burst — a 9-part file was observed exhausting all 27 of its fingerprints
	// in five seconds — and the transfer is then permanently dead. This wait
	// does not enlarge the budget; it spreads it over enough wall clock to
	// outlast a transient outage. If set to 0, failed parts are re-queued
	// immediately, which is the un-paced behaviour described above.
	SendRetryWait time.Duration `json:"sendRetryWait"`

	// MaxSendRetryWait is the ceiling, in nanoseconds, on the doubling applied
	// to SendRetryWait. It is what bounds a failing transfer's worst-case wall
	// clock, so it must stay well inside the caller's upload deadline. If it is
	// below SendRetryWait (including 0), the wait does not escalate and stays
	// at SendRetryWait.
	MaxSendRetryWait time.Duration `json:"maxSendRetryWait"`

	// Cmix are the parameters used when sending a cMix message.
	Cmix cmix.CMIXParams `json:"cmix"`
}

// DefaultParams returns a Params object filled with the default values.
func DefaultParams() Params {
	return Params{
		MaxThroughput:    defaultMaxThroughput,
		SendTimeout:      defaultSendTimeout,
		ResendWait:       defaultResendWait,
		SendRetryWait:    defaultSendRetryWait,
		MaxSendRetryWait: defaultMaxSendRetryWait,
		Cmix:             cmix.GetDefaultCMIXParams(),
	}
}

// GetParameters returns the default network parameters, or override with given
// parameters, if set. Returns an error if provided invalid JSON. If the JSON is
// valid but does not match the Params structure, the default parameters will be
// returned.
func GetParameters(params string) (Params, error) {
	p := DefaultParams()
	if len(params) > 0 {
		err := json.Unmarshal([]byte(params), &p)
		if err != nil {
			return Params{}, err
		}
	}
	return p, nil
}
