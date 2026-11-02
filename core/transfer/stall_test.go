package transfer

import (
	"testing"
	"time"

	ft "gitlab.com/elixxir/client/v4/channelsFileTransfer"
	ftCrypto "gitlab.com/elixxir/crypto/fileTransfer"
)

var t0 = time.Date(2026, 10, 14, 20, 0, 0, 0, time.UTC)

func TestStallWatchBeforeTheFirstPart(t *testing.T) {
	w := newStallWatch(t0, t0, 5)
	if _, _, stalled := w.check(t0.Add(firstPartAfter - time.Second)); stalled {
		t.Fatal("stalled too soon")
	}
	got, total, stalled := w.check(t0.Add(firstPartAfter))
	if !stalled || got != 0 || total != 5 {
		t.Fatalf("got %d of %d, stalled %v", got, total, stalled)
	}
	// Mentioned again only after another full period.
	if _, _, stalled = w.check(t0.Add(firstPartAfter + time.Minute)); stalled {
		t.Fatal("reported twice in one period")
	}
	if _, _, stalled = w.check(t0.Add(2 * firstPartAfter)); !stalled {
		t.Fatal("not reported again")
	}
}

// Older links look further back before the first part, so they get longer.
func TestStallWatchOlderLinks(t *testing.T) {
	sent := t0.Add(-20 * 24 * time.Hour)
	w := newStallWatch(t0, sent, 5)
	limit := firstPartAfter + 20*firstPartPerDay
	if _, _, stalled := w.check(t0.Add(limit - time.Second)); stalled {
		t.Fatal("stalled too soon for a 20-day-old link")
	}
	if _, _, stalled := w.check(t0.Add(limit)); !stalled {
		t.Fatal("not stalled")
	}
	// A sent time in the future (a fast clock) gets no extra time.
	if w := newStallWatch(t0, t0.Add(time.Hour), 5); w.firstPart != firstPartAfter {
		t.Fatalf("future sent time gave %s", w.firstPart)
	}
}

func TestStallWatchAfterParts(t *testing.T) {
	w := newStallWatch(t0, t0, 217)
	at := t0.Add(10 * time.Second)
	w.seen(196, 217, at)
	if _, _, stalled := w.check(at.Add(stallAfter - time.Second)); stalled {
		t.Fatal("stalled too soon")
	}
	// The same count again isn't progress.
	w.seen(196, 217, at.Add(time.Minute))
	got, total, stalled := w.check(at.Add(stallAfter))
	if !stalled || got != 196 || total != 217 {
		t.Fatalf("got %d of %d, stalled %v", got, total, stalled)
	}
	// A new part restarts the clock.
	more := at.Add(stallAfter + time.Minute)
	w.seen(205, 217, more)
	if _, _, stalled = w.check(more.Add(stallAfter - time.Second)); stalled {
		t.Fatal("stalled despite a new part")
	}
	if got, _, stalled = w.check(more.Add(stallAfter)); !stalled || got != 205 {
		t.Fatalf("got %d, stalled %v", got, stalled)
	}
}

func TestWaitStops(t *testing.T) {
	m := newMemModel()
	fid := ftCrypto.NewID([]byte("a file"))
	stop := make(chan struct{})
	go func() {
		time.Sleep(50 * time.Millisecond)
		close(stop)
	}()
	if _, err := m.wait(fid, time.Minute, stop); err != errStopped {
		t.Fatalf("got %v, want errStopped", err)
	}

	// A nil stop never stops; completion still wins.
	go func() {
		time.Sleep(50 * time.Millisecond)
		_ = m.ReceiveFile(fid, nil, []byte("data"), t0, ft.Complete)
	}()
	f, err := m.wait(fid, time.Minute, nil)
	if err != nil || string(f.Data) != "data" {
		t.Fatalf("got %q, %v", f.Data, err)
	}
}

func TestStopDownloadWithoutADownload(t *testing.T) {
	var c Client
	c.StopDownload() // nothing running: no panic, nothing to close
	stop := make(chan struct{})
	c.stop = stop
	c.StopDownload()
	select {
	case <-stop:
	default:
		t.Fatal("StopDownload didn't close the running download's channel")
	}
	c.StopDownload() // already stopped: no double close
}
