package transfer

import (
	"sync"
	"time"
)

// A download can stall: uploads confirm each part by its round's result, so a
// part lost after its round succeeded is never sent again, and the recipient
// would wait out transferTimeout without a word. stallWatch notices when no
// new part has arrived for a while, so Download can say so.
const (
	// stallAfter is how long a download may go without a new part once parts
	// have started arriving. xxDK retries a round it couldn't fetch after
	// about 100 s, so this leaves room for one retry.
	stallAfter = 3 * time.Minute

	// Before the first part, the download is still looking back through the
	// network's history to when the link was sent, which takes longer for
	// older links. Tune these once the retention retest has timed it.
	firstPartAfter  = 2 * time.Minute
	firstPartPerDay = 15 * time.Second

	stallCheckEvery = 5 * time.Second
)

// stallWatch tracks a download's progress and reports when it has gone quiet.
type stallWatch struct {
	mu        sync.Mutex
	got       int
	total     int
	last      time.Time // the last new part, the start, or the last report
	firstPart time.Duration
}

func newStallWatch(now, sent time.Time, total int) *stallWatch {
	days := max(0, int(now.Sub(sent)/(24*time.Hour)))
	return &stallWatch{
		total:     total,
		last:      now,
		firstPart: firstPartAfter + time.Duration(days)*firstPartPerDay,
	}
}

// seen records a progress report: got of total parts so far.
func (w *stallWatch) seen(got, total int, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if total > 0 {
		w.total = total
	}
	if got > w.got {
		w.got, w.last = got, now
	}
}

// check reports a stall when the download has been quiet for too long. After
// a report it waits another full period, so a stall is mentioned again rather
// than every few seconds.
func (w *stallWatch) check(now time.Time) (got, total int, stalled bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	limit := stallAfter
	if w.got == 0 {
		limit = w.firstPart
	}
	if now.Sub(w.last) < limit {
		return 0, 0, false
	}
	w.last = now
	return w.got, w.total, true
}
