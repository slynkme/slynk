////////////////////////////////////////////////////////////////////////////////
// Copyright © 2022 xx foundation                                             //
//                                                                            //
// Use of this source code is governed by a license that can be found in the  //
// LICENSE file                                                               //
////////////////////////////////////////////////////////////////////////////////

package channels

import (
	"crypto/ed25519"
	"time"

	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/crypto/message"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/primitives/id"
)

// userListener adheres to the [broadcast.ListenerFunc] interface and is used
// when user messages are received on the channel.
type userListener struct {
	name      NameService
	chID      *id.ID
	trigger   triggerEventFunc
	checkSent messageReceiveFunc

	// myKey is the local user's public key and pingCB surfaces a matched
	// self-mention. When a received message's matched SIH tags include our own
	// mention tag, Listen fires pingCB so the UI layer can classify a mention
	// locally without the notification server (XXN-308). Both are nil on
	// listeners that do not surface pings.
	myKey  ed25519.PublicKey
	pingCB func(channelID *id.ID, messageID message.ID, pingType PingType)

	// mutedUsers gates the mention ping on the channel's muted set so an
	// admin-muted member cannot generate metadata-only mention-pings. It is the
	// SAME set that drops a muted user's message downstream (eventModel.go
	// triggerEvent -> getHandler -> CheckSpace), making ping suppression
	// symmetric with the message drop (XXN-422). It is a required dependency of
	// the ping path: set whenever pingCB is set (see registerListeners), so it
	// is non-nil exactly when a ping could fire.
	mutedUsers *mutedUserManager
}

// Listen is called when a message is received for the user listener.
func (ul *userListener) Listen(payload, encryptedPayload []byte, tags []string,
	metadata [2]byte, receptionID receptionID.EphemeralIdentity, round rounds.Round) {
	mt := UnmarshalMessageType(metadata)
	// Decode the message as a user message
	umi, err := unmarshalUserMessageInternal(payload, ul.chID, mt)
	if err != nil {
		jww.WARN.Printf("[CH] Failed to unmarshal User Message on channel %s "+
			"in round %d: %+v", ul.chID, round.ID, err)
		return
	}

	um := umi.GetUserMessage()
	cm := umi.GetChannelMessage()
	msgID := umi.GetMessageID()

	// Check if we sent the message and ignore triggering if we sent
	if ul.checkSent(msgID, round) {
		return
	}

	/* CRYPTOGRAPHICALLY RELEVANT CHECKS */

	// Check the round to ensure the message is not a replay
	if id.Round(cm.RoundID) != round.ID {
		jww.WARN.Printf("[CH] Message %s for channel %s referenced round %d, "+
			"but the message was found on round %d",
			msgID, ul.chID, cm.RoundID, round.ID)
		return
	}

	// Check that the user properly signed the message
	if !ed25519.Verify(um.ECCPublicKey, um.Message, um.Signature) {
		jww.WARN.Printf("[CH] Message %s on channel %s purportedly from %s "+
			"failed its user signature with signature %x",
			msgID, ul.chID, cm.Nickname, um.Signature)
		return
	}

	// Self-mention ping (XXN-308): if the sender tagged us, our own mention tag
	// is among the matched SIH tags. Surface it via pingCB so the UI layer can
	// classify a mention locally (the EventModel receive path carries no tags).
	// An EXACT-string match against our own mention tag — not mere bloom presence
	// — rules out the compressed SIH's ~1/2^26 false positive. Fired only after
	// the round + signature checks above, so a ping is always authenticated. Our
	// own posts already returned at checkSent, so a self-mention never fires.
	//
	// Gated on the channel's muted set (XXN-422): a muted member's message is
	// dropped downstream (triggerEvent -> getHandler -> CheckSpace), so its
	// mention ping must be suppressed here too — otherwise a muted member could
	// keep notification-spamming a victim with metadata-only pings, defeating the
	// channel's only abuse control. isMuted is evaluated only when a ping would
	// otherwise be considered (pingCB and myKey set).
	if ul.pingCB != nil && ul.myKey != nil &&
		!ul.mutedUsers.isMuted(ul.chID, um.ECCPublicKey) {
		mentionTag := makeUserPingTag(ul.myKey, MentionPing)
		for _, tag := range tags {
			if tag == mentionTag {
				ul.pingCB(ul.chID, msgID, MentionPing)
				break
			}
		}
	}

	// Replace the timestamp on the message if it is outside the allowable range
	ts := message.VetTimestamp(
		time.Unix(0, cm.LocalTimestamp), round.Timestamps[states.QUEUED], msgID)

	// Submit the message to the event model for listening
	uuid, err := ul.trigger(
		ul.chID, umi, encryptedPayload, ts, receptionID,
		round, Delivered)
	if err != nil {
		jww.WARN.Printf(
			"[CH] Error in passing off trigger for message (UUID: %d): %+v",
			uuid, err)
	}

	return
}
