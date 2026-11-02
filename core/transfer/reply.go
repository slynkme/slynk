package transfer

import (
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"slices"

	"github.com/pkg/errors"
)

// Replies between inboxes that stay quantum-safe
// (docs/findings/quantum-safety.md). A sender who includes their inbox in a
// quantum-safe notice ("Let them reply") gives the recipient, sealed with
// everything else, their reply keys for that recipient: a key, and a token
// that names it. The recipient can then answer to the sender's compact
// address, the only one a notice has room for, with
// HPKE's PSK mode (RFC 9180 section 5.1): DHKEM(X25519, HKDF-SHA256) to that
// address, the reply key as the pre-shared key and the token as its ID, with
// a compact notice's KDF and AEAD. Opening a reply takes both the inbox's
// X25519 key and the reply key, and the reply key has only ever travelled
// inside quantum-safe notices, so breaking X25519, as a quantum computer
// could, doesn't open it. RFC 9180 gives PSK mode that property, as long as
// the key isn't compromised (section 9.1.1), and notes it hasn't been proven
// against quantum attackers formally (9.1.3). A reply fills one message, as a
// compact notice does:
//
//	stream: key(32) token(8) sealed(plaintext)
//
// key is the one-time X25519 key, encoded with Elligator 2 as a compact
// notice's is. The token is hidden by a pad worked out from the KEM's shared
// secret (replyPad), so to anyone who can't work that out it's as random as
// the rest. Someone who could (who had broken X25519 for that reply, and
// knew the inbox's address) would see only that replies to an inbox with
// the same token come from the same sender: not who, nor what they say. The
// encoded key and the hidden token are the AEAD's associated data.
//
// An inbox works out its reply keys from its words (replyKeysFor), so it has
// nothing to keep: the token from the words and the recipient's ed25519 key,
// the key from the words and the token. So a reply's token gives its inbox
// the key to open it with, whoever sent it, and whether or not the inbox is
// kept on a device. Once open, a reply must say who sent it (noticeFrom,
// proved as any other), and its token must be the one this inbox gives them.
//
// A reply carries its sender's own reply keys too, as every quantum-safe
// notice including its sender's inbox does (noticeReplyKeys), so a
// conversation that began with a quantum-safe notice stays quantum-safe both
// ways, a single message at a time. A notice that doesn't include its
// sender's inbox never uses reply keys: the token would tell the owner who
// sent it.
//
// Keys: the reply root is worked out from the words with HKDF under its own
// label, apart from every other key, and never touches the inbox's X25519
// key, which does here only what it does for a compact notice (the same
// DHKEM decapsulation; another mode and info string make other keys: RFC 9180
// section 9.2.3 allows one key pair in several modes, though, as it says,
// with no formal proof). The pad is another KDF of the KEM's shared secret,
// under its own label. Nothing about a reply that doesn't open ever leaves
// the owner's page, so there's no oracle.
//
// The key is 32 bytes long, but it holds no more than the words' 128 bits,
// where RFC 9180 asks for 32 bytes of entropy (section 9.5). The RFC's
// worries are someone who knows the KEM's shared secret guessing the key
// offline, as a harvest-now-decrypt-later attacker would, and oracles that
// test many guesses at once. With no oracle, guessing costs about 2^128 tries
// (the RFC's own figure), or about 2^64 Grover iterations for a quantum
// computer: the same as for the words themselves, and so for everything in an
// inbox, its quantum-safe address included.
const (
	ReplyTokenLen = 8
	ReplyKeyLen   = 32
	// ReplyKeysLen is what reply keys take in a notice: the token, then the
	// key.
	ReplyKeysLen = ReplyTokenLen + ReplyKeyLen
	// replyOverhead is the encoded one-time key, the hidden token and the
	// AEAD's tag.
	replyOverhead = keyRepLen + ReplyTokenLen + 16

	inboxReplyInfo       = "slynk/inbox/v4/reply"
	inboxReplyTokenInfo  = "slynk/inbox/v4/reply-token"
	inboxReplyKeyInfo    = "slynk/inbox/v4/reply-key"
	inboxReplyNoticeInfo = "slynk/inbox/v4/reply-notice"
	inboxReplyPadInfo    = "slynk/inbox/v4/reply-pad"
)

// ErrReplyKeys means reply keys that can't be used: not ReplyKeysLen bytes, a
// key of zeros (what a wiped buffer holds, never a real key), or given for a
// notice that doesn't include its sender's inbox.
var ErrReplyKeys = errors.New("these reply keys can't be used")

// errReplyRefused is a reply that opened but can't be shown: it doesn't say
// who sent it, its sender doesn't prove out, or its token was given to
// another inbox. Having opened, it isn't half of a quantum-safe notice.
var errReplyRefused = errors.New("a reply that opened but was refused")

// ReplyKeys is what an inbox gives another, inside a quantum-safe notice, so
// that inbox can answer it quantum-safely: a token, and the key it names.
type ReplyKeys struct {
	Token [ReplyTokenLen]byte
	Key   [ReplyKeyLen]byte
}

// Bytes is the keys as a notice carries them, and an owner's page holds
// them: the token, then the key.
func (r *ReplyKeys) Bytes() []byte {
	return slices.Concat(r.Token[:], r.Key[:])
}

// ParseReplyKeys reads reply keys as Bytes gives them.
func ParseReplyKeys(b []byte) (*ReplyKeys, error) {
	if len(b) != ReplyKeysLen {
		return nil, ErrReplyKeys
	}
	r := &ReplyKeys{}
	copy(r.Token[:], b)
	copy(r.Key[:], b[ReplyTokenLen:])
	if r.Key == [ReplyKeyLen]byte{} {
		return nil, ErrReplyKeys
	}
	return r, nil
}

// MaxReplyBody is the most a reply sealed with reply keys can carry for a
// message of msgLen bytes.
func MaxReplyBody(msgLen int) int {
	return noticeStreamLen(msgLen) - replyOverhead - noticeHeaderLen
}

// replyKeysFor is what this inbox gives the inbox at to: a token from to's
// key, and the key the token names. Either of to's addresses gives the same,
// and the words always do.
func (k *InboxKey) replyKeysFor(to *InboxAddress) (*ReplyKeys, error) {
	t, err := hkdf.Expand(sha256.New, k.reply, inboxReplyTokenInfo+string(to.pub), ReplyTokenLen)
	if err != nil {
		return nil, err
	}
	r := &ReplyKeys{}
	copy(r.Token[:], t)
	if r.Key, err = k.replyKey(r.Token); err != nil {
		return nil, err
	}
	return r, nil
}

// replyKey is the key a token this inbox gives names.
func (k *InboxKey) replyKey(token [ReplyTokenLen]byte) (key [ReplyKeyLen]byte, err error) {
	b, err := hkdf.Expand(sha256.New, k.reply, inboxReplyKeyInfo+string(token[:]), ReplyKeyLen)
	if err != nil {
		return key, err
	}
	copy(key[:], b)
	return key, nil
}

// replyPad is what hides a reply's token: worked out from the KEM's shared
// secret, under its own label.
func replyPad(ss []byte) ([]byte, error) {
	return hkdf.Key(sha256.New, ss, nil, inboxReplyPadInfo, ReplyTokenLen)
}

// replyContext is a reply's AEAD and nonce: HPKE's PSK mode, from the KEM's
// shared secret, with the reply key as the pre-shared key and the token as
// its ID.
func replyContext(ss []byte, keys *ReplyKeys) (cipher.AEAD, []byte, error) {
	return hpkeContext(dhkemSuite, hpkeModePSK, ss, []byte(inboxReplyNoticeInfo), keys.Key[:], keys.Token[:])
}

// sealReply seals pt to the inbox at to (to its compact key, whichever
// address to is) with the reply keys it gave the sender, with a fresh
// one-time key encoded so it looks random, and gives the stream. prove, if
// given, finishes pt once the associated data is known.
func sealReply(to *InboxAddress, keys *ReplyKeys, pt []byte, prove func(aad []byte)) ([]byte, error) {
	pkR := to.xpub.Bytes()
	// About half of all X25519 keys can be encoded; one that can't is dropped,
	// never encoded another way.
	for range 128 {
		skE, err := ecdh.X25519().GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		enc := skE.PublicKey().Bytes()
		rep, ok, err := hideKey(enc)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		dh, err := skE.ECDH(to.xpub)
		if err != nil {
			return nil, err
		}
		ss, err := dhkemSecret(dh, enc, pkR)
		if err != nil {
			return nil, err
		}
		pad, err := replyPad(ss)
		if err != nil {
			return nil, err
		}
		hidden := make([]byte, ReplyTokenLen)
		subtle.XORBytes(hidden, keys.Token[:], pad)
		aead, nonce, err := replyContext(ss, keys)
		if err != nil {
			return nil, err
		}
		aad := slices.Concat(rep, hidden)
		if prove != nil {
			prove(aad)
		}
		return slices.Concat(aad, aead.Seal(nil, nonce, pt, aad)), nil
	}
	return nil, errors.New("couldn't encode a one-time key")
}

// openReply opens a message as a reply sealed with reply keys this inbox
// gave its sender (see the top).
func openReply(key *InboxKey, m *half) (opened, error) {
	dh := m.shared(key)
	if dh == nil || len(m.stream) < replyOverhead {
		return opened{}, errors.New("not a reply")
	}
	ss, err := dhkemSecret(dh, m.ctT, key.Address.xpub.Bytes())
	if err != nil {
		return opened{}, err
	}
	pad, err := replyPad(ss)
	if err != nil {
		return opened{}, err
	}
	aad := m.stream[:keyRepLen+ReplyTokenLen]
	keys := &ReplyKeys{}
	subtle.XORBytes(keys.Token[:], aad[keyRepLen:], pad)
	if keys.Key, err = key.replyKey(keys.Token); err != nil {
		return opened{}, err
	}
	aead, nonce, err := replyContext(ss, keys)
	if err != nil {
		return opened{}, err
	}
	pt, err := aead.Open(nil, nonce, m.stream[len(aad):], aad)
	if err != nil {
		return opened{}, err
	}
	o, err := readPlaintext(key, aad, pt, modeReply)
	if err != nil {
		return opened{}, errors.Wrap(errReplyRefused, err.Error())
	}
	// Only the inbox the token was given to may use it: a sender who has
	// someone else's reply keys can't answer with them.
	want, err := key.replyKeysFor(o.from)
	if err != nil {
		return opened{}, err
	}
	if want.Token != keys.Token {
		return opened{}, errors.Wrap(errReplyRefused, "a reply with a token given to another inbox")
	}
	o.quantum, o.reply = true, true
	return o, nil
}
