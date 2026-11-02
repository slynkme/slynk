package transfer

import (
	"crypto/rand"
	"time"

	"github.com/pkg/errors"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/primitives/excludedRounds"
	"gitlab.com/xx_network/primitives/id"
)

// A quantum-safe notice sent apart (2026-10-18, first as a
// setting senders could turn on; on slynk.me's page always, since
// 2026-10-19; docs/findings/quantum-safety.md): its two messages one at a
// time, each in a round of its own, rather than together in one round. Two
// messages in one round to one mailbox is a shape hardly anything else on
// the network makes (an xx DM's two go to two mailboxes, the partner's and
// the sender's own; only the smallest uploads, of two pieces, put two to one
// address), so it marks a quantum-safe notice to the round's gateways, and
// to anyone with the inbox's address, who can count what its mailbox
// receives. Apart, each is one message to the mailbox in its round, as a
// compact notice is, and goes to the gateway as a compact notice or a cover
// message does (PutMessage, not PutManyMessages): the second once the
// first's round has finished (the page sends a sender's messages one at a
// time, so no two of theirs go closer together), after a random pause. Sent
// on the beat of cover messages, each takes a blank message's place in turn
// instead.
//
// What it hides, and what it doesn't: the two go about 10 to 25 seconds
// apart (about 12 to 30 rounds), and anyone with the address can see which
// rounds delivered to the mailbox, so two single messages close together can
// still be noticed; it takes away the two-in-one-round shape, not every sign
// of a pair. The pause was first drawn wide (5 to 60 s, 2026-10-18), so the
// pair looked more like a message and a later follow-up; once it was always
// on, the wait was made shorter (2026-10-19: a minute was too long; the
// pieces at most about 30 s apart), keeping the second in a round
// of its own. At today's traffic it doesn't make a sender
// harder for a gateway operator to find either: two rounds can be matched to
// the mailbox's as one can, and give more to go on (to a gateway, the pair's
// crowd is the senders seen in both rounds, smaller than a single round's
// two-piece senders as the network grows). What grows with the network, and
// with cover messages, is the traffic that looks like it to anyone counting
// what reaches a mailbox.
//
// The first to go, either half at random, seals the notice for its own round
// as a notice sent whole is: every try afresh, so a try that went in another
// round after all is only an unpaired half. Once its round has succeeded,
// the second goes with the same bytes (a fresh seal wouldn't pair with the
// first, which has gone, and sealing a changed second under the first's key
// would reuse its nonce), in another round no more than apartRounds from the
// first's either way (withinApart: round numbers don't follow start times).
// It's tried again, with the same bytes, only when its round certainly
// failed: two that both arrived would be two identical messages, which
// anyone fetching the mailbox could see. (xxDK itself sends again in another
// round when a gateway errs, which can rarely deliver a message twice; the
// owner pairs whichever comes first.) The owner pairs halves in rounds that
// far apart, and only when the notice was sealed for the round that started
// first (pairing, inbox4.go). It's delivered once both have gone; if the
// first's round fails, or its outcome is unknown, the second never goes, and
// it wasn't delivered.
const (
	// apartPauseMin to apartPauseMax is the random pause before the second,
	// once the first's round has finished: with the first's wait for its
	// round's result (5 to 10 s on mainnet, 2026-10-18), the two go about 10
	// to 25 s apart.
	apartPauseMin = 2 * time.Second
	apartPauseMax = 15 * time.Second
	// apartRounds is the most rounds from the first's the second may go in,
	// either way: about eleven minutes at the network's pace (a round about
	// every 0.8 s), enough for every try at the second, each after a pause.
	// The owner pairs halves this far apart too, which takes in messages
	// sent with the minute-long pause of 2026-10-18.
	apartRounds = 800
	// apartTries is how many times the second is sent before giving up.
	apartTries = 3
)

// errApartLate refuses a round too far after the first's for the second.
var errApartLate = errors.New("too long after the first half")

// apartPause draws the pause before the second message. Tests replace it.
var apartPause = func() time.Duration {
	return apartPauseMin + time.Duration(randBelow(int64(apartPauseMax-apartPauseMin)+1))
}

// apartSend is how far a notice sent apart has got. Only whoever is sending
// it touches it: the cover loop, then, if cover stops part way, SendNoticeAt.
type apartSend struct {
	order   [2]int       // which stream goes first, and which second
	streams [][]byte     // the notice, sealed for first's round, once that has gone
	first   rounds.Round // the round the first went in
	tries   int          // tries at the second
}

func newApartSend() (*apartSend, error) {
	var b [1]byte
	if _, err := rand.Read(b[:]); err != nil {
		return nil, err
	}
	a := &apartSend{order: [2]int{0, 1}}
	if b[0]&1 == 1 {
		a.order = [2]int{1, 0}
	}
	return a, nil
}

// between reports whether a notice sent apart is between its two messages:
// the first has gone, and the second is still to.
func (j *noticeJob) between() bool { return j.apart != nil && j.apart.streams != nil }

// withinApart reports whether round, low 32 bits as the seal carries them,
// may carry the second message of a notice whose first went in first: not
// the first's, and no more than apartRounds from it either way. A round's
// number is given when it's made, and some take longer than others to get
// ready, so a round starting later can have a lower number (one send in six,
// seconds after another, went in a lower-numbered round in the lab's mainnet
// logs, 2026-10-13/14). What's later is what starts later, which the owner
// compares (pairing, inbox4.go).
func withinApart(first, round uint32) bool {
	d := int32(round - first)
	return d != 0 && d >= -apartRounds && d <= apartRounds
}

// apartExcluded is the rounds the second may not go in, as xxDK's
// ExcludedRounds: those outside withinApart, and those already tried. xxDK
// skips a round whose Insert reports false and tries the next soonest
// (comms' WaitingRounds), so a round out of reach is passed over, rather
// than refused by the assembler, which would end the send. (With none in
// reach, each try waits out xxDK's search for a round before failing.)
type apartExcluded struct {
	first uint32
	tried *excludedRounds.Set
}

func newApartExcluded(first id.Round) *apartExcluded {
	return &apartExcluded{first: uint32(first), tried: excludedRounds.NewSet()}
}

func (e *apartExcluded) Has(r id.Round) bool {
	return !withinApart(e.first, uint32(r)) || e.tried.Has(r)
}

func (e *apartExcluded) Insert(r id.Round) bool {
	return withinApart(e.first, uint32(r)) && e.tried.Insert(r)
}

func (e *apartExcluded) Remove(r id.Round) { e.tried.Remove(r) }
func (e *apartExcluded) Len() int          { return e.tried.Len() }

// sendNext makes a notice's next send: the whole notice in one round, or,
// sent apart, its next message. It reports whether the notice is finished
// with, and if so, how it went.
func sendNext(net streamSender, rngGen *fastRNG.StreamGenerator, job *noticeJob) (noticeResult, bool) {
	a := job.apart
	if a == nil {
		r, status, err := sendStreamsVia(net, rngGen, job.recipient, job.pieces, job.seal, nil)
		return noticeResult{round: r, status: status, err: err}, true
	}
	if a.streams == nil {
		var sealed [][]byte
		r, status, err := sendStreamsVia(net, rngGen, job.recipient, 1, func(round uint32) ([][]byte, error) {
			streams, err := job.seal(round)
			if err != nil {
				return nil, err
			}
			if len(streams) != len(a.order) {
				return nil, errors.Errorf("sealed %d messages, want %d", len(streams), len(a.order))
			}
			sealed = streams
			return [][]byte{streams[a.order[0]]}, nil
		}, nil)
		if err != nil {
			return noticeResult{round: r, status: status, err: err}, true
		}
		if status != cmix.Succeeded {
			// Without its second, the first can't be read: not delivered, even if
			// its round's outcome is unknown.
			return noticeResult{round: r, status: cmix.Failed}, true
		}
		a.streams, a.first = sealed, r
		// The page says so while the second waits.
		if job.progress != nil {
			job.progress("apart", 1, 2)
		}
		return noticeResult{}, false
	}
	_, status, err := sendStreamsVia(net, rngGen, job.recipient, 1, func(round uint32) ([][]byte, error) {
		if !withinApart(uint32(a.first.ID), round) {
			return nil, errApartLate // xxDK passes over these (apartExcluded): never, then
		}
		return [][]byte{a.streams[a.order[1]]}, nil
	}, newApartExcluded(a.first.ID))
	if err == nil && status == cmix.Succeeded {
		return noticeResult{round: a.first, status: status}, true
	}
	a.tries++
	if err == nil && status != cmix.Failed {
		// Its outcome is unknown: it may have arrived, so it isn't sent again,
		// and it may or may not have been delivered.
		return noticeResult{round: a.first, status: cmix.TimeOut}, true
	}
	if a.tries < apartTries && !errors.Is(err, errApartLate) {
		return noticeResult{}, false
	}
	// Half a notice is no notice: it wasn't delivered.
	return noticeResult{round: a.first, status: cmix.Failed}, true
}

// sendAllVia sends what's left of a notice now: sent apart, each try at the
// second after a random pause.
func sendAllVia(net streamSender, rngGen *fastRNG.StreamGenerator, job *noticeJob) noticeResult {
	for {
		if job.between() {
			time.Sleep(apartPause())
		}
		if res, finished := sendNext(net, rngGen, job); finished {
			return res
		}
	}
}
