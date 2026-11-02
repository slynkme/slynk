////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file.                                                              //
////////////////////////////////////////////////////////////////////////////////

package channelsFileTransfer

import (
	"math/rand"
	"testing"
	"time"

	"github.com/pkg/errors"
	"github.com/stretchr/testify/require"

	"gitlab.com/elixxir/client/v4/channelsFileTransfer/sentRoundTracker"
	"gitlab.com/elixxir/client/v4/channelsFileTransfer/store"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/crypto/fastRNG"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
)

// Tests the backoff schedule itself: base doubled once per consecutive failure,
// clamped to max, with 0 meaning "no wait".
func Test_sendBackoffWait(t *testing.T) {
	tests := []struct {
		name      string
		base, max time.Duration
		failures  uint
		expected  time.Duration
	}{
		{"zero base disables the backoff",
			0, 10 * time.Second, 5, 0},
		{"zero failures has nothing to wait for",
			2 * time.Second, 10 * time.Second, 0, 0},
		{"first failure waits the base",
			2 * time.Second, 10 * time.Second, 1, 2 * time.Second},
		{"second failure doubles",
			2 * time.Second, 10 * time.Second, 2, 4 * time.Second},
		{"third failure doubles again",
			2 * time.Second, 10 * time.Second, 3, 8 * time.Second},
		{"fourth failure clamps to max",
			2 * time.Second, 10 * time.Second, 4, 10 * time.Second},
		{"further failures stay at max",
			2 * time.Second, 10 * time.Second, 9, 10 * time.Second},
		{"a max below base is raised to base",
			5 * time.Second, time.Second, 4, 5 * time.Second},
		{"a zero max means a constant base wait",
			5 * time.Second, 0, 7, 5 * time.Second},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.expected,
				sendBackoffWait(tt.base, tt.max, tt.failures))
		})
	}

	// A naive base << (failures-1) overflows time.Duration at around 63
	// failures and can go negative. The loop guard must both terminate and
	// clamp.
	t.Run("a huge failure count terminates at max", func(t *testing.T) {
		require.Equal(t, 10*time.Second,
			sendBackoffWait(time.Nanosecond, 10*time.Second, 1<<20))
	})
}

// newBackoffTestManager builds a manager wired to a mock cMix, with the send
// queues live but no worker pool running, so sendCmix can be driven directly
// and nothing else touches the queues.
func newBackoffTestManager(t *testing.T, params Params) (*manager, *mockCmix) {
	t.Helper()

	myID := id.NewIdFromString("backoffTestID", id.User, t)
	storage := newMockStorage()
	cMix := newMockCmix(myID, newMockCmixHandler(), storage)
	rngGen := fastRNG.NewStreamGenerator(1000, 10, csprng.NewSystemRNG)
	user := newMockE2e(myID, cMix, storage, rngGen)

	m, _, _, err := newManager(user, params)
	require.NoError(t, err)

	// startSendingWorkerPool normally installs this; sendCmix type-asserts it
	// unconditionally and the zero value is nil.
	m.params.Cmix.ExcludedRounds =
		sentRoundTracker.NewManager(clearSentRoundsAge)

	// The broadcast quit channel is normally created by startProcesses.
	// Closing it on cleanup releases any backoff goroutine still sleeping.
	quit := make(chan struct{})
	m.quit = quit
	t.Cleanup(func() { close(quit) })

	return m, cMix
}

// newBackoffTestTransfer starts a transfer and returns it with its parts,
// draining what send() queued so the test is the only thing feeding sendCmix.
func newBackoffTestTransfer(t *testing.T, m *manager, size int,
	retry float32) (*store.SentTransfer, []*store.Part) {
	t.Helper()

	prng := rand.New(rand.NewSource(1978))
	fileData := make([]byte, size)
	prng.Read(fileData)

	st, err := m.send(ftCrypto.NewID(fileData), fileData, retry,
		func(FileLink) {}, nil)
	require.NoError(t, err)

	parts := st.GetUnsentParts()
	for range parts {
		<-m.batchQueue
	}

	return st, parts
}

// Tests that the per-file failure counter escalates, is independent per file,
// and resets.
func Test_manager_sendBackoffCounter(t *testing.T) {
	params := DefaultParams()
	params.MaxThroughput = 0
	m, _ := newBackoffTestManager(t, params)

	fidA := ftCrypto.NewID([]byte("file A"))
	fidB := ftCrypto.NewID([]byte("file B"))

	// jitterBackoff only ever subtracts, and by at most
	// 1/sendRetryJitterDenom, so each wait must land in ((1-1/d)*want, want].
	requireInJitterBand := func(t *testing.T, want, got time.Duration) {
		t.Helper()
		require.Greaterf(t, got, want-want/sendRetryJitterDenom,
			"wait %s is below the jitter band for %s", got, want)
		require.LessOrEqualf(t, got, want,
			"jitter must never extend a wait: %s > %s", got, want)
	}

	requireInJitterBand(t, params.SendRetryWait, m.nextSendBackoff(fidA))
	requireInJitterBand(t, 2*params.SendRetryWait, m.nextSendBackoff(fidA))
	requireInJitterBand(t, 4*params.SendRetryWait, m.nextSendBackoff(fidA))

	// A second file has its own counter and starts over at the base.
	requireInJitterBand(t, params.SendRetryWait, m.nextSendBackoff(fidB))

	// A landed round resets the file to the base tier.
	m.clearSendBackoff(fidA)
	requireInJitterBand(t, params.SendRetryWait, m.nextSendBackoff(fidA))
}

// Tests that once a transfer is out of fingerprints its packets are dropped
// rather than sent as an empty SendMany — which gateways reject as a malformed
// message object and which can trip a FATAL panic inside cmix.SendManyCMIX —
// and that closeSend drops the transfer's backoff counter.
//
// Driven with SendMany already failing so the whole sequence is synchronous:
// the send-error path returns before GetRoundResults, so no callback goroutine
// can race the assertions.
func Test_manager_sendCmix_SkipsAnEmptyBatch(t *testing.T) {
	params := DefaultParams()
	params.MaxThroughput = 0
	// Long enough that the re-queue goroutines never fire during the test.
	params.SendRetryWait = time.Hour
	params.MaxSendRetryWait = time.Hour
	m, cMix := newBackoffTestManager(t, params)

	// retry 0 means numFps == numParts: exactly one attempt per part.
	st, parts := newBackoffTestTransfer(t, m, 2_000, 0)
	require.NotEmpty(t, parts)
	cMix.setSendManyErr(errors.New("gateway is having a bad day"))

	// The first pass spends the entire budget.
	m.sendCmix(parts)
	require.Equal(t, 1, len(cMix.sendManyHistory()))
	require.Equal(t, store.Running, st.Status())

	// The second pass finds no fingerprints left, so every part is dropped and
	// the transfer is marked failed. Nothing may reach the network.
	m.sendCmix(parts)
	require.Equal(t, 1, len(cMix.sendManyHistory()),
		"a packet with no sendable parts must not call SendMany")
	require.Zero(t, cMix.roundResultsCallCount(),
		"a skipped send must not poll for round results")
	require.Equal(t, store.Failed, st.Status())

	// A third pass is now short-circuited by the dead-transfer skip, before
	// any part can even attempt to pop a fingerprint.
	m.sendCmix(parts)
	require.Equal(t, 1, len(cMix.sendManyHistory()))

	// closeSend drops the counter rather than leaking one entry per transfer.
	m.nextSendBackoff(st.GetFileID())
	require.Contains(t, m.sendFailures, st.GetFileID())
	require.NoError(t, m.closeSend(st))
	require.NotContains(t, m.sendFailures, st.GetFileID())
}

// Tests that a failed send does not fall through to GetRoundResults, and that
// its parts return to the batch queue only after the backoff has elapsed.
//
// The fall-through is the load-bearing half: SendMany's error path returns the
// zero Round, so asking for its results starts a historical lookup for round 0
// that times out roundResultsTimeout later and re-queues the very same parts a
// second time, doubling the fingerprint burn for every failed batch.
func Test_manager_sendCmix_FailedSendBacksOffAndSkipsRoundResults(t *testing.T) {
	params := DefaultParams()
	params.MaxThroughput = 0
	params.SendRetryWait = 150 * time.Millisecond
	params.MaxSendRetryWait = 150 * time.Millisecond
	m, cMix := newBackoffTestManager(t, params)

	// retry 5 leaves plenty of budget, so the only thing keeping the parts off
	// the queue is the backoff.
	_, parts := newBackoffTestTransfer(t, m, 2_000, 5)
	cMix.setSendManyErr(errors.New("gateway is having a bad day"))

	m.sendCmix(parts)

	require.Equal(t, 1, len(cMix.sendManyHistory()))
	require.Zero(t, cMix.roundResultsCallCount(),
		"a failed send must return rather than poll round 0's results")

	// Well inside the backoff: nothing has come back yet.
	time.Sleep(40 * time.Millisecond)
	require.Zero(t, len(m.batchQueue),
		"parts must not be re-queued before the backoff elapses")

	// Comfortably past it: every part is back.
	require.Eventually(t, func() bool { return len(m.batchQueue) == len(parts) },
		2*time.Second, 10*time.Millisecond,
		"parts should return to the batch queue after the backoff")
}

// Tests that a failed ROUND takes the same backoff path as a failed send.
//
// The callback is driven directly rather than through sendCmix: a successful
// SendMany on the mock delivers the parts to the fingerprints the sender
// registered for its own transfer, which completes it — and a completed
// transfer's parts must not be re-queued, which would mask the edge under test.
func Test_manager_roundResultsCallback_FailedRoundBacksOff(t *testing.T) {
	params := DefaultParams()
	params.MaxThroughput = 0
	params.SendRetryWait = 150 * time.Millisecond
	params.MaxSendRetryWait = 150 * time.Millisecond
	m, _ := newBackoffTestManager(t, params)

	st, parts := newBackoffTestTransfer(t, m, 2_000, 5)
	require.Equal(t, store.Running, st.Status())

	m.roundResultsCallback(parts)(
		false, false, map[id.Round]cmix.RoundResult{0: {Status: cmix.Failed}})

	time.Sleep(40 * time.Millisecond)
	require.Zero(t, len(m.batchQueue),
		"a failed round must not re-queue before the backoff elapses")

	require.Eventually(t, func() bool { return len(m.batchQueue) == len(parts) },
		2*time.Second, 10*time.Millisecond,
		"parts should return to the batch queue after the backoff")
}

// Tests that a SUCCESSFUL round clears the file's consecutive-failure count, so
// a link that recovers starts the next failure over at the base wait rather
// than at the ceiling.
func Test_manager_roundResultsCallback_SuccessClearsTheBackoff(t *testing.T) {
	params := DefaultParams()
	params.MaxThroughput = 0
	m, _ := newBackoffTestManager(t, params)

	st, parts := newBackoffTestTransfer(t, m, 2_000, 5)

	m.nextSendBackoff(st.GetFileID())
	m.nextSendBackoff(st.GetFileID())
	require.Equal(t, uint(2), m.sendFailures[st.GetFileID()])

	m.roundResultsCallback(parts)(
		true, false, map[id.Round]cmix.RoundResult{0: {Status: cmix.Succeeded}})

	require.NotContains(t, m.sendFailures, st.GetFileID(),
		"a landed round should reset the file's failure count")
}

// Tests the whole point of the change, through the full send stack: on the same
// unreachable network the same fingerprint budget is spread over meaningfully
// more wall clock with a backoff configured than without one.
//
// The zero-backoff arm is what makes this an assertion about the backoff rather
// than about incidental latency — it reproduces the original defect, where a
// transfer's entire budget drained in a burst and the transfer was then
// permanently dead.
func Test_FileTransfer_SendFailure_BacksOff(t *testing.T) {
	const (
		fileSize = 8_000
		retry    = float32(2.0)
	)

	run := func(t *testing.T, sendRetryWait time.Duration) (
		time.Duration, []int, uint16) {
		t.Helper()

		params := DefaultParams()
		params.MaxThroughput = 0
		params.ResendWait = time.Hour // keep the resend thread out of this
		params.SendRetryWait = sendRetryWait
		params.MaxSendRetryWait = sendRetryWait

		myID := id.NewIdFromString("smokeBackoffID", id.User, t)
		storage := newMockStorage()
		cMix := newMockCmix(myID, newMockCmixHandler(), storage)
		rngGen := fastRNG.NewStreamGenerator(1000, 10, csprng.NewSystemRNG)
		user := newMockE2e(myID, cMix, storage, rngGen)

		m, _, _, err := newManager(user, params)
		require.NoError(t, err)

		stop, err := m.startProcesses()
		require.NoError(t, err)
		t.Cleanup(func() { _ = stop.Close() })

		cMix.setSendManyErr(errors.New("gateway is having a bad day"))

		prng := rand.New(rand.NewSource(1978))
		fileData := make([]byte, fileSize)
		prng.Read(fileData)

		failed := make(chan error, 16)
		cb := SentProgressCallback(func(_ bool, _, _, _ uint16,
			_ SentTransfer, _ FilePartTracker, err error) {
			if err != nil {
				select {
				case failed <- err:
				default:
				}
			}
		})

		start := time.Now()
		st, err := m.send(ftCrypto.NewID(fileData), fileData, retry,
			func(FileLink) {}, []sentProgressCBs{{cb, 0}})
		require.NoError(t, err)
		numParts := st.GetNumParts()

		select {
		case err := <-failed:
			require.Error(t, err)
		case <-time.After(30 * time.Second):
			t.Fatal("the transfer never reported running out of retries")
		}

		return time.Since(start), cMix.sendManyHistory(), numParts
	}

	// The fingerprint budget is shared across the whole transfer, so the total
	// number of parts ever handed to SendMany can never exceed it.
	requireWithinBudget := func(
		t *testing.T, calls []int, numParts uint16) {
		t.Helper()

		budget := int(calcNumberOfFingerprints(int(numParts), retry))
		total := 0
		for _, numMsgs := range calls {
			require.NotZero(t, numMsgs,
				"SendMany must never be called with an empty message list")
			total += numMsgs
		}
		require.LessOrEqualf(t, total, budget,
			"sent %d parts against a budget of %d", total, budget)
	}

	var withBackoff, withoutBackoff time.Duration

	t.Run("with a backoff the budget is spread over wall clock",
		func(t *testing.T) {
			// Slynk: was 120ms. With 9-11 part packets this 9-part file
			// mostly waits out the 100ms unfilled-packet timer on every
			// attempt, which a short backoff can't clear by the 2x below.
			elapsed, calls, numParts := run(t, 600*time.Millisecond) // Slynk:
			withBackoff = elapsed
			requireWithinBudget(t, calls, numParts)
			require.GreaterOrEqual(t, len(calls), 2,
				"the transfer should have made several attempts")
			require.GreaterOrEqual(t, elapsed, 200*time.Millisecond,
				"a configured backoff should hold the transfer open")
		})

	t.Run("without a backoff the budget drains in a burst",
		func(t *testing.T) {
			elapsed, calls, numParts := run(t, 0)
			withoutBackoff = elapsed
			requireWithinBudget(t, calls, numParts)
		})

	// A bare "greater than" is too weak to be evidence: the batch builder's own
	// unfilled-packet timeout already puts ~100ms between packets, so a
	// backoff-free run is not instant and can drift above a backoff-free run by
	// chance. Requiring a multiple is what makes this an assertion about the
	// backoff rather than about scheduling noise.
	require.Greaterf(t, withBackoff, 2*withoutBackoff,
		"the backoff, not incidental latency, is what spreads the attempts "+
			"(with: %s, without: %s)", withBackoff, withoutBackoff)
}
