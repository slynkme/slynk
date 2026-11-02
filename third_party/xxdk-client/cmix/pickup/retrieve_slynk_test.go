////////////////////////////////////////////////////////////////////////////////
// Slynk: tests for quickRetry (retrieve.go), added to the fork.               //
////////////////////////////////////////////////////////////////////////////////

package pickup

import (
	"sync"
	"testing"
	"time"

	"github.com/pkg/errors"
	"gitlab.com/elixxir/client/v4/cmix/gateway"
	ephemeral2 "gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/message"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/client/v4/stoppable"
	pb "gitlab.com/elixxir/comms/mixmessages"
	"gitlab.com/elixxir/comms/network"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/xx_network/comms/connect"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
	"gitlab.com/xx_network/primitives/ndf"
)

// flakyComms fails every message request until failUntil, then answers like
// mockMessageRetrievalComms. It counts the requests.
type flakyComms struct {
	*mockMessageRetrievalComms
	mu        sync.Mutex
	calls     int
	failUntil time.Time
}

func (f *flakyComms) RequestMessages(host *connect.Host,
	req *pb.GetMessages) (*pb.GetMessagesResponse, error) {
	f.mu.Lock()
	f.calls++
	fail := time.Now().Before(f.failUntil)
	f.mu.Unlock()
	if fail {
		return nil, errors.New("Connection error")
	}
	return f.mockMessageRetrievalComms.RequestMessages(host, req)
}

func (f *flakyComms) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// startFlaky starts one retrieval worker against a single gateway named
// gwName, with quickRetryDelay shortened, and sends it one round to look up.
func startFlaky(t *testing.T, gwName string, failFor time.Duration) (
	*flakyComms, chan message.Bundle, *stoppable.Single) {
	old := quickRetryDelay
	quickRetryDelay = 50 * time.Millisecond
	t.Cleanup(func() { quickRetryDelay = old })

	testManager := newManager(t)
	mock := &mockMessageRetrievalComms{testingSignature: t}
	comms := &flakyComms{mockMessageRetrievalComms: mock,
		failUntil: time.Now().Add(failFor)}
	testNdf := getNDF()
	gwId := id.NewIdFromString(gwName, id.Gateway, t)
	testNdf.Gateways = []ndf.Gateway{{ID: gwId.Marshal()}}
	testManager.rng = fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG)

	p := gateway.DefaultPoolParams()
	p.MaxPoolSize = 1
	var err error
	testManager.sender, err = gateway.NewTestingSender(p, testManager.rng,
		testNdf, mock, testManager.session,
		make(chan network.NodeGateway, 1), t)
	if err != nil {
		t.Fatal(err)
	}

	bundles := make(chan message.Bundle, 4)
	testManager.messageBundles = bundles
	stop := stoppable.NewSingle("singleStoppable")
	go testManager.processMessageRetrieval(comms, stop)

	testManager.lookupRoundMessages <- roundLookup{
		Round: rounds.Round{
			ID:       5,
			Topology: connect.NewCircuit([]*id.ID{gwId}),
		},
		Identity: ephemeral2.EphemeralIdentity{
			EphId:  ephemeral.Id{1, 2, 3, 4, 5, 6, 7, 8},
			Source: gwId,
		},
	}
	return comms, bundles, stop
}

// A round whose first pickup fails arrives on the quick retry, long before
// the unchecked-round sweep would try it again.
func Test_manager_processMessageRetrieval_QuickRetry(t *testing.T) {
	_, bundles, stop := startFlaky(t, ReturningGateway, 20*time.Millisecond)
	defer func() { _ = stop.Close() }()

	select {
	case b := <-bundles:
		if len(b.Messages) != 1 {
			t.Errorf("Expected 1 message in the bundle, got %d", len(b.Messages))
		}
	case <-time.After(2 * time.Second):
		t.Fatal("The failed round wasn't retried")
	}
}

// A round that keeps failing gets exactly one quick retry.
func Test_manager_processMessageRetrieval_QuickRetryOnce(t *testing.T) {
	comms, bundles, stop := startFlaky(t, ReturningGateway, time.Hour)
	defer func() { _ = stop.Close() }()

	time.Sleep(25 * time.Millisecond)
	first := comms.count()
	if first == 0 {
		t.Fatal("The round was never looked up")
	}
	time.Sleep(300 * time.Millisecond)
	if got := comms.count(); got != 2*first {
		t.Errorf("Expected %d requests (the first pickup and one quick "+
			"retry), got %d", 2*first, got)
	}
	select {
	case <-bundles:
		t.Error("Received a bundle from a gateway that always fails")
	default:
	}
}
