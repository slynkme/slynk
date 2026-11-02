package transfer

import (
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gitlab.com/elixxir/client/v4/cmix"
)

func TestCoverRateBounds(t *testing.T) {
	for _, r := range []coverRate{coverActive, coverQuiet} {
		seen := map[int]bool{}
		for range 2000 {
			burst, gap := r.next()
			if burst < r.burstMin || burst > r.burstMax {
				t.Fatalf("burst %d outside %d-%d", burst, r.burstMin, r.burstMax)
			}
			if gap < r.gapMin || gap > r.gapMax {
				t.Fatalf("gap %s outside %s-%s", gap, r.gapMin, r.gapMax)
			}
			seen[burst] = true
		}
		if len(seen) != r.burstMax-r.burstMin+1 {
			t.Errorf("only saw bursts %v", seen)
		}
	}
}

// The loop starts with a burst, uses the active rate while the tab is busy and
// the quiet rate once it has been idle, and stops promptly.
func TestRunCover(t *testing.T) {
	stop := make(chan struct{})
	var sent atomic.Int32
	var gaps []time.Duration
	idle := time.Duration(0)
	waits := 0
	wait := func(d time.Duration, _, _ <-chan struct{}) bool {
		gaps = append(gaps, d)
		waits++
		if waits == 3 {
			idle = coverQuietAfter // from now on the tab is idle
		}
		return waits < 6
	}
	runCover(stop, nil, nil, func(*noticeJob) (bool, error) {
		sent.Add(1)
		if sent.Load() == 2 {
			return false, errors.New("no network") // a failed send doesn't end the loop
		}
		return false, nil
	}, func() time.Duration { return idle }, wait)

	if sent.Load() < 6 {
		t.Fatalf("sent %d, want at least one per burst", sent.Load())
	}
	for i, g := range gaps {
		r := coverActive
		if i >= 3 {
			r = coverQuiet
		}
		if g < r.gapMin || g > r.gapMax {
			t.Errorf("gap %d is %s, outside %s-%s", i, g, r.gapMin, r.gapMax)
		}
	}

	// A closed stop ends the loop before it sends anything.
	close(stop)
	before := sent.Load()
	runCover(stop, nil, nil, func(*noticeJob) (bool, error) { sent.Add(1); return false, nil },
		func() time.Duration { return 0 }, func(time.Duration, <-chan struct{}, <-chan struct{}) bool { return true })
	if sent.Load() != before {
		t.Error("sent after stop")
	}
}

// A waiting notice takes a blank message's place, never in the first burst
// after connecting, and notices still waiting when cover stops are handed
// back to be sent another way.
func TestRunCoverNotices(t *testing.T) {
	stop := make(chan struct{})
	jobs := make(chan *noticeJob, 4)
	job := &noticeJob{done: make(chan noticeResult, 1)}
	jobs <- job
	var sends []bool // whether each send carried a notice
	bursts := 0
	wait := func(time.Duration, <-chan struct{}, <-chan struct{}) bool {
		bursts++
		if bursts == 1 && len(sends) > 0 && sends[0] {
			t.Error("a notice went in the first burst")
		}
		if bursts == 2 {
			// The leftover goes back when cover stops.
			jobs <- &noticeJob{done: make(chan noticeResult, 1)}
			close(stop)
		}
		return bursts < 2
	}
	runCover(stop, jobs, nil, func(j *noticeJob) (bool, error) {
		sends = append(sends, j != nil)
		if j != nil {
			j.done <- noticeResult{}
		}
		return false, nil
	}, func() time.Duration { return 0 }, wait)

	notices := 0
	for i, n := range sends {
		if n {
			notices++
			if i == 0 {
				t.Error("the notice was the first message")
			}
		}
	}
	if notices != 1 {
		t.Fatalf("sent %d notices, want 1 (%v)", notices, sends)
	}
	if r := <-job.done; r.again {
		t.Error("a sent notice was handed back")
	}
	select {
	case left := <-jobs:
		t.Fatalf("a notice was left in the queue: %+v", left)
	default:
	}
}

// A notice sent apart takes a blank message's place for each of its
// messages, in turn: the next places, in the same burst or the next, with
// no other notice between. If cover stops part way, it's handed back, to
// carry on from where it got to.
func TestRunCoverApart(t *testing.T) {
	defer func(r coverRate) { coverActive = r }(coverActive)
	for _, c := range []struct {
		burst  int
		stopAt int // bursts before cover stops
		want   []string
	}{
		{1, 5, []string{"blank", "a1", "a2", "b1", "b2"}},
		{2, 3, []string{"blank", "blank", "a1", "a2", "b1", "b2"}},
		{3, 2, []string{"blank", "blank", "blank", "a1", "a2", "b1"}},
	} {
		coverActive = coverRate{c.burst, c.burst, time.Millisecond, time.Millisecond}
		stop := make(chan struct{})
		jobs := make(chan *noticeJob, 4)
		a := &noticeJob{apart: &apartSend{}, done: make(chan noticeResult, 1)}
		b := &noticeJob{apart: &apartSend{}, done: make(chan noticeResult, 1)}
		jobs <- a
		jobs <- b
		names := map[*noticeJob]string{a: "a", b: "b"}
		parts := map[*noticeJob]int{}
		var sends []string
		bursts := 0
		wait := func(time.Duration, <-chan struct{}, <-chan struct{}) bool {
			bursts++
			return bursts < c.stopAt
		}
		runCover(stop, jobs, nil, func(j *noticeJob) (bool, error) {
			if j == nil {
				sends = append(sends, "blank")
				return false, nil
			}
			parts[j]++
			sends = append(sends, fmt.Sprint(names[j], parts[j]))
			if parts[j] == 1 {
				j.apart.streams = [][]byte{{1}, {2}} // its first has gone
				return true, nil
			}
			j.done <- noticeResult{status: cmix.Succeeded}
			return false, nil
		}, func() time.Duration { return 0 }, wait)
		if got := sends[:min(len(sends), len(c.want))]; !slices.Equal(got, c.want) {
			t.Fatalf("bursts of %d: sent %v, want %v", c.burst, sends, c.want)
		}
		for _, j := range []*noticeJob{a, b} {
			select {
			case r := <-j.done:
				if r.again != (parts[j] < 2) {
					t.Fatalf("bursts of %d: %s, %d of 2 sent, handed back %v", c.burst, names[j], parts[j], r.again)
				}
				if r.again && parts[j] == 1 && !j.between() {
					t.Fatal("handed back without what had gone")
				}
			default:
				t.Fatalf("bursts of %d: %s was neither finished nor handed back", c.burst, names[j])
			}
		}
	}
}

// A notice arriving during a long quiet gap cuts it to at most an active one.
func TestSleepOrStopNudge(t *testing.T) {
	for range 200 {
		if g := nudgeGap(); g < coverActive.gapMin || g > coverActive.gapMax {
			t.Fatalf("a nudged gap of %s isn't an active one", g)
		}
	}
	defer func(g func() time.Duration) { nudgeGap = g }(nudgeGap)
	nudgeGap = func() time.Duration { return 50 * time.Millisecond }
	nudge := make(chan struct{}, 1)
	nudge <- struct{}{}
	start := time.Now()
	stop := make(chan struct{})
	timer := time.AfterFunc(5*time.Second, func() { close(stop) })
	defer timer.Stop()
	if !sleepOrStop(time.Hour, stop, nudge) {
		t.Fatal("a nudged gap ran into the hour")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("the nudged gap lasted %s", d)
	}
	// A nudge never lengthens a gap that was already shorter.
	nudgeGap = func() time.Duration { return time.Hour }
	nudge <- struct{}{}
	start = time.Now()
	if !sleepOrStop(100*time.Millisecond, stop, nudge) || time.Since(start) > time.Second {
		t.Fatal("a nudge lengthened a short gap")
	}
}

// Turning cover on twice runs one loop; off stops it; it counts what it sent,
// not the notices it carried; offers fail while it's off.
func TestCovererSet(t *testing.T) {
	var cv coverer
	var mu sync.Mutex
	loops := 0
	cv.wait = func(_ time.Duration, stop <-chan struct{}, _ <-chan struct{}) bool {
		<-stop // park after the first burst until switched off
		return false
	}
	send := func(*noticeJob) (bool, error) {
		mu.Lock()
		loops++
		mu.Unlock()
		return false, nil
	}
	idle := func() time.Duration { return 0 }

	if cv.offer(&noticeJob{done: make(chan noticeResult, 1)}) {
		t.Fatal("an offer was taken while cover was off")
	}
	cv.set(true, send, idle)
	cv.set(true, send, idle)
	deadline := time.Now().Add(2 * time.Second)
	for cv.sent.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond) // let a second loop, if any, send too
	mu.Lock()
	first := loops
	mu.Unlock()
	if first < coverActive.burstMin || first > coverActive.burstMax {
		t.Fatalf("one burst sent %d messages: two loops?", first)
	}
	if int(cv.sent.Load()) != first {
		t.Fatalf("counted %d, sent %d", cv.sent.Load(), first)
	}
	job := &noticeJob{done: make(chan noticeResult, 1)}
	if !cv.offer(job) {
		t.Fatal("the running loop refused a notice")
	}
	cv.set(false, send, idle)
	cv.set(false, send, idle) // already off: no double close
	if cv.stop != nil {
		t.Fatal("still on")
	}
	select {
	case r := <-job.done:
		if !r.again {
			t.Fatal("a notice left when cover stopped wasn't handed back")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a notice left when cover stopped was lost")
	}
}
