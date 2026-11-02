package transfer

import (
	"errors"
	"testing"
	"time"
)

// A join whose stop has already closed gives up at once, before it reaches
// the network or makes an identity (offline).
func TestConnectStoppableStopped(t *testing.T) {
	stop := make(chan struct{})
	close(stop)
	var stages []string
	c, err := ConnectStoppable(func(stage string, _, _ int) { stages = append(stages, stage) }, stop)
	if c != nil || !errors.Is(err, ErrConnectStopped) {
		t.Fatalf("got %v, %v; want nil, ErrConnectStopped", c, err)
	}
	if len(stages) != 0 {
		t.Fatalf("reported %v before stopping", stages)
	}
}

// fakeJoin is a join on a clock of its own: registered(t) says how many nodes
// it has registered with t into it, and it's ready at readyAt (never if zero).
type fakeJoin struct {
	t          time.Duration
	registered func(time.Duration) int
	readyAt    time.Duration
}

func (f *fakeJoin) wait() joinWait {
	base := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	return joinWait{
		status: func() (int, int, bool) {
			return f.registered(f.t), 180, f.readyAt > 0 && f.t >= f.readyAt
		},
		now:   func() time.Time { return base.Add(f.t) },
		sleep: func(d time.Duration) { f.t += d },
	}
}

func (f *fakeJoin) run(stop <-chan struct{}) error {
	w := f.wait()
	return w.run(func(string, int, int) {}, stop, w.now().Add(connectTimeout))
}

// A slow join that keeps registering with new nodes is left to carry on,
// however long it takes, up to joinAttempt.
func TestJoinWaitSlowButMoving(t *testing.T) {
	f := &fakeJoin{registered: func(t time.Duration) int { return int(t / (10 * time.Second)) }, readyAt: 80 * time.Second}
	if err := f.run(nil); err != nil {
		t.Fatalf("got %v; want ready", err)
	}
}

// One that registers with no new node for joinStall has stalled (as
// one seen at 19% did).
func TestJoinWaitStalled(t *testing.T) {
	f := &fakeJoin{registered: func(t time.Duration) int {
		if t > 8*time.Second {
			return 29
		}
		return int(t / (250 * time.Millisecond))
	}}
	if err := f.run(nil); !errors.Is(err, errJoinStalled) {
		t.Fatalf("got %v; want errJoinStalled", err)
	}
	if f.t < 8*time.Second+joinStall || f.t > 8*time.Second+joinStall+time.Second {
		t.Fatalf("gave up at %v; want just after %v", f.t, 8*time.Second+joinStall)
	}
}

// One still creeping along joinAttempt after it began starts again too
// (registered with enough nodes, say, but the network never healthy).
func TestJoinWaitTooLong(t *testing.T) {
	f := &fakeJoin{registered: func(t time.Duration) int { return int(t / (20 * time.Second)) }}
	if err := f.run(nil); !errors.Is(err, errJoinStalled) {
		t.Fatalf("got %v; want errJoinStalled", err)
	}
	if f.t < joinAttempt || f.t > joinAttempt+time.Second {
		t.Fatalf("gave up at %v; want just after %v", f.t, joinAttempt)
	}
}

// Stopped from the page, it stops at once, stalled or not.
func TestJoinWaitStopped(t *testing.T) {
	stop := make(chan struct{})
	close(stop)
	f := &fakeJoin{registered: func(time.Duration) int { return 0 }}
	if err := f.run(stop); !errors.Is(err, ErrConnectStopped) {
		t.Fatalf("got %v; want ErrConnectStopped", err)
	}
}

// Past the whole join's deadline it gives up for good, not for a fresh start.
func TestJoinWaitDeadline(t *testing.T) {
	f := &fakeJoin{registered: func(t time.Duration) int { return int(t / time.Second) }}
	w := f.wait()
	err := w.run(func(string, int, int) {}, nil, w.now().Add(10*time.Second))
	if err == nil || errors.Is(err, errJoinStalled) {
		t.Fatalf("got %v; want the deadline's error", err)
	}
}

// Stalled joins start again with a fresh identity, saying so, up to
// joinRestarts times; then it gives up with ErrConnectStalled.
func TestRetryJoin(t *testing.T) {
	var calls int
	var restarts [][2]int
	progress := func(stage string, done, total int) {
		if stage == "restart" {
			restarts = append(restarts, [2]int{done, total})
		}
	}
	stalls := func(Progress, <-chan struct{}, time.Time) (*Client, error) {
		calls++
		return nil, errJoinStalled
	}
	c, err := retryJoin(progress, nil, time.Now().Add(time.Hour), stalls)
	if c != nil || !errors.Is(err, ErrConnectStalled) {
		t.Fatalf("got %v, %v; want nil, ErrConnectStalled", c, err)
	}
	if calls != joinRestarts+1 || len(restarts) != joinRestarts || restarts[0] != [2]int{1, joinRestarts} || restarts[joinRestarts-1] != [2]int{joinRestarts, joinRestarts} {
		t.Fatalf("%d tries, restarts %v", calls, restarts)
	}

	// The second try joins: that's the client.
	calls = 0
	want := &Client{}
	joins := func(Progress, <-chan struct{}, time.Time) (*Client, error) {
		calls++
		if calls == 1 {
			return nil, errJoinStalled
		}
		return want, nil
	}
	if c, err = retryJoin(progress, nil, time.Now().Add(time.Hour), joins); c != want || err != nil || calls != 2 {
		t.Fatalf("got %v, %v after %d tries", c, err, calls)
	}

	// Any other failure isn't a stall: it's reported as it is, at once.
	other := errors.New("download network definition: no route")
	calls = 0
	fails := func(Progress, <-chan struct{}, time.Time) (*Client, error) {
		calls++
		return nil, other
	}
	if _, err = retryJoin(progress, nil, time.Now().Add(time.Hour), fails); err != other || calls != 1 {
		t.Fatalf("got %v after %d tries", err, calls)
	}
}
