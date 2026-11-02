////////////////////////////////////////////////////////////////////////////////
// Slynk: this file is Slynk's, not upstream xxDK's.                          //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"testing"

	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/xx_network/crypto/csprng"
)

// Slynk: every packet size must lie in [minParts, maxPartsSendPerRound],
// and each size in between must come up; above 11 the gateway rejects the
// whole send.
func Test_generateRandomPacketSize_Range(t *testing.T) {
	rngGen := fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG)
	for _, minParts := range []int{minPartsSendPerRound, 1, maxPartsSendPerRound} {
		seen := make(map[int]int)
		for i := 0; i < 3000; i++ {
			n := generateRandomPacketSize(rngGen, minParts)
			if n < minParts || n > maxPartsSendPerRound {
				t.Fatalf("min %d: packet size %d outside [%d, %d]",
					minParts, n, minParts, maxPartsSendPerRound)
			}
			seen[n]++
		}
		for n := minParts; n <= maxPartsSendPerRound; n++ {
			if seen[n] == 0 {
				t.Errorf("min %d: size %d never drawn in 3000 tries: %v",
					minParts, n, seen)
			}
		}
	}
}

// Slynk: SetMinPartsPerSend clamps to 1..11 and starts at the default.
func Test_manager_setMinParts(t *testing.T) {
	m := &manager{}
	m.minParts.Store(DefaultMinPartsPerSend)
	for _, tc := range []struct{ in, want int }{
		{1, 1}, {9, 9}, {11, 11}, {0, 1}, {-3, 1}, {12, 11}, {100, 11},
	} {
		m.setMinParts(tc.in)
		if got := int(m.minParts.Load()); got != tc.want {
			t.Errorf("setMinParts(%d) left %d, want %d", tc.in, got, tc.want)
		}
	}
}
