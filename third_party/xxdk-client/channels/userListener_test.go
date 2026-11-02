////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file                                                               //
////////////////////////////////////////////////////////////////////////////////

package channels

import (
	"bytes"
	"crypto/ed25519"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/client/v4/collective/versioned"
	"gitlab.com/elixxir/crypto/message"
	"gitlab.com/elixxir/ekv"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/primitives/id"
	"gitlab.com/xx_network/primitives/netTime"
	"google.golang.org/protobuf/proto"
	"math/rand"
	"testing"
	"time"
)

type triggerEventDummy struct {
	gotData bool

	chID        *id.ID
	umi         *userMessageInternal
	msgID       message.ID
	receptionID receptionID.EphemeralIdentity
	round       rounds.Round
}

func (ted *triggerEventDummy) triggerEvent(chID *id.ID,
	umi *userMessageInternal, _ []byte, _ time.Time,
	receptionID receptionID.EphemeralIdentity, round rounds.Round,
	_ SentStatus) (uint64, error) {
	ted.gotData = true

	ted.chID = chID
	ted.umi = umi
	ted.receptionID = receptionID
	ted.round = round
	ted.msgID = umi.GetMessageID()

	return 0, nil
}

// Tests the happy path.
func Test_userListener_Listen(t *testing.T) {

	// Build inputs
	chID := &id.ID{}
	chID[0] = 1

	r := rounds.Round{ID: 420, Timestamps: make(map[states.Round]time.Time)}
	r.Timestamps[states.QUEUED] = netTime.Now()

	rng := rand.New(rand.NewSource(42))
	pub, priv, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate ed25519 keypair, cant run test")
	}

	cm := &ChannelMessage{
		Lease:   int64(time.Hour),
		RoundID: uint64(r.ID),
		Payload: []byte("blarg"),
	}

	cmSerial, err := proto.Marshal(cm)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	msgID := message.DeriveChannelMessageID(chID, uint64(r.ID), cmSerial)

	sig := ed25519.Sign(priv, cmSerial)
	ns := &mockNameService{validChMsg: true}

	um := &UserMessage{
		Message:      cmSerial,
		Signature:    sig,
		ECCPublicKey: pub,
	}

	umSerial, err := proto.Marshal(um)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	// Build the listener
	dummy := &triggerEventDummy{}

	al := userListener{
		chID:    chID,
		name:    ns,
		trigger: dummy.triggerEvent,
		checkSent: func(message.ID, rounds.Round) bool {
			return false
		},
	}

	// Call the listener
	mt := MessageType(42)
	al.Listen(umSerial, nil, nil, mt.Marshal(),
		receptionID.EphemeralIdentity{}, r)

	// Check the results
	if !dummy.gotData {
		t.Fatalf("No data returned after valid listen")
	}

	if !dummy.chID.Cmp(chID) {
		t.Errorf("Channel ID not correct: %s vs %s", dummy.chID, chID)
	}

	if !bytes.Equal(um.Message, dummy.umi.userMessage.Message) {
		t.Errorf("message not correct: %s vs %s", um.Message,
			dummy.umi.userMessage.Message)
	}

	if !msgID.Equals(dummy.msgID) {
		t.Errorf("messageIDs not correct: %s vs %s", msgID,
			dummy.msgID)
	}

	if r.ID != dummy.round.ID {
		t.Errorf("rounds not correct: %s vs %s", r.ID,
			dummy.round.ID)
	}
}

// Tests that the message is rejected when the user signature is invalid.
func Test_userListener_Listen_BadUserSig(t *testing.T) {
	// Build inputs
	chID := &id.ID{}
	chID[0] = 1

	r := rounds.Round{ID: 420, Timestamps: make(map[states.Round]time.Time)}
	r.Timestamps[states.QUEUED] = netTime.Now()

	rng := rand.New(rand.NewSource(42))
	pub, _, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate ed25519 keypair, cant run test")
	}

	cm := &ChannelMessage{
		Lease:   int64(time.Hour),
		RoundID: uint64(r.ID),
		Payload: []byte("blarg"),
	}

	cmSerial, err := proto.Marshal(cm)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	_, badPrivKey, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate ed25519 keypair, cant run test")
	}

	sig := ed25519.Sign(badPrivKey, cmSerial)
	ns := &mockNameService{validChMsg: true}

	um := &UserMessage{
		Message:      cmSerial,
		Signature:    sig,
		ECCPublicKey: pub,
	}

	umSerial, err := proto.Marshal(um)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	// Build the listener
	dummy := &triggerEventDummy{}

	al := userListener{
		chID:    chID,
		name:    ns,
		trigger: dummy.triggerEvent,
		checkSent: func(message.ID, rounds.Round) bool {
			return false
		},
	}

	// Call the listener
	mt := MessageType(42)
	al.Listen(umSerial, nil, nil, mt.Marshal(), receptionID.EphemeralIdentity{}, r)

	// Check the results
	if dummy.gotData {
		t.Fatalf("Data returned after invalid listen")
	}
}

// Tests that the message is rejected when the round in the message does not
// match the round passed in.
func Test_userListener_Listen_BadRound(t *testing.T) {
	// Build inputs
	chID := &id.ID{}
	chID[0] = 1

	r := rounds.Round{ID: 420, Timestamps: make(map[states.Round]time.Time)}
	r.Timestamps[states.QUEUED] = netTime.Now()

	rng := rand.New(rand.NewSource(42))
	pub, priv, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate ed25519 keypair, cant run test")
	}

	cm := &ChannelMessage{
		Lease:   int64(time.Hour),
		RoundID: 69, // Make the round not match
		Payload: []byte("blarg"),
	}

	cmSerial, err := proto.Marshal(cm)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	sig := ed25519.Sign(priv, cmSerial)
	ns := &mockNameService{validChMsg: true}

	um := &UserMessage{
		Message:      cmSerial,
		Signature:    sig,
		ECCPublicKey: pub,
	}

	umSerial, err := proto.Marshal(um)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	// Build the listener
	dummy := &triggerEventDummy{}

	al := userListener{
		chID:    chID,
		name:    ns,
		trigger: dummy.triggerEvent,
		checkSent: func(message.ID, rounds.Round) bool {
			return false
		},
	}

	// Call the listener
	mt := MessageType(42)
	al.Listen(umSerial, nil, nil, mt.Marshal(),
		receptionID.EphemeralIdentity{}, r)

	// Check the results
	if dummy.gotData {
		t.Fatalf("Data returned after invalid listen")
	}
}

// Tests that the message is rejected when the user message is malformed.
func Test_userListener_Listen_BadMessage(t *testing.T) {
	// Build inputs
	chID := &id.ID{}
	chID[0] = 1

	r := rounds.Round{ID: 420, Timestamps: make(map[states.Round]time.Time)}
	r.Timestamps[states.QUEUED] = netTime.Now()

	ns := &mockNameService{validChMsg: true}

	umSerial := []byte("malformed")

	// Build the listener
	dummy := &triggerEventDummy{}

	al := userListener{
		chID:    chID,
		name:    ns,
		trigger: dummy.triggerEvent,
		checkSent: func(message.ID, rounds.Round) bool {
			return false
		},
	}

	// Call the listener
	mt := MessageType(42)
	al.Listen(umSerial, nil, nil, mt.Marshal(),
		receptionID.EphemeralIdentity{}, r)

	// Check the results
	if dummy.gotData {
		t.Fatalf("Data returned after invalid listen")
	}
}

// Tests that a mention ping is suppressed when the sending user is muted on the
// channel and fires normally when they are not (XXN-422). The gate makes
// mention-ping suppression symmetric with the downstream message drop: the SAME
// mutedUsers set that CheckSpace uses to reject a muted user's message also gates
// the pre-fold mention ping. The message still reaches the trigger path here —
// only the ping is gated; the message drop itself is xxDK's, downstream in
// triggerEvent -> getHandler -> CheckSpace.
//
// This drives Listen directly, which is the only way to deliver a muted sender's
// message: SendGeneric (send.go) self-rejects a muted send, so an honest client
// cannot exercise this end to end (the bug is reachable only by a non-compliant
// sender). It therefore proves the gate LOGIC. The registerListeners WIRING
// (mutedUsers = m.events.mutedUsers) is covered by the live gate
// TestSmoke_LiveChannelMentionPing: the gate dereferences ul.mutedUsers on every
// received mention and has no nil-guard, so an unwired field would panic it — that
// gate passes (mentions classified), proving the field is wired non-nil.
func Test_userListener_Listen_mentionPingGatedByMute(t *testing.T) {
	// Build inputs
	chID := &id.ID{}
	chID[0] = 1

	r := rounds.Round{ID: 420, Timestamps: make(map[states.Round]time.Time)}
	r.Timestamps[states.QUEUED] = netTime.Now()

	rng := rand.New(rand.NewSource(42))

	// senderPub/senderPriv: the (to-be-muted) member; signs the UserMessage so
	// um.ECCPublicKey is the author key the gate checks.
	senderPub, senderPriv, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate sender keypair: %+v", err)
	}
	// victimPub: the local user (myKey); the message mentions them.
	victimPub, _, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate victim keypair: %+v", err)
	}

	cm := &ChannelMessage{
		Lease:   int64(time.Hour),
		RoundID: uint64(r.ID),
		Payload: []byte("hey @victim"),
	}
	cmSerial, err := proto.Marshal(cm)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	sig := ed25519.Sign(senderPriv, cmSerial)
	um := &UserMessage{
		Message:      cmSerial,
		Signature:    sig,
		ECCPublicKey: senderPub,
	}
	umSerial, err := proto.Marshal(um)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	// The matched SIH tags carry the victim's own mention tag — exactly what the
	// listener registers for myKey (see registerListeners / makeUserPingTags).
	tags := []string{makeUserPingTag(victimPub, MentionPing)}
	mt := MessageType(42)
	ns := &mockNameService{validChMsg: true}

	// buildListener mirrors registerListeners' field wiring: a ping-capturing
	// userListener over the given muted-user manager.
	buildListener := func(mum *mutedUserManager) (*userListener, *bool, *triggerEventDummy) {
		fired := false
		dummy := &triggerEventDummy{}
		ul := &userListener{
			chID:    chID,
			name:    ns,
			trigger: dummy.triggerEvent,
			checkSent: func(message.ID, rounds.Round) bool {
				return false
			},
			myKey: victimPub,
			pingCB: func(_ *id.ID, _ message.ID, pt PingType) {
				if pt == MentionPing {
					fired = true
				}
			},
			mutedUsers: mum,
		}
		return ul, &fired, dummy
	}

	// Case A — unmuted sender: the mention ping fires (happy path preserved).
	t.Run("unmuted_fires", func(t *testing.T) {
		mum := newMutedUserManager(versioned.NewKV(ekv.MakeMemstore()))
		ul, fired, _ := buildListener(mum)
		ul.Listen(umSerial, nil, tags, mt.Marshal(),
			receptionID.EphemeralIdentity{}, r)
		if !*fired {
			t.Fatal("mention ping did not fire for an unmuted sender")
		}
	})

	// Case B — muted sender: the mention ping is suppressed, but the message
	// still reaches the trigger path (only the ping is gated).
	t.Run("muted_suppressed", func(t *testing.T) {
		mum := newMutedUserManager(versioned.NewKV(ekv.MakeMemstore()))
		mum.muteUser(chID, senderPub)
		ul, fired, dummy := buildListener(mum)
		ul.Listen(umSerial, nil, tags, mt.Marshal(),
			receptionID.EphemeralIdentity{}, r)
		if *fired {
			t.Error("mention ping fired for a muted sender (XXN-422 gate failed)")
		}
		if !dummy.gotData {
			t.Error("muted sender's message did not reach the trigger path; " +
				"only the ping should be gated, not the whole listen path")
		}
	})
}

// Tests that the message is rejected when the sized broadcast is malformed.
func Test_userListener_Listen_BadSizedBroadcast(t *testing.T) {
	// Build inputs
	chID := &id.ID{}
	chID[0] = 1

	r := rounds.Round{ID: 420, Timestamps: make(map[states.Round]time.Time)}
	r.Timestamps[states.QUEUED] = netTime.Now()

	rng := rand.New(rand.NewSource(42))
	pub, priv, err := ed25519.GenerateKey(rng)
	if err != nil {
		t.Fatalf("failed to generate ed25519 keypair, cant run test")
	}

	cm := &ChannelMessage{
		Lease:   int64(time.Hour),
		RoundID: 69, // Make the round not match
		Payload: []byte("blarg"),
	}

	cmSerial, err := proto.Marshal(cm)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	sig := ed25519.Sign(priv, cmSerial)
	ns := &mockNameService{validChMsg: true}

	um := &UserMessage{
		Message:      cmSerial,
		Signature:    sig,
		ECCPublicKey: pub,
	}

	umSerial, err := proto.Marshal(um)
	if err != nil {
		t.Fatalf("Failed to marshal proto: %+v", err)
	}

	// Remove half the sized broadcast to make it malformed
	umSerial = umSerial[:len(umSerial)/2]

	// Build the listener
	dummy := &triggerEventDummy{}

	al := userListener{
		chID:    chID,
		name:    ns,
		trigger: dummy.triggerEvent,
		checkSent: func(message.ID, rounds.Round) bool {
			return false
		},
	}

	// Call the listener
	mt := MessageType(42)
	al.Listen(umSerial, nil, nil, mt.Marshal(),
		receptionID.EphemeralIdentity{}, r)

	// Check the results
	if dummy.gotData {
		t.Fatalf("Data returned after invalid listen")
	}
}
