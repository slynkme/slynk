////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package pickup

import (
	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/xx_network/primitives/id"
)

func (m *pickup) GetMessagesFromRound(
	roundID id.Round, identity receptionID.EphemeralIdentity) {
	m.pending.start(identity.Source) // Slynk: see pending_slynk.go

	// Get the round from the in-RAM store
	ri, err := m.instance.GetRound(roundID)

	// If we did not find it, then send to Historical Rounds Retrieval
	if err != nil || m.params.ForceHistoricalRounds {

		// Store the round as an un-retrieved round without a round info
		// This will silently do nothing if the round is
		err = m.unchecked.AddRound(roundID, nil,
			identity.Source, identity.EphId)
		if err != nil {
			jww.FATAL.Panicf(
				"Failed to denote Unchecked Round for round %d", roundID)
		}

		if m.params.ForceHistoricalRounds {
			jww.WARN.Printf(
				"Forcing use of historical rounds for round ID %d.", roundID)
		}

		jww.INFO.Printf("Messages found in round %d for %d (%s), looking "+
			"up messages via historical lookup", roundID, identity.EphId.Int64(),
			identity.Source)

		err = m.historical.LookupHistoricalRound(
			roundID, func(round rounds.Round, success bool) {
				if !success {
					// TODO: Implement me
					// Slynk: counted as a failed pickup; the unchecked
					// sweep retries the round.
					m.pending.finish(roundID, identity.Source, identity.EphId, true)
					// Slynk: and not passed on. The callback gets an empty
					// Round, whose nil Topology made getGatewayList panic
					// and stopped the client; its ID of 0 also left a
					// phantom round 0 in the unchecked store.
					return // Slynk
				}

				// If found, send to Message Retrieval Workers
				m.lookupRoundMessages <- roundLookup{
					Round:    round,
					Identity: identity,
				}
			})
		if err != nil { // Slynk: no lookup was made; the sweep retries it
			m.pending.finish(roundID, identity.Source, identity.EphId, true) // Slynk
		} // Slynk
	} else {
		// If we did find it, send it to the round pickup thread
		jww.INFO.Printf("Messages found in round %d for %d (%s), looking "+
			"up messages via in ram lookup", roundID, identity.EphId.Int64(),
			identity.Source)

		// store the round as an un-retrieved round
		err = m.unchecked.AddRound(roundID, ri,
			identity.Source, identity.EphId)
		if err != nil {
			jww.FATAL.Panicf(
				"Failed to denote Unchecked Round for round %d", roundID)
		}

		// If found, send to Message Retrieval Workers
		m.lookupRoundMessages <- roundLookup{
			Round:    rounds.MakeRound(ri),
			Identity: identity,
		}
	}

}
