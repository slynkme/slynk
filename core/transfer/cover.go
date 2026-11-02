package transfer

import (
	"crypto/rand"
	"math/big"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/message"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/primitives/excludedRounds"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
)

// Cover messages (opt-in): while they're on, the tab sends a few blank
// messages now and then to random recipients, so a real send is one of many
// from it rather than the only thing it does. Each is shaped exactly like a
// compact inbox notice (sendStreamsVia): one full-size message, random fields
// all through, the default send settings and a wait for the round's result.
// They help single messages most, and more as more people send them. They
// can't disguise a multi-round upload, whose parts all go to one recipient.

// coverRate paces cover messages: bursts of burstMin to burstMax messages,
// gapMin to gapMax apart.
type coverRate struct {
	burstMin, burstMax int
	gapMin, gapMax     time.Duration
}

var (
	// coverActive is xx Messenger's original cover rate.
	coverActive = coverRate{1, 5, 5 * time.Second, 55 * time.Second}
	// coverQuiet is xxDK's later, slower rate, used once the tab has sent and
	// received nothing for coverQuietAfter, to keep the load on the network
	// down: every cover message is stored on its round's gateways for the
	// network's ~500 h retention.
	coverQuiet = coverRate{1, 2, 2 * time.Minute, 18 * time.Minute}
)

const coverQuietAfter = 30 * time.Minute

// next draws a burst size and the gap after it, unpredictably.
func (r coverRate) next() (burst int, gap time.Duration) {
	return r.burstMin + int(randBelow(int64(r.burstMax-r.burstMin+1))),
		r.gapMin + time.Duration(randBelow(int64(r.gapMax-r.gapMin)+1))
}

func randBelow(n int64) int64 {
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		return 0
	}
	return v.Int64()
}

// coverer runs the cover loop for one client.
type coverer struct {
	mu   sync.Mutex
	stop chan struct{}
	// jobs holds notices waiting for the loop's next beat, and nudge wakes a
	// loop resting through a long gap when one arrives. Both exist while the
	// loop runs.
	jobs  chan *noticeJob
	nudge chan struct{}
	sent  atomic.Int64
	// wait pauses for d unless stop closes first, reporting whether to go on.
	// A nudge may shorten it. Tests replace it.
	wait func(d time.Duration, stop <-chan struct{}, nudge <-chan struct{}) bool
}

// noticeJob is a notice waiting for its moment to be sent: pieces messages
// to recipient in one round, sealed for that round as it's chosen, or, with
// apart, one at a time, each in a round of its own (apart.go).
type noticeJob struct {
	recipient *id.ID
	pieces    int
	seal      noticeSealer
	apart     *apartSend
	done      chan noticeResult
	// progress, if not nil, hears "apart" once the first of a notice sent
	// apart has been delivered.
	progress Progress
}

type noticeResult struct {
	round  rounds.Round
	status cmix.RoundLookupStatus
	err    error
	// again means cover stopped before the notice went: send it another way.
	again bool
}

func (cv *coverer) set(on bool, send func(*noticeJob) (bool, error), idle func() time.Duration) {
	cv.mu.Lock()
	defer cv.mu.Unlock()
	switch {
	case on && cv.stop == nil:
		cv.stop = make(chan struct{})
		cv.jobs = make(chan *noticeJob, 16)
		cv.nudge = make(chan struct{}, 1)
		wait := cv.wait
		if wait == nil {
			wait = sleepOrStop
		}
		go runCover(cv.stop, cv.jobs, cv.nudge, func(job *noticeJob) (bool, error) {
			more, err := send(job)
			if err == nil && job == nil {
				cv.sent.Add(1)
			}
			return more, err
		}, idle, wait)
	case !on && cv.stop != nil:
		close(cv.stop)
		cv.stop, cv.jobs, cv.nudge = nil, nil, nil
	}
}

// offer hands a notice to the running loop, reporting false if cover is off.
func (cv *coverer) offer(job *noticeJob) bool {
	cv.mu.Lock()
	defer cv.mu.Unlock()
	if cv.stop == nil {
		return false
	}
	select {
	case cv.jobs <- job:
	default:
		return false // too many waiting: the caller sends it another way
	}
	select {
	case cv.nudge <- struct{}{}:
	default:
	}
	return true
}

// runCover sends bursts of cover messages until stop is closed, starting with
// a burst, so the tab's first sends after connecting aren't its real ones.
// From the second burst on, a notice waiting in jobs takes the place of the
// next blank message, so real messages go out on the same beat as cover. A
// notice sent apart takes one place for each message, in turn: send reports
// more when it has another to go.
func runCover(stop <-chan struct{}, jobs <-chan *noticeJob, nudge <-chan struct{},
	send func(*noticeJob) (more bool, err error), idle func() time.Duration,
	wait func(time.Duration, <-chan struct{}, <-chan struct{}) bool) {
	var cur *noticeJob // a notice part way through being sent apart
	// Notices still waiting when cover stops are handed back, with what's
	// been sent of one part way: it carries on from there.
	defer func() {
		if cur != nil {
			cur.done <- noticeResult{again: true}
		}
		for {
			select {
			case job := <-jobs:
				job.done <- noticeResult{again: true}
			default:
				return
			}
		}
	}()
	for first := true; ; first = false {
		rate := coverActive
		if idle() >= coverQuietAfter {
			rate = coverQuiet
		}
		burst, gap := rate.next()
		for range burst {
			select {
			case <-stop:
				return
			default:
			}
			job := cur
			if job == nil && !first {
				select {
				case job = <-jobs:
				default:
				}
			}
			more, err := send(job)
			if err != nil && job == nil {
				jww.WARN.Printf("[Slynk] A cover message wasn't sent: %v", err)
			}
			cur = nil
			if more {
				cur = job
			}
		}
		if !wait(gap, stop, nudge) {
			return
		}
	}
}

// nudgeGap is the most a notice waits once it arrives in a gap. Tests
// shorten it.
var nudgeGap = func() time.Duration {
	_, gap := coverActive.next()
	return gap
}

// sleepOrStop rests for d, or less if a notice arrives meanwhile: then the
// rest of the gap becomes at most an active-rate gap, so a notice never
// waits out a long quiet gap.
func sleepOrStop(d time.Duration, stop <-chan struct{}, nudge <-chan struct{}) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	end := time.Now().Add(d)
	for {
		select {
		case <-t.C:
			return true
		case <-stop:
			return false
		case <-nudge:
			if gap := nudgeGap(); time.Now().Add(gap).Before(end) {
				end = time.Now().Add(gap)
				t.Reset(gap)
			}
		}
	}
}

// SetCover turns cover messages on or off for this client.
func (c *Client) SetCover(on bool) {
	c.cover.set(on, c.sendCoverOrNotice, c.idleFor)
}

// sendCoverOrNotice sends the loop's next message: a waiting notice's (all of
// it, or its next message if it's sent apart), or else a blank one. It
// reports whether the notice has more to send.
func (c *Client) sendCoverOrNotice(job *noticeJob) (bool, error) {
	if job == nil {
		return false, c.sendCover()
	}
	res, finished := c.sendNext(job)
	if !finished {
		return true, nil
	}
	job.done <- res
	return false, res.err
}

// CoverSent counts the cover messages this client has sent.
func (c *Client) CoverSent() int {
	return int(c.cover.sent.Load())
}

func (c *Client) sendCover() error {
	net, rngGen := c.network()
	stream := rngGen.GetStream()
	recipient, err := id.NewRandomID(stream, id.User)
	stream.Close()
	if err != nil {
		return err
	}
	streamLen := noticeStreamLen(net.GetMaxMessageLength())
	_, _, err = sendStreamsVia(net, rngGen, recipient, 1, func(uint32) ([][]byte, error) {
		blank := make([]byte, streamLen)
		_, err := rand.Read(blank)
		return [][]byte{blank}, err
	}, nil)
	return err
}

// touch records that the client is sending or receiving now, which keeps
// cover messages at the active rate.
func (c *Client) touch() {
	c.lastActive.Store(time.Now().UnixNano())
}

func (c *Client) idleFor() time.Duration {
	return time.Since(time.Unix(0, c.lastActive.Load()))
}

// sendNext is sendNext (apart.go) through this client's network.
func (c *Client) sendNext(job *noticeJob) (noticeResult, bool) {
	net, rngGen := c.network()
	return sendNext(net, rngGen, job)
}

// sendAll is sendAllVia (apart.go) through this client's network.
func (c *Client) sendAll(job *noticeJob) noticeResult {
	net, rngGen := c.network()
	return sendAllVia(net, rngGen, job)
}

// streamSender is what sendStreamsVia needs of xxDK's cmix.Client, so tests can
// stand in for the network.
type streamSender interface {
	GetMaxMessageLength() int
	SendWithAssembler(recipient *id.ID, assembler cmix.MessageAssembler,
		params cmix.CMIXParams) (rounds.Round, ephemeral.Id, error)
	SendManyWithAssembler(recipients []*id.ID, assembler cmix.ManyMessageAssembler,
		params cmix.CMIXParams) (rounds.Round, []ephemeral.Id, error)
	GetRoundResults(timeout time.Duration, callback cmix.RoundEventCallback, roundList ...id.Round)
}

// sendStreamsVia sends pieces messages to recipient in one round, made by
// seal for the round xxDK picks (it asks again, with the new round, whenever
// it tries another), then waits for the round's result. Each stream fills a
// message's key fingerprint and MAC fields after their random first bytes,
// then its contents (splitStream), and its service tag is random, as for any
// message that uses none of them. Inbox notices and cover messages all go
// through here, so they look the same on the network. excluded, if not nil,
// are rounds it mustn't go in. net is xxDK's cmix.Client, or a stand-in in
// tests.
func sendStreamsVia(net streamSender, rngGen *fastRNG.StreamGenerator, recipient *id.ID, pieces int,
	seal noticeSealer, excluded excludedRounds.ExcludedRounds) (rounds.Round, cmix.RoundLookupStatus, error) {
	msgLen := net.GetMaxMessageLength()
	assemble := func(rid id.Round) ([]cmix.TargetedCmixMessage, error) {
		streams, err := seal(uint32(rid))
		if err != nil {
			return nil, err
		}
		if len(streams) != pieces {
			return nil, errors.Errorf("sealed %d messages, want %d", len(streams), pieces)
		}
		msgs := make([]cmix.TargetedCmixMessage, pieces)
		for i, s := range streams {
			fp, mac, contents, err := splitStream(s, msgLen)
			if err != nil {
				return nil, err
			}
			rng := rngGen.GetStream()
			service := message.GetRandomService(rng)
			rng.Close()
			msgs[i] = cmix.TargetedCmixMessage{Recipient: recipient, Payload: contents,
				Fingerprint: fp, Service: service, Mac: mac}
		}
		return msgs, nil
	}
	params := cmix.GetDefaultCMIXParams()
	if excluded != nil {
		params.ExcludedRounds = excluded
	}
	var r rounds.Round
	var err error
	if pieces == 1 {
		r, _, err = net.SendWithAssembler(recipient, func(rid id.Round) (format.Fingerprint, cmix.Service, []byte, []byte, error) {
			msgs, err := assemble(rid)
			if err != nil {
				return format.Fingerprint{}, nil, nil, nil, err
			}
			m := msgs[0]
			return m.Fingerprint, m.Service, m.Payload, m.Mac, nil
		}, params)
	} else {
		recipients := make([]*id.ID, pieces)
		for i := range recipients {
			recipients[i] = recipient
		}
		r, _, err = net.SendManyWithAssembler(recipients, assemble, params)
	}
	if err != nil {
		return rounds.Round{}, cmix.TimeOut, errors.Wrap(err, "send")
	}
	// The callback's "all succeeded" can be true for a round whose outcome
	// is still unknown, so only the round's own status counts.
	done := make(chan cmix.RoundLookupStatus, 1)
	net.GetRoundResults(noticeRoundTimeout,
		func(_, _ bool, results map[id.Round]cmix.RoundResult) {
			status := cmix.TimeOut
			if rr, ok := results[r.ID]; ok {
				status = rr.Status
			}
			done <- status
		}, r.ID)
	return r, <-done, nil
}
