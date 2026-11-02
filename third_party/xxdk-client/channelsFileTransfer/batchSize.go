////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

// DefaultMinPartsPerSend is the fewest file parts a batch carries unless
// SetMinPartsPerSend says otherwise. A batch never carries more than 11.
const DefaultMinPartsPerSend = minPartsSendPerRound

// SetMinPartsPerSend sets the fewest file parts each later batch carries,
// clamped to 1 through 11; each batch's size is drawn at random from that
// minimum up to 11. A client sends at most one batch per mixnet round, so a
// lower minimum puts fewer of an upload's parts in each round and makes the
// upload slower.
func (w *Wrapper) SetMinPartsPerSend(n int) {
	w.m.setMinParts(n)
}

func (m *manager) setMinParts(n int) {
	if n < 1 {
		n = 1
	}
	if n > maxPartsSendPerRound {
		n = maxPartsSendPerRound
	}
	m.minParts.Store(int32(n))
}
