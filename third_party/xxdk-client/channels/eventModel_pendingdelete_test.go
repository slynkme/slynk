package channels

import (
	"bytes"
	"crypto/ed25519"
	"math/rand"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"

	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/client/v4/collective/versioned"
	cryptoChannel "gitlab.com/elixxir/crypto/channel"
	"gitlab.com/elixxir/crypto/fastRNG"
	"gitlab.com/elixxir/crypto/message"
	"gitlab.com/elixxir/ekv"
	"gitlab.com/xx_network/crypto/csprng"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
	"gitlab.com/elixxir/primitives/states"
)

// A delete can outrun the message it targets — the ordinary case for a device
// replaying a channel's history, whose historical rounds are retrieved
// concurrently. receiveDelete used to conflate "not seen yet" with "refused" and
// drop such a delete on the floor, so the message rendered forever.

type pendingDeleteCall struct {
	channelID *id.ID
	target    message.ID
	sender    ed25519.PublicKey
	fromAdmin bool
}

// holdingModel implements the optional PendingDeleter.
type holdingModel struct {
	*MockEvent
	getMissing bool // GetMessage reports the target is unknown
	delMissing bool // DeleteMessage reports the target is unknown
	held       []pendingDeleteCall
}

func (m *holdingModel) GetMessage(msgID message.ID) (ModelMessage, error) {
	if m.getMissing {
		return ModelMessage{}, NoMessageErr
	}
	return m.MockEvent.GetMessage(msgID)
}

func (m *holdingModel) DeleteMessage(msgID message.ID) error {
	if m.delMissing {
		return NoMessageErr
	}
	return m.MockEvent.DeleteMessage(msgID)
}

func (m *holdingModel) DeleteMessagePending(channelID *id.ID, target message.ID,
	sender ed25519.PublicKey, fromAdmin bool) error {
	m.held = append(m.held, pendingDeleteCall{channelID, target, sender, fromAdmin})
	return nil
}

// plainModel does NOT implement PendingDeleter — the compatibility case every
// other adopter of this fork is in.
type plainModel struct {
	*MockEvent
	getMissing  bool
	deleteCalls int
}

func (m *plainModel) GetMessage(msgID message.ID) (ModelMessage, error) {
	if m.getMissing {
		return ModelMessage{}, NoMessageErr
	}
	return m.MockEvent.GetMessage(msgID)
}

func (m *plainModel) DeleteMessage(msgID message.ID) error {
	m.deleteCalls++
	return m.MockEvent.DeleteMessage(msgID)
}

// deleteFixture builds the arguments receiveDelete needs for one delete of
// targetMessageID, and the events under test wired to model.
func deleteFixture(t *testing.T, model EventModel) (
	*events, *id.ID, message.ID, message.ID, []byte, rounds.Round,
	cryptoChannel.PrivateIdentity, time.Time) {
	t.Helper()
	prng := rand.New(rand.NewSource(65))
	e := initEvents(model, 512, versioned.NewKV(ekv.MakeMemstore()),
		fastRNG.NewStreamGenerator(1, 1, csprng.NewSystemRNG))

	chID, _ := id.NewRandomID(prng, id.User)
	targetMessageID := message.DeriveChannelMessageID(chID, 420, []byte("blarg"))
	marshaled, err := proto.Marshal(&CMIXChannelDelete{
		Version: 0, MessageID: targetMessageID[:]})
	if err != nil {
		t.Fatalf("Failed to proto marshal: %+v", err)
	}
	r := rounds.Round{ID: 420,
		Timestamps: map[states.Round]time.Time{states.QUEUED: netTime.Now()}}
	msgID := message.DeriveChannelMessageID(chID, uint64(r.ID), marshaled)
	pi, err := cryptoChannel.GenerateIdentity(prng)
	if err != nil {
		t.Fatal(err)
	}
	return e, chID, msgID, targetMessageID, marshaled, r, pi, netTime.Now()
}

func TestReceiveDelete_HoldsAMemberDeleteWhoseTargetIsNotYetKnown(t *testing.T) {
	model := &holdingModel{MockEvent: &MockEvent{}, getMissing: true}
	e, chID, msgID, target, marshaled, r, pi, ts := deleteFixture(t, model)

	e.receiveDelete(chID, msgID, Delete, AdminUsername, marshaled, nil,
		pi.PubKey, 0, pi.CodesetVersion, ts, ts, 69*time.Minute, r.ID, r,
		Delivered, false, false)

	if len(model.held) != 1 {
		t.Fatalf("delete was not held: got %d holds, want 1", len(model.held))
	}
	got := model.held[0]
	if got.target != target {
		t.Errorf("held the wrong target.\nexpected: %s\nreceived: %s", target, got.target)
	}
	if !bytes.Equal(got.sender, pi.PubKey) {
		t.Errorf("held delete lost its sender.\nexpected: %x\nreceived: %x", pi.PubKey, got.sender)
	}
	if got.fromAdmin {
		t.Error("a member delete must not be held as an admin delete")
	}
	if !got.channelID.Cmp(chID) {
		t.Errorf("held the wrong channel.\nexpected: %s\nreceived: %s", chID, got.channelID)
	}
}

func TestReceiveDelete_HoldsAnAdminDeleteWhoseTargetIsNotYetKnown(t *testing.T) {
	// An admin delete skips the GetMessage gate entirely, so it discovers the
	// missing target only when DeleteMessage reports it.
	model := &holdingModel{MockEvent: &MockEvent{}, delMissing: true}
	e, chID, msgID, target, marshaled, r, pi, ts := deleteFixture(t, model)

	e.receiveDelete(chID, msgID, Delete, AdminUsername, marshaled, nil,
		pi.PubKey, 0, pi.CodesetVersion, ts, ts, 69*time.Minute, r.ID, r,
		Delivered, true, false)

	if len(model.held) != 1 {
		t.Fatalf("admin delete was not held: got %d holds, want 1", len(model.held))
	}
	if model.held[0].target != target {
		t.Errorf("held the wrong target.\nexpected: %s\nreceived: %s", target, model.held[0].target)
	}
	if !model.held[0].fromAdmin {
		t.Error("an admin delete must be held as one — it needs no author equality")
	}
}

// The negative control. A delete REFUSED because the sender is not the author
// must never be converted into a held delete: holding it would let any member
// suppress any message on any peer that had not yet folded it.
func TestReceiveDelete_DoesNotHoldADeleteItAffirmativelyRefused(t *testing.T) {
	// getMissing false → the target resolves, with PubKey nil, which cannot
	// match the sender. That is the "not from the original sender" refusal.
	model := &holdingModel{MockEvent: &MockEvent{}}
	e, chID, msgID, _, marshaled, r, pi, ts := deleteFixture(t, model)

	e.receiveDelete(chID, msgID, Delete, AdminUsername, marshaled, nil,
		pi.PubKey, 0, pi.CodesetVersion, ts, ts, 69*time.Minute, r.ID, r,
		Delivered, false, false)

	if len(model.held) != 0 {
		t.Fatalf("a refused delete was held: %d holds. Holding a delete the "+
			"author check rejected is a remote censorship primitive", len(model.held))
	}
}

// Every other adopter of this fork uses a model without the optional interface.
// Their behavior must be exactly what it was.
func TestReceiveDelete_LeavesAModelWithoutTheInterfaceUnchanged(t *testing.T) {
	model := &plainModel{MockEvent: &MockEvent{}, getMissing: true}
	e, chID, msgID, _, marshaled, r, pi, ts := deleteFixture(t, model)

	// Must not panic on the failed type assertion, and must still bail before
	// DeleteMessage exactly as it did before this change.
	e.receiveDelete(chID, msgID, Delete, AdminUsername, marshaled, nil,
		pi.PubKey, 0, pi.CodesetVersion, ts, ts, 69*time.Minute, r.ID, r,
		Delivered, false, false)

	if model.deleteCalls != 0 {
		t.Errorf("a model without the optional interface changed behavior: "+
			"DeleteMessage called %d times, want 0", model.deleteCalls)
	}
}
