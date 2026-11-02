package keyserver

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"
)

// The hourly line's warnings: new links in an hour at jump times
// the usual rate (an average over about usualHours) and more than jumpFloor,
// any refused, or the store fillWarn percent full. A warning about an hour
// stays in the line for warnDays, so a weekly look still catches it.
const (
	jump = 4
	// Also the line's floor for counts of new links: below it, it says "under
	// 60", as while few people use Slynk an exact count for an hour could help
	// match visits to who sent a link. The same for links kept, below fewKept.
	jumpFloor  = 60
	fewKept    = 1000
	usualHours = 24
	fillWarn   = 80
	warnDays   = 7
)

// stats are the hourly line's counts since the last line (at rep, to the
// hour): new links, and refused as too many at once (slow) and as full; the
// usual new links an hour; and the worst hour of the last warnDays (the hour
// to wat): wn new links, wr refused, wu the usual then. Counts, nothing about
// any one link.
type stats struct {
	rep, puts, slow, full int64
	usual                 float64
	wat, wn, wr, wu       int64
}

// Report runs the clean-up and returns the hourly line, taking the counts
// since the last one into the usual rate and the worst hour. The usual rate
// follows the hours' counts, but by no more than jump times itself at a
// time, so a flood becomes usual only slowly.
func (st *Store) Report(now int64) string {
	kept := st.Sweep(now)
	st.mu.Lock()
	defer st.mu.Unlock()
	s := &st.stats
	hour := now / 3600 * 3600
	hours := int64(1)
	if s.rep > 0 {
		hours = max(1, (hour-s.rep)/3600)
	}
	rate := int64(math.Round(float64(s.puts) / float64(hours)))
	refused := s.slow + s.full
	usual := float64(rate)
	if s.rep > 0 {
		usual = s.usual
	}
	busy := refused > 0 || (rate > jumpFloor && float64(rate) >= jump*usual)
	stale := now-s.wat >= warnDays*86400
	if busy && (stale || rate >= s.wn) {
		s.wat, s.wn, s.wr, s.wu = hour, rate, refused, int64(math.Round(usual))
	} else if stale {
		s.wat, s.wn, s.wr, s.wu = 0, 0, 0, 0
	}

	few := func(x float64) string {
		if x < jumpFloor {
			return "under " + num(jumpFloor)
		}
		return num(int64(math.Round(x)))
	}
	var warn []string
	if s.wat > 0 {
		w := "busy in the hour to " + utc(s.wat) + ": " + few(float64(s.wn)) + " new links"
		if s.wu > 0 {
			w += " (usual " + few(float64(s.wu)) + ")"
		}
		if s.wr > 0 {
			w += ", " + num(s.wr) + " refused"
		}
		warn = append(warn, w)
	}
	if 100*kept >= fillWarn*st.max {
		warn = append(warn, "nearly full: "+pc(int64(kept), int64(st.max))+" of the room is used")
	}
	var b strings.Builder
	b.WriteString("keyserver: ")
	if len(warn) > 0 {
		b.WriteString("WARNING: " + strings.Join(warn, "; ") + ". ")
	}
	b.WriteString("Done at " + utc(now) + ": ")
	if kept < fewKept {
		b.WriteString("under " + num(fewKept) + " links kept; ")
	} else {
		b.WriteString(num(int64(kept)) + " links kept, " + pc(int64(kept), int64(st.max)) + " of the room; ")
	}
	b.WriteString(few(float64(rate)) + " new ")
	if hours > 1 {
		b.WriteString("an hour over the last " + num(hours) + " hours")
	} else {
		b.WriteString("in the last hour")
	}
	b.WriteString(" (usual " + few(usual) + ")")
	if refused > 0 {
		b.WriteString(", " + num(refused) + " refused")
	}
	b.WriteString(".\n")

	s.usual = math.Round((usual+(min(float64(rate), max(jump*usual, jumpFloor))-usual)/usualHours)*1000) / 1000
	s.rep, s.puts, s.slow, s.full = hour, 0, 0, 0
	return b.String()
}

func utc(t int64) string { return time.Unix(t, 0).UTC().Format("2006-01-02 15:04") + " UTC" }

// num formats a count with thousands separators.
func num(n int64) string {
	if n < 0 {
		return "-" + num(-n)
	}
	s := strconv.FormatInt(n, 10)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// pc is x as a percentage of of, to one decimal place (two below 0.1%), without trailing zeros.
func pc(x, of int64) string {
	d := 1
	if 1000*x < of {
		d = 2
	}
	s := strconv.FormatFloat(100*float64(x)/float64(of), 'f', d, 64)
	s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	return fmt.Sprint(s, "%")
}
