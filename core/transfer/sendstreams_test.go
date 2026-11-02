package transfer

import (
	"bytes"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/id/ephemeral"
)

// retryingNet stands in for the network: it asks the assembler for each of
// tries in turn, as xxDK does when a round fails before the message goes,
// and sends in the last.
type retryingNet struct {
	tries []id.Round
	sent  [][]cmix.TargetedCmixMessage // what each try assembled
}

func (n *retryingNet) GetMaxMessageLength() int { return msgLen }

func (n *retryingNet) SendWithAssembler(recipient *id.ID, assemble cmix.MessageAssembler,
	_ cmix.CMIXParams) (rounds.Round, ephemeral.Id, error) {
	for _, r := range n.tries {
		fp, _, payload, mac, err := assemble(r)
		if err != nil {
			return rounds.Round{}, ephemeral.Id{}, err
		}
		n.sent = append(n.sent, []cmix.TargetedCmixMessage{{Recipient: recipient, Payload: payload, Fingerprint: fp, Mac: mac}})
	}
	return rounds.Round{ID: n.tries[len(n.tries)-1]}, ephemeral.Id{}, nil
}

func (n *retryingNet) SendManyWithAssembler(_ []*id.ID, assemble cmix.ManyMessageAssembler,
	_ cmix.CMIXParams) (rounds.Round, []ephemeral.Id, error) {
	for _, r := range n.tries {
		msgs, err := assemble(r)
		if err != nil {
			return rounds.Round{}, nil, err
		}
		n.sent = append(n.sent, msgs)
	}
	return rounds.Round{ID: n.tries[len(n.tries)-1]}, nil, nil
}

func (n *retryingNet) GetRoundResults(_ time.Duration, callback cmix.RoundEventCallback, roundList ...id.Round) {
	results := map[id.Round]cmix.RoundResult{}
	for _, r := range roundList {
		results[r] = cmix.RoundResult{Status: cmix.Succeeded}
	}
	go callback(true, false, results)
}

// A notice is sealed afresh for every round xxDK tries, inside the
// assembler: a try sealed for an earlier round would be dropped as a copy.
// Each try carries its own round and the same id, and the round sent in is
// the one reported.
func TestSendStreamsSealsEachTry(t *testing.T) {
	k, other := testKey(t, 1), testKey(t, 2)
	rng := fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG)
	keys, err := k.replyKeysFor(other.Address)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		to    *InboxAddress
		from  *From
		reply *ReplyKeys
	}{
		{k.Address, nil, nil},
		{k.Address4, nil, nil},
		{k.Address, &From{Key: other}, keys}, // a reply, sealed with reply keys
	} {
		to := c.to
		net := &retryingNet{tries: []id.Round{456090129, 456090130, 456090134}}
		seal, err := newNoticeSealer(to, NoticeText, []byte("retried"), c.from, c.reply, msgLen)
		if err != nil {
			t.Fatal(err)
		}
		pieces := modeOf(to, c.reply).pieces()
		r, status, err := sendStreamsVia(net, rng, to.mailbox, pieces, seal, nil)
		if err != nil || status != cmix.Succeeded || r.ID != 456090134 {
			t.Fatalf("round %d, status %v, %v", r.ID, status, err)
		}
		if len(net.sent) != len(net.tries) {
			t.Fatalf("assembled %d times for %d tries", len(net.sent), len(net.tries))
		}
		var first opened
		for i, msgs := range net.sent {
			if len(msgs) != pieces {
				t.Fatalf("try %d: %d messages, want %d", i, len(msgs), pieces)
			}
			streams := make([][]byte, len(msgs))
			for j, m := range msgs {
				if !m.Recipient.Cmp(to.mailbox) {
					t.Fatal("a message went to another mailbox")
				}
				msg := format.NewMessage(512)
				msg.SetKeyFP(m.Fingerprint)
				msg.SetMac(m.Mac)
				msg.SetContents(m.Payload)
				streams[j] = messageStream(msg)
			}
			o, err := open(k, streams)
			if c.reply != nil {
				o, err = openAny(k, streams[0])
			}
			if err != nil {
				t.Fatalf("try %d didn't open: %v", i, err)
			}
			if o.round != uint32(net.tries[i]) || string(o.body) != "retried" {
				t.Fatalf("try %d in round %d was sealed for round %d", i, net.tries[i], o.round)
			}
			if i == 0 {
				first = o
			} else if o.id != first.id {
				t.Fatal("two tries at one notice have different ids")
			}
		}
	}
}

// apartNet stands in for the network for notices sent apart: each send
// tries its rounds in turn, skipping any its ExcludedRounds won't take (as
// xxDK does: comms' WaitingRounds passes over a round whose Insert reports
// false), and goes in the last; that round then reports the send's status. A
// send with no round left fails, as xxDK's times out. What each try
// assembled is kept.
type apartNet struct {
	sends    [][]id.Round
	careless bool // offers rounds it was told to avoid
	statuses []cmix.RoundLookupStatus
	tries    [][][]byte // each send's tries' streams
	rounds   []id.Round // the round each send went in
	excluded [][]id.Round
	status   map[id.Round]cmix.RoundLookupStatus
}

func (n *apartNet) GetMaxMessageLength() int { return msgLen }

func (n *apartNet) SendWithAssembler(_ *id.ID, assemble cmix.MessageAssembler,
	params cmix.CMIXParams) (rounds.Round, ephemeral.Id, error) {
	i := len(n.tries)
	n.tries = append(n.tries, nil)
	var avoid []id.Round
	var went id.Round
	var offered []id.Round
	if i < len(n.sends) {
		offered = n.sends[i]
	}
	for _, r := range offered {
		if !n.careless && params.ExcludedRounds != nil && !params.ExcludedRounds.Insert(r) {
			avoid = append(avoid, r)
			continue
		}
		fp, _, payload, mac, err := assemble(r)
		if err != nil {
			n.excluded = append(n.excluded, avoid)
			n.rounds = append(n.rounds, 0)
			return rounds.Round{}, ephemeral.Id{}, err
		}
		msg := format.NewMessage(512)
		msg.SetKeyFP(fp)
		msg.SetMac(mac)
		msg.SetContents(payload)
		n.tries[i] = append(n.tries[i], messageStream(msg))
		went = r
	}
	n.excluded = append(n.excluded, avoid)
	n.rounds = append(n.rounds, went)
	if len(n.tries[i]) == 0 {
		return rounds.Round{}, ephemeral.Id{}, errors.New("Sending cmix message timed out")
	}
	if n.status == nil {
		n.status = map[id.Round]cmix.RoundLookupStatus{}
	}
	n.status[went] = n.statuses[min(i, len(n.statuses)-1)]
	return rounds.Round{ID: went}, ephemeral.Id{}, nil
}

func (n *apartNet) SendManyWithAssembler([]*id.ID, cmix.ManyMessageAssembler,
	cmix.CMIXParams) (rounds.Round, []ephemeral.Id, error) {
	return rounds.Round{}, nil, errors.New("a notice sent apart went in one round")
}

func (n *apartNet) GetRoundResults(_ time.Duration, callback cmix.RoundEventCallback, roundList ...id.Round) {
	results := map[id.Round]cmix.RoundResult{}
	for _, r := range roundList {
		if st := n.status[r]; st != cmix.TimeOut {
			results[r] = cmix.RoundResult{Status: st}
		}
	}
	go callback(false, false, results)
}

// sent is what a send went with: its last try's stream.
func (n *apartNet) sent(i int) []byte { return n.tries[i][len(n.tries[i])-1] }

// A quantum-safe notice sent apart: the first message, either half
// at random, is sealed afresh for each round tried; once its round has
// succeeded, after a pause, the other goes with the same bytes, never in the
// first's round, and tried again with the same bytes if its round fails. The
// owner finds the notice, as sent in the first's round. A first that fails,
// or whose outcome is unknown, is the end: undelivered; a second that can't
// go within apartRounds, or fails every try, leaves it undelivered; one whose
// outcome is unknown isn't sent again, and leaves it unknown. Its progress
// hears "apart" once the first is delivered, before the pause.
func TestSendApart(t *testing.T) {
	k := testKey(t, 1)
	rng := fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG)
	defer func(p func() time.Duration) { apartPause = p }(apartPause)
	pauses := 0
	apartPause = func() time.Duration { pauses++; return 0 }
	const (
		ok      = cmix.Succeeded
		failed  = cmix.Failed
		unknown = cmix.TimeOut
	)
	careless := false
	var heard []string // what progress heard, and how many pauses had gone by then
	run := func(sends [][]id.Round, statuses []cmix.RoundLookupStatus) (*apartNet, noticeResult, *noticeJob) {
		t.Helper()
		job, err := newNoticeJob(k.Address4, NoticeText, []byte("apart"), nil, nil, msgLen, true)
		if err != nil {
			t.Fatal(err)
		}
		heard = nil
		job.progress = func(stage string, done, total int) {
			heard = append(heard, fmt.Sprintf("%s %d/%d, %d pauses", stage, done, total, pauses))
		}
		net := &apartNet{sends: sends, statuses: statuses, careless: careless}
		pauses = 0
		return net, sendAllVia(net, rng, job), job
	}
	firsts := map[int]bool{}
	for range 24 {
		net, res, job := run([][]id.Round{{456090129, 456090130}, {456090130, 456090133}}, []cmix.RoundLookupStatus{ok, ok})
		if res.err != nil || res.status != ok || res.round.ID != 456090130 {
			t.Fatalf("round %d, status %v, %v", res.round.ID, res.status, res.err)
		}
		if len(net.tries) != 2 || pauses != 1 {
			t.Fatalf("%d sends and %d pauses, want 2 and 1", len(net.tries), pauses)
		}
		if !slices.Equal(heard, []string{"apart 1/2, 0 pauses"}) {
			t.Fatalf("progress heard %q", heard)
		}
		// The first was sealed for each round it tried, the second never went
		// in the first's round.
		if len(net.tries[0]) != 2 || bytes.Equal(net.tries[0][0], net.tries[0][1]) {
			t.Fatal("the first wasn't sealed afresh for its second try")
		}
		if !slices.Equal(net.excluded[1], []id.Round{456090130}) || net.rounds[1] != 456090133 {
			t.Fatalf("the second avoided %v and went in %d", net.excluded[1], net.rounds[1])
		}
		first, second := job.apart.order[0], job.apart.order[1]
		firsts[first] = true
		if !bytes.Equal(net.sent(0), job.apart.streams[first]) || !bytes.Equal(net.sent(1), job.apart.streams[second]) {
			t.Fatal("what went isn't the notice's two halves")
		}
		// The owner finds it, as the network delivered it.
		var got []Notice
		s := testSession(k, func(n Notice) { got = append(got, n) })
		for i := range 2 {
			s.Process(cmixMessage(t, net.sent(i)), nil, nil, receptionID.EphemeralIdentity{}, roundAt(net.rounds[i], testSent.Add(time.Duration(i)*5*time.Second)))
		}
		if len(got) != 1 || string(got[0].Body) != "apart" || got[0].Round != 456090130 {
			t.Fatalf("the owner found %+v", got)
		}
	}
	if len(firsts) != 2 {
		t.Fatal("the same half always went first")
	}

	// The second's round fails: it goes again, the same bytes, after a pause.
	net, res, _ := run([][]id.Round{{100}, {103}, {107}}, []cmix.RoundLookupStatus{ok, failed, ok})
	if res.status != ok || res.round.ID != 100 || len(net.tries) != 3 || pauses != 2 || !bytes.Equal(net.sent(1), net.sent(2)) {
		t.Fatalf("status %v round %d, %d sends, %d pauses", res.status, res.round.ID, len(net.tries), pauses)
	}
	// The first fails: nothing more goes, and nothing is said to be delivered.
	net, res, _ = run([][]id.Round{{100}}, []cmix.RoundLookupStatus{failed})
	if res.status != failed || len(net.tries) != 1 || pauses != 0 || heard != nil {
		t.Fatalf("status %v, %d sends, heard %q", res.status, len(net.tries), heard)
	}
	// Its outcome unknown: still undelivered, since half a notice can't be read.
	net, res, _ = run([][]id.Round{{100}}, []cmix.RoundLookupStatus{unknown})
	if res.status != failed || len(net.tries) != 1 {
		t.Fatalf("status %v, %d sends", res.status, len(net.tries))
	}
	// The second fails every try: undelivered; unknown if a try may have
	// arrived.
	net, res, _ = run([][]id.Round{{100}, {101}, {102}, {103}}, []cmix.RoundLookupStatus{ok, failed, failed, failed})
	if res.status != failed || len(net.tries) != 1+apartTries {
		t.Fatalf("status %v, %d sends", res.status, len(net.tries))
	}
	// Its outcome unknown: it may have arrived, so it isn't sent again (two that
	// both arrived would be identical messages at the mailbox).
	net, res, _ = run([][]id.Round{{100}, {101}, {102}}, []cmix.RoundLookupStatus{ok, unknown, ok})
	if res.status != unknown || len(net.tries) != 2 {
		t.Fatalf("status %v, %d sends", res.status, len(net.tries))
	}
	// The second may go up to apartRounds from the first either way, as round
	// numbers don't follow start times (the reviews, 2026-10-18: one send in
	// six seconds after another went in a lower-numbered round on mainnet).
	for _, second := range []id.Round{1000 + apartRounds, 1000 - apartRounds, 995} {
		_, res, _ = run([][]id.Round{{1000}, {second}}, []cmix.RoundLookupStatus{ok, ok})
		if res.status != ok {
			t.Fatalf("the second in round %d: status %v, %v", second, res.status, res.err)
		}
	}
	// A round past that is passed over, not refused: xxDK goes on to the next.
	net, res, _ = run([][]id.Round{{1000}, {1000 + apartRounds + 1, 1000 - apartRounds - 1, 1003}}, []cmix.RoundLookupStatus{ok, ok})
	if res.status != ok || len(net.tries) != 2 || net.rounds[1] != 1003 || len(net.tries[1]) != 1 {
		t.Fatalf("past the limit, then 103: status %v, %d sends, round %d", res.status, len(net.tries), net.rounds[1])
	}
	// With none in reach, it's tried apartTries times, never outside, then fails.
	net, res, _ = run([][]id.Round{{100}, {100 + apartRounds + 1}}, []cmix.RoundLookupStatus{ok, ok})
	if res.status != failed || len(net.tries) != 1+apartTries || len(net.tries[1]) != 0 {
		t.Fatalf("past the limit: status %v, %d sends, %d tries at the second", res.status, len(net.tries), len(net.tries[1]))
	}
	// Never in the first's round, even if the network offers it.
	careless = true
	net, res, _ = run([][]id.Round{{100}, {100}}, []cmix.RoundLookupStatus{ok, ok})
	careless = false
	if res.status != failed || len(net.tries[1]) != 0 {
		t.Fatalf("the second in the first's round: status %v, %d tries", res.status, len(net.tries[1]))
	}
	// A notice of one message is never sent apart, whatever's asked.
	job, err := newNoticeJob(k.Address, NoticeText, []byte("one"), nil, nil, msgLen, true)
	if err != nil || job.apart != nil {
		t.Fatal("a compact notice would go apart")
	}
}

// glueNet stands in for the network behind a Client (network): every send
// goes in the next round that its ExcludedRounds will take, which starts a
// second after the one before, and succeeds. It keeps what went where.
type glueNet struct {
	mu    sync.Mutex
	next  id.Round
	sends []glueSend
}

type glueSend struct {
	recipient *id.ID
	stream    []byte
	round     rounds.Round
}

func (n *glueNet) GetMaxMessageLength() int { return msgLen }

func (n *glueNet) SendWithAssembler(recipient *id.ID, assemble cmix.MessageAssembler,
	params cmix.CMIXParams) (rounds.Round, ephemeral.Id, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for range 10 {
		n.next++
		if params.ExcludedRounds != nil && !params.ExcludedRounds.Insert(n.next) {
			continue
		}
		fp, _, payload, mac, err := assemble(n.next)
		if err != nil {
			return rounds.Round{}, ephemeral.Id{}, err
		}
		msg := format.NewMessage(512)
		msg.SetKeyFP(fp)
		msg.SetMac(mac)
		msg.SetContents(payload)
		r := roundAt(n.next, testSent.Add(time.Duration(n.next)*time.Second))
		n.sends = append(n.sends, glueSend{recipient, messageStream(msg), r})
		return r, ephemeral.Id{}, nil
	}
	return rounds.Round{}, ephemeral.Id{}, errors.New("no round")
}

func (n *glueNet) SendManyWithAssembler([]*id.ID, cmix.ManyMessageAssembler,
	cmix.CMIXParams) (rounds.Round, []ephemeral.Id, error) {
	return rounds.Round{}, nil, errors.New("not used here")
}

func (n *glueNet) GetRoundResults(_ time.Duration, callback cmix.RoundEventCallback, roundList ...id.Round) {
	results := map[id.Round]cmix.RoundResult{}
	for _, r := range roundList {
		results[r] = cmix.RoundResult{Status: cmix.Succeeded}
	}
	go callback(true, false, results)
}

// to is what went to the mailbox, in order.
func (n *glueNet) to(mailbox *id.ID) (out []glueSend) {
	n.mu.Lock()
	defer n.mu.Unlock()
	for _, s := range n.sends {
		if s.recipient.Cmp(mailbox) {
			out = append(out, s)
		}
	}
	return out
}

// SendNoticeAt sends a quantum-safe notice apart, through the real cover loop
// (the reviews, 2026-10-18: the glue had no test): straight away, after a
// pause between the halves; on the beat of cover messages, each half in the
// next place in turn; and handed back between its halves when cover stops,
// carrying on with no cover gap (a gap here would be an hour). Each time the
// owner finds it once, as sent in its first half's round, and SendNoticeAt
// reports that round's time.
func TestSendNoticeAtApart(t *testing.T) {
	k := testKey(t, 1)
	defer func(p func() time.Duration, r coverRate) { apartPause, coverActive = p, r }(apartPause, coverActive)
	var pauses atomic.Int32
	apartPause = func() time.Duration { pauses.Add(1); return 0 }
	coverActive = coverRate{1, 1, time.Hour, time.Hour}
	for _, c := range []struct {
		name     string
		atRandom bool
		stopAt   int // which gap ends cover (0: none)
		pauses   int32
	}{
		{"straight away", false, 0, 1},
		{"on the beat of cover", true, 0, 0},
		{"handed back between its halves", true, 2, 1},
	} {
		net := &glueNet{next: 456090000}
		cl := &Client{streamNet: net, streamRng: fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG)}
		pauses.Store(0)
		if c.atRandom {
			gaps := 0
			cl.cover.wait = func(_ time.Duration, stop <-chan struct{}, nudge <-chan struct{}) bool {
				gaps++
				if gaps == 1 {
					select { // the first gap lasts until the notice is offered
					case <-nudge:
					case <-stop:
						return false
					}
				}
				return gaps != c.stopAt
			}
			cl.SetCover(true)
		}
		done := make(chan struct{})
		var sent time.Time
		var err error
		go func() {
			sent, err = cl.SendNoticeAt(k.Address4, NoticeText, []byte(c.name), nil, nil, NoticeTiming{AtRandom: c.atRandom, Apart: true}, func(string, int, int) {})
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s: SendNoticeAt never returned", c.name)
		}
		cl.SetCover(false)
		halves := net.to(k.Address4.mailbox)
		if err != nil || len(halves) != 2 || halves[0].round.ID == halves[1].round.ID {
			t.Fatalf("%s: %v, %d halves", c.name, err, len(halves))
		}
		if !sent.Equal(roundTime(halves[0].round)) {
			t.Fatalf("%s: reported %s, the first went at %s", c.name, sent, roundTime(halves[0].round))
		}
		if pauses.Load() != c.pauses {
			t.Fatalf("%s: %d pauses, want %d", c.name, pauses.Load(), c.pauses)
		}
		// On the beat of cover, the halves take two places in a row.
		if c.atRandom && c.stopAt == 0 {
			net.mu.Lock()
			i := slices.IndexFunc(net.sends, func(s glueSend) bool { return s.recipient.Cmp(k.Address4.mailbox) })
			next := net.sends[i+1].recipient.Cmp(k.Address4.mailbox)
			net.mu.Unlock()
			if !next {
				t.Fatalf("%s: a cover message went between the halves", c.name)
			}
		}
		var got []Notice
		s := testSession(k, func(n Notice) { got = append(got, n) })
		for _, h := range halves {
			msg := format.NewMessage(512)
			fp, mac, contents, err := splitStream(h.stream, msgLen)
			if err != nil {
				t.Fatal(err)
			}
			msg.SetKeyFP(fp)
			msg.SetMac(mac)
			msg.SetContents(contents)
			s.Process(msg, nil, nil, receptionID.EphemeralIdentity{}, h.round)
		}
		if len(got) != 1 || string(got[0].Body) != c.name || got[0].Round != uint64(halves[0].round.ID) {
			t.Fatalf("%s: the owner found %+v", c.name, got)
		}
	}
}

// The pause before the second half stays within its bounds (2 to 15 s, chosen
// on 2026-10-19 to keep the pieces at most about 30 s apart,
// with the first's 5 to 10 s wait for its round; a wrong bound would panic at
// run time, and every
// other test replaces apartPause), and the window holds the sender's slowest
// success: every try at the second after the longest pause (or cover gap),
// search and wait, at a round about every 0.8 s. The owner holds a half at
// least that long.
func TestApartTiming(t *testing.T) {
	seen := map[time.Duration]bool{}
	for range 2000 {
		d := apartPause()
		if d < apartPauseMin || d > apartPauseMax {
			t.Fatalf("a pause of %s, outside %s-%s", d, apartPauseMin, apartPauseMax)
		}
		seen[d.Round(time.Second)] = true
	}
	if len(seen) < 3 {
		t.Fatalf("pauses hardly vary: %v", seen)
	}
	if apartPauseMin < time.Second || apartPauseMax > 15*time.Second || apartPauseMax-apartPauseMin < 10*time.Second {
		t.Fatalf("pause %s-%s: the pieces are meant to go at most about 30 s apart", apartPauseMin, apartPauseMax)
	}
	const search, wait = 45 * time.Second, noticeRoundTimeout
	slowest := apartTries * (max(apartPauseMax, coverActive.gapMax) + search + wait)
	if window := time.Duration(apartRounds) * 800 * time.Millisecond; window < slowest {
		t.Fatalf("apartRounds spans %s, but a second half can take %s", window, slowest)
	}
	if pairKeep < slowest {
		t.Fatalf("pairKeep %s is shorter than a second half can take (%s)", pairKeep, slowest)
	}
	// And a round the network failed to hand over is tried again after
	// seconds, then minutes (xxDK's back-off): an hour lets most such pickups
	// still find their other half.
	if pairKeep < time.Hour {
		t.Fatalf("pairKeep %s: a half whose round is picked up again later loses its other half", pairKeep)
	}
}

// The second half's ExcludedRounds, as xxDK uses them (comms' WaitingRounds
// takes a round only when Insert reports true, and sendCmix inserts a round
// whose send failed): never the first's round or one out of reach, and never
// a round already tried.
func TestApartExcluded(t *testing.T) {
	e := newApartExcluded(1000)
	base := e.Len() // the set xxDK's primitives make starts with nil in it
	for _, r := range []id.Round{1000, 1000 + apartRounds + 1, 1000 - apartRounds - 1} {
		if e.Insert(r) || !e.Has(r) {
			t.Fatalf("round %d taken", r)
		}
	}
	for _, r := range []id.Round{999, 1000 + apartRounds, 1000 - apartRounds} {
		if e.Has(r) || !e.Insert(r) {
			t.Fatalf("round %d refused", r)
		}
		if e.Insert(r) || !e.Has(r) {
			t.Fatalf("round %d taken twice", r)
		}
	}
	if e.Len()-base != 3 {
		t.Fatalf("%d tried, want 3", e.Len()-base)
	}
}
