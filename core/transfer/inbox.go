package transfer

import (
	"bytes"
	"compress/flate"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/hpke"
	"crypto/mlkem"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"io"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"filippo.io/edwards25519"
	"github.com/pkg/errors"
	jww "github.com/spf13/jwalterweatherman"
	"gitlab.com/elixxir/client/v4/cmix"
	"gitlab.com/elixxir/client/v4/cmix/identity"
	"gitlab.com/elixxir/client/v4/cmix/identity/receptionID"
	"gitlab.com/elixxir/client/v4/cmix/rounds"
	"gitlab.com/elixxir/primitives/format"
	"gitlab.com/elixxir/primitives/states"
	"gitlab.com/xx_network/crypto/mnemonic"
	"gitlab.com/xx_network/primitives/id"
	"golang.org/x/crypto/blake2b"
)

// An inbox is a long-lived address that anyone can drop a message to. Its
// owner holds a 12-word phrase (128 random bits); everything else is derived
// from it. Every inbox has two public addresses: a compact
// one, a version byte and the inbox's ed25519 key, and a quantum-safe one,
// which adds an ML-KEM-768 key (inbox4.go). Both lead to the same mailbox, a
// cMix reception ID hashed from the ed25519 key. A sender seals a
// fixed-size notice to the address (HPKE) and sends it to the mailbox. The
// owner tracks that mailbox ID with history and opens what it can: the mixnet
// is the mailbox, and nothing is stored anywhere else.
//
//	compact address:      version(3) ed25519PublicKey(32)
//	quantum-safe address: version(4) ed25519PublicKey(32) mlkem768Key(1184) signature(64)
//
// A notice fills whole cMix messages: their contents and, as xx's DMs do,
// the 31 free bytes of each one's key fingerprint and MAC fields (their first
// bytes stay random, with the top bit the network needs clear). Read in that
// order (fingerprint, MAC, contents), each message gives one stream of
// noticeStreamLen bytes:
//
//	compact (one message):       key(32) sealed(plaintext)
//	quantum-safe (two messages): key(32) kem(1252) sealed(plaintext), cut in
//	                             two, the second starting with tag(8)
//	reply (one message):         key(32) token(8) sealed(plaintext)
//	plaintext: version(1) kind(1) bodyLen(2) round(4) id(8) body zeros
//
// key is HPKE's one-time X25519 key, encoded with Elligator 2 (elligator.go),
// and kem, in a quantum-safe notice, ML-KEM-768's ciphertext encoded with
// Kemeleon (kemeleon.go); tag pairs its two messages (inbox4.go). A reply,
// sent with reply keys an inbox gave in a quantum-safe notice, is
// quantum-safe in one message (reply.go); its token is
// hidden. All of them are the AEAD's associated data. Every byte of every
// message looks random, so a notice's contents can't be told apart from a
// cover message's.
//
// round is the cMix round the notice went in (its low 32 bits). It's sealed
// as the notice is sent: xxDK asks for the message again, with the new round,
// whenever it tries another one. The owner drops a notice that arrives in
// any other round, so an old notice someone copies and sends again is never
// shown. id is random, the same for every try at sending one notice, so a
// try that arrived after all, followed by one that also did, shows once.
//
// A sender who has their own inbox open may include it, so the owner can
// reply. The kind then carries noticeFrom, and the body
// starts with their compact address, the name they chose to show (if any)
// and a proof that the address is theirs, before what the kind says:
//
//	body:  fromAddress(33) nameLen(1) name proof(32) [replyKeys(40)] rest
//	proof: HMAC-SHA256(fromKey, keys || plaintext up to the proof || rest)
//
// keys is the associated data (the encoded key; kem and tag too, for a
// quantum-safe notice, and the hidden token for a reply). fromKey comes from
// X25519 between the sender's inbox key and the recipient's (fromKey, below).
// Only those two inboxes can make the proof, so it convinces the recipient,
// who knows they didn't; but the recipient could have made it, so it proves
// nothing to anyone else, unlike a signature. It's sealed with the rest, so
// the network learns nothing new. A quantum-safe notice (to a quantum-safe
// address, or a reply) including its sender's inbox also carries their reply
// keys for the recipient (noticeReplyKeys, reply.go), covered by the proof,
// so the recipient's answer can be quantum-safe too; a compact notice never
// does.
//
// NoticeDeflate on a text notice says rest is the text compressed with raw
// DEFLATE (RFC 1951; Haven compresses its messages with zlib's wrapped form
// of it). Every notice is
// padded to the same size, so compression changes nothing anyone can see.
const (
	// inboxAddressVersion follows the link versions (1 and 2) so one byte
	// tells a fragment's kind.
	inboxAddressVersion = 3
	InboxAddressLen     = 1 + ed25519.PublicKeySize

	inboxEntropyLen = 16 // 12 words
	noticeVersion   = 2
	noticeHeaderLen = 16
	noticeIDLen     = 8
	// hpkeOverhead is the encoded one-time key plus the AEAD tag.
	hpkeOverhead = keyRepLen + 16
	// spareLen is what a message's key fingerprint and MAC fields add to its
	// contents: all of each but the first byte.
	spareLen = format.KeyFPLen - 1 + format.MacLen - 1

	// NoticeText carries the body only; NoticeLink starts the body with a
	// v1 link to an upload, followed by any text.
	NoticeText = 1
	NoticeLink = 2
	// NoticeDeflate, added to NoticeText, says the text is compressed.
	NoticeDeflate = 0x40
	// noticeFrom, added to a kind, says the sender included their own inbox,
	// and noticeReplyKeys, added to that in a quantum-safe notice, that their
	// reply keys follow its proof (reply.go).
	noticeFrom      = 0x80
	noticeReplyKeys = 0x20

	// MaxNoticeText is the most a compressed text may stand for, in bytes of
	// UTF-8, so a small notice can't make the owner's page unpack a flood.
	MaxNoticeText = 8192

	// MaxFromName is the most a name to show can take, in bytes of UTF-8:
	// the page allows 40 characters, which this fits in any script.
	MaxFromName  = 160
	fromProofLen = sha256.Size

	inboxKeyInfo     = "slynk/inbox/v1/ed25519"
	inboxMailboxInfo = "slynk/inbox/v1/mailbox"
	inboxNoticeInfo  = "slynk/inbox/v1/notice"
	inboxFromInfo    = "slynk/inbox/v1/from"
	inboxIDInfo      = "slynk/inbox/v2/id"
	// inboxStoreInfo labels the secret the owner's page keeps the inbox on
	// their device with, when they ask it to: its own
	// label, so it's no use for anything else.
	inboxStoreInfo = "slynk/inbox/v1/store"
	// InboxStoreLen is that secret's length: an AES-256 key and a 16-byte
	// name for the device's record.
	InboxStoreLen = 48

	noticeRoundTimeout = time.Minute

	// A notice announcing an upload waits uploadNoticeMin to uploadNoticeMax
	// after the upload's last piece, so the two
	// don't sit side by side in the network's rounds: they come from
	// separate identities, but the same internet address.
	uploadNoticeMin = time.Minute
	uploadNoticeMax = 3 * time.Minute
)

var (
	ErrInboxAddress      = errors.New("this isn't a valid inbox address")
	ErrInboxPhrase       = errors.New("those words aren't a valid inbox key: check each word and their order")
	ErrNoticeSize        = errors.New("this is too long to send to an inbox")
	ErrNoticeUnconfirmed = errors.New("the network didn't confirm delivery: it may or may not have arrived")
	ErrNoticeFailed      = errors.New("the network didn't deliver the message: try again")
	ErrFromName          = errors.New("the name to show is too long, or isn't text")

	noticeKDF  = hpke.HKDFSHA256()
	noticeAEAD = hpke.ChaCha20Poly1305()
)

// InboxAddress is one of an inbox's public addresses: safe to publish, and
// enough to send to it.
type InboxAddress struct {
	pub     ed25519.PublicKey
	xpub    *ecdh.PublicKey
	mailbox *id.ID
	// ek is a quantum-safe address's ML-KEM-768 key, sig the inbox's
	// signature on it, and pk4 the X-Wing key made of ek and xpub; all nil
	// for a compact address.
	ek  *mlkem.EncapsulationKey768
	sig []byte
	pk4 hpke.PublicKey
}

// InboxKey is an inbox's private half, derived from its 12 words.
type InboxKey struct {
	// Address is the inbox's compact address, and Address4 its quantum-safe
	// one: the same inbox and mailbox.
	Address  *InboxAddress
	Address4 *InboxAddress
	xpriv    *ecdh.PrivateKey
	sk4      hpke.PrivateKey
	store    []byte
	reply    []byte // what its reply keys are worked out from (reply.go)
}

// StoreSecret is the secret the owner's page encrypts and names what it
// keeps of this inbox on their device with: InboxStoreLen bytes, worked out
// from the words alone.
func (k *InboxKey) StoreSecret() []byte { return bytes.Clone(k.store) }

// NewInboxPhrase makes a new inbox key and returns its 12 words.
func NewInboxPhrase() (string, error) {
	entropy := make([]byte, inboxEntropyLen)
	if _, err := rand.Read(entropy); err != nil {
		return "", err
	}
	return encodePhrase(entropy)
}

func encodePhrase(entropy []byte) (string, error) {
	if len(entropy) != inboxEntropyLen {
		return "", ErrInboxPhrase
	}
	return mnemonic.EncodeMnemonic(entropy)
}

// InboxKeyFromPhrase checks the words (including their checksum) and derives
// the inbox key. Case and spacing don't matter.
func InboxKeyFromPhrase(phrase string) (*InboxKey, error) {
	words := strings.Fields(strings.ToLower(phrase))
	entropy, err := mnemonic.DecodeMnemonic(strings.Join(words, " "))
	if err != nil || len(entropy) != inboxEntropyLen {
		return nil, ErrInboxPhrase
	}
	return inboxKeyFromEntropy(entropy)
}

func inboxKeyFromEntropy(entropy []byte) (*InboxKey, error) {
	seed, err := hkdf.Key(sha256.New, entropy, nil, inboxKeyInfo, ed25519.SeedSize)
	if err != nil {
		return nil, err
	}
	priv := ed25519.NewKeyFromSeed(seed)
	// The X25519 private key is the clamped ed25519 scalar (RFC 8032 5.1.5;
	// X25519 does the clamping), so its public key is the Montgomery form of
	// the ed25519 public key that senders convert.
	h := sha512.Sum512(seed)
	xpriv, err := ecdh.X25519().NewPrivateKey(h[:32])
	if err != nil {
		return nil, err
	}
	addr, err := newInboxAddress(priv.Public().(ed25519.PublicKey))
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(addr.xpub.Bytes(), xpriv.PublicKey().Bytes()) {
		return nil, errors.New("inbox key derivation is inconsistent")
	}
	addr4, sk4, err := inboxKey4(entropy, priv, addr, xpriv)
	if err != nil {
		return nil, err
	}
	store, err := hkdf.Key(sha256.New, entropy, nil, inboxStoreInfo, InboxStoreLen)
	if err != nil {
		return nil, err
	}
	reply, err := hkdf.Key(sha256.New, entropy, nil, inboxReplyInfo, sha256.Size)
	if err != nil {
		return nil, err
	}
	return &InboxKey{Address: addr, Address4: addr4, xpriv: xpriv, sk4: sk4, store: store, reply: reply}, nil
}

// ParseInboxAddress validates a binary address of either kind, as carried in
// a fragment. Addresses come from anyone, so every check here guards the
// sender.
func ParseInboxAddress(b []byte) (*InboxAddress, error) {
	switch {
	case len(b) == InboxAddressLen && b[0] == inboxAddressVersion:
		return newInboxAddress(ed25519.PublicKey(bytes.Clone(b[1:])))
	case len(b) == InboxAddress4Len && b[0] == inboxAddress4Version:
		return parseInboxAddress4(b)
	}
	return nil, ErrInboxAddress
}

func newInboxAddress(pub ed25519.PublicKey) (*InboxAddress, error) {
	// SetBytes rejects encodings that aren't a curve point but accepts
	// non-canonical ones, which would give one point several addresses.
	// (Other points share one X25519 key, the point's negative and those
	// plus a small-order point, so a key still has a few addresses, each with
	// its own mailbox: harmless, since only the key's holder reads any of
	// them, and a mistyped or altered address simply goes unread.) Points of
	// small order would make every sender's shared secret predictable.
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil || !bytes.Equal(p.Bytes(), pub) {
		return nil, ErrInboxAddress
	}
	if new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) == 1 {
		return nil, ErrInboxAddress
	}
	xpub, err := ecdh.X25519().NewPublicKey(p.BytesMontgomery())
	if err != nil {
		return nil, ErrInboxAddress
	}
	return &InboxAddress{pub: pub, xpub: xpub, mailbox: inboxMailboxID(pub)}, nil
}

// inboxMailboxID is the cMix reception ID notices are sent to. It has its own
// namespace, so an inbox key used elsewhere (e.g. as an xx DM identity) gets a
// different mailbox.
func inboxMailboxID(pub ed25519.PublicKey) *id.ID {
	h := blake2b.Sum256(append([]byte(inboxMailboxInfo), pub...))
	var mailbox id.ID
	copy(mailbox[:], h[:])
	mailbox.SetType(id.User)
	return &mailbox
}

// Bytes is the binary address, for a link fragment or QR code.
func (a *InboxAddress) Bytes() []byte {
	b := append([]byte{inboxAddressVersion}, a.pub...)
	if a.ek != nil {
		b[0] = inboxAddress4Version
		b = append(append(b, a.ek.Bytes()...), a.sig...)
	}
	return b
}

// QuantumSafe reports whether this is an inbox's quantum-safe address.
func (a *InboxAddress) QuantumSafe() bool { return a.ek != nil }

// Compact is the compact address of the same inbox. Anyone holding the
// quantum-safe address can work it out, and what's sent to it is sealed the
// classical way.
func (a *InboxAddress) Compact() *InboxAddress {
	if a.ek == nil {
		return a
	}
	return &InboxAddress{pub: a.pub, xpub: a.xpub, mailbox: a.mailbox}
}

// noticeStreamLen is how much of a cMix message of msgLen bytes of contents
// a notice fills.
func noticeStreamLen(msgLen int) int { return msgLen + spareLen }

// MaxNoticeBody is the most a compact notice can carry for a message of
// msgLen bytes.
func MaxNoticeBody(msgLen int) int {
	return noticeStreamLen(msgLen) - hpkeOverhead - noticeHeaderLen
}

// MaxBody is the most a notice to this address can carry for messages of
// msgLen bytes: one message's worth for a compact address, two less the
// bigger seal for a quantum-safe one.
func (a *InboxAddress) MaxBody(msgLen int) int { return modeOf(a, nil).maxBody(msgLen) }

// pieces is how many cMix messages a notice to this address fills.
func (a *InboxAddress) pieces() int { return modeOf(a, nil).pieces() }

// sealMode is how a notice is sealed: to a compact address, to a
// quantum-safe one, or as a reply with reply keys the recipient
// gave.
type sealMode int

const (
	modeCompact sealMode = iota
	modeQS
	modeReply
)

func modeOf(to *InboxAddress, reply *ReplyKeys) sealMode {
	switch {
	case reply != nil:
		return modeReply
	case to.ek != nil:
		return modeQS
	}
	return modeCompact
}

// quantumSafe is whether notices sealed this way stay closed even to someone
// who can break X25519.
func (m sealMode) quantumSafe() bool { return m != modeCompact }

// pieces is how many cMix messages a notice sealed this way fills.
func (m sealMode) pieces() int {
	if m == modeQS {
		return pieces4
	}
	return 1
}

// maxBody is the most a notice sealed this way carries, for messages of
// msgLen bytes.
func (m sealMode) maxBody(msgLen int) int {
	switch m {
	case modeQS:
		return MaxNoticeBody4(msgLen)
	case modeReply:
		return MaxReplyBody(msgLen)
	}
	return MaxNoticeBody(msgLen)
}

// plaintextLen is the size of the plaintext a notice sealed this way fills,
// for streams of streamLen bytes.
func (m sealMode) plaintextLen(streamLen int) int {
	switch m {
	case modeQS:
		return plaintext4Len(streamLen)
	case modeReply:
		return streamLen - replyOverhead
	}
	return streamLen - hpkeOverhead
}

// FromOverhead is how much of a notice's body including the sender's inbox
// takes, with a name of nameLen bytes. A quantum-safe notice's takes
// ReplyKeysLen more, for the sender's reply keys (fromOverhead).
func FromOverhead(nameLen int) int {
	return InboxAddressLen + 1 + nameLen + fromProofLen
}

// fromOverhead is FromOverhead for a notice sealed this way.
func (m sealMode) fromOverhead(nameLen int) int {
	if m.quantumSafe() {
		return FromOverhead(nameLen) + ReplyKeysLen
	}
	return FromOverhead(nameLen)
}

// From is the sender's own inbox, included so its owner can reply: its key
// (the sender has its words) and the name they chose to show, if any. Its
// compact address goes; in a quantum-safe notice, its reply keys for the
// recipient go too, so the reply can be quantum-safe as well (reply.go).
type From struct {
	Key  *InboxKey
	Name string
}

// validateNotice checks a notice's kind and body, on both sides, so nothing
// is sent that the owner would discard. It gives the body as the owner sees
// it: unpacked, if it was compressed.
func validateNotice(kind byte, body []byte) ([]byte, error) {
	switch kind {
	case NoticeText:
		return body, nil
	case NoticeText | NoticeDeflate:
		return inflateText(body)
	case NoticeLink:
		if len(body) < linkLen || body[0] != linkVersion1 {
			return nil, errors.New("malformed notice link")
		}
		return body, nil
	}
	return nil, errors.Errorf("unknown notice kind %d", kind)
}

// inflateText unpacks a compressed text, refusing anything that isn't
// whole, valid DEFLATE, that has bytes after its end, or that would unpack to
// more than MaxNoticeText.
func inflateText(body []byte) ([]byte, error) {
	// flate reads a bytes.Reader byte by byte (it's an io.ByteReader), never
	// past the stream's last byte, so what's left is what follows the end.
	br := bytes.NewReader(body)
	r := flate.NewReader(br)
	defer r.Close()
	text, err := io.ReadAll(io.LimitReader(r, MaxNoticeText+1))
	if err != nil {
		return nil, errors.Wrap(err, "malformed compressed text")
	}
	if len(text) > MaxNoticeText {
		return nil, ErrNoticeSize
	}
	if br.Len() != 0 {
		return nil, errors.New("malformed compressed text: bytes after its end")
	}
	return text, nil
}

// noticeSealer seals one notice for the round it's about to be sent in,
// giving the streams of its messages: one for a compact address, two for a
// quantum-safe one.
type noticeSealer func(round uint32) ([][]byte, error)

// newNoticeSealer checks a notice and gets ready to seal it to the inbox,
// padded to fill its messages exactly, so every notice of a kind is the same
// size. With from, the body starts with the sender's inbox and its proof (see
// the top), and in a quantum-safe notice their reply keys. With reply, the
// reply keys the inbox at to gave the sender, it's sealed as a reply
// (reply.go), which must include the sender's inbox. Every seal it makes
// carries the same random id.
func newNoticeSealer(to *InboxAddress, kind byte, body []byte, from *From, reply *ReplyKeys, msgLen int) (noticeSealer, error) {
	if _, err := validateNotice(kind, body); err != nil {
		return nil, err
	}
	mode := modeOf(to, reply)
	if mode == modeReply && from == nil {
		return nil, ErrReplyKeys
	}
	var name, keys []byte
	full := len(body)
	if from != nil {
		name = []byte(from.Name)
		if len(name) > MaxFromName || !utf8.Valid(name) {
			return nil, ErrFromName
		}
		kind |= noticeFrom
		full += mode.fromOverhead(len(name))
		if mode.quantumSafe() {
			r, err := from.Key.replyKeysFor(to)
			if err != nil {
				return nil, err
			}
			keys = r.Bytes()
			kind |= noticeReplyKeys
		}
	}
	if full > mode.maxBody(msgLen) {
		return nil, ErrNoticeSize
	}
	var key []byte
	if from != nil {
		var err error
		if key, err = fromKey(from.Key.xpriv, to.xpub, from.Key.Address, to); err != nil {
			return nil, err
		}
	}
	nid := make([]byte, noticeIDLen)
	if _, err := rand.Read(nid); err != nil {
		return nil, err
	}
	streamLen := noticeStreamLen(msgLen)
	return func(round uint32) ([][]byte, error) {
		pt := make([]byte, mode.plaintextLen(streamLen))
		pt[0] = noticeVersion
		pt[1] = kind
		binary.BigEndian.PutUint16(pt[2:4], uint16(full))
		binary.BigEndian.PutUint32(pt[4:8], round)
		copy(pt[8:noticeHeaderLen], nid)
		var prove func(keys []byte)
		if from == nil {
			copy(pt[noticeHeaderLen:], body)
		} else {
			at := noticeHeaderLen
			at += copy(pt[at:], from.Key.Address.Bytes())
			pt[at] = byte(len(name))
			at++
			at += copy(pt[at:], name)
			proofAt := at
			at += fromProofLen
			at += copy(pt[at:], keys)
			copy(pt[at:], body)
			prove = func(keys []byte) {
				copy(pt[proofAt:], fromProof(key, keys, pt, proofAt, noticeHeaderLen+full))
			}
		}
		var sealed []byte
		var err error
		switch mode {
		case modeQS:
			return sealPlaintext4(to, pt, prove, streamLen)
		case modeReply:
			sealed, err = sealReply(to, reply, pt, prove)
		default:
			sealed, err = sealPlaintext(to, pt, prove)
		}
		if err != nil {
			return nil, err
		}
		if len(sealed) != streamLen {
			return nil, errors.Errorf("sealed notice is %d bytes, need %d", len(sealed), streamLen)
		}
		return [][]byte{sealed}, nil
	}, nil
}

// fromKey is what proofs between two inboxes are made with: worked out from
// X25519 of one's private key and the other's public key, so only those two
// can, and specific to which one is the sender. crypto/ecdh refuses the
// all-zero result a crafted key could force. Either of an inbox's addresses
// gives the same key.
func fromKey(priv *ecdh.PrivateKey, pub *ecdh.PublicKey, from, to *InboxAddress) ([]byte, error) {
	shared, err := priv.ECDH(pub)
	if err != nil {
		return nil, err
	}
	info := inboxFromInfo + string(from.pub) + string(to.pub)
	return hkdf.Key(sha256.New, shared, nil, info, sha256.Size)
}

// fromProof is the proof for a plaintext whose proof sits at proofAt and
// whose body ends at end, sealed with the encoded keys: it covers them, so it
// can't be moved to another notice, and everything in the header and body
// but itself.
func fromProof(key, keys, pt []byte, proofAt, end int) []byte {
	m := hmac.New(sha256.New, key)
	m.Write(keys)
	m.Write(pt[:proofAt])
	m.Write(pt[proofAt+fromProofLen : end])
	return m.Sum(nil)
}

// sealPlaintext seals pt to the inbox's compact address with a fresh
// one-time key, encoded so it looks random. The encoded key is the AEAD's
// associated data: the same key has other encodings, and a notice re-encoded
// by someone else mustn't open as a different message. prove, if given,
// finishes pt once the encoded key is known.
func sealPlaintext(to *InboxAddress, pt []byte, prove func(keys []byte)) ([]byte, error) {
	pk, err := hpke.NewDHKEMPublicKey(to.xpub)
	if err != nil {
		return nil, err
	}
	// Each try fails with probability about 1/2.
	for range 128 {
		enc, s, err := hpke.NewSender(pk, noticeKDF, noticeAEAD, []byte(inboxNoticeInfo))
		if err != nil {
			return nil, err
		}
		rep, ok, err := hideKey(enc)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		if prove != nil {
			prove(rep)
		}
		ct, err := s.Seal(rep, pt)
		if err != nil {
			return nil, err
		}
		return append(rep, ct...), nil
	}
	return nil, errors.New("couldn't encode a one-time key")
}

// openSealedWith reverses sealPlaintext, with the one-time key already
// revealed.
func openSealedWith(key *InboxKey, sealed, enc []byte) ([]byte, error) {
	if len(sealed) < hpkeOverhead || enc == nil {
		return nil, errors.New("not a notice")
	}
	rep := sealed[:keyRepLen]
	sk, err := hpke.NewDHKEMPrivateKey(key.xpriv)
	if err != nil {
		return nil, err
	}
	r, err := hpke.NewRecipient(enc, sk, noticeKDF, noticeAEAD, []byte(inboxNoticeInfo))
	if err != nil {
		return nil, err
	}
	return r.Open(rep, sealed[keyRepLen:])
}

// opened is what a notice says.
type opened struct {
	kind      byte // NoticeText or NoticeLink
	body      []byte
	round     uint32 // the round it was sealed for
	id        [noticeIDLen]byte
	quantum   bool          // sent to the quantum-safe address, or as a reply
	reply     bool          // sent as a reply, with reply keys this inbox gave
	from      *InboxAddress // the sender's inbox, proved, if they included it
	name      string        // the name they chose to show with it, as sent
	replyKeys *ReplyKeys    // the sender's reply keys for this inbox, if they gave them
}

// openCompact opens a message as a compact notice. Most messages at an
// inbox's mailbox belong to other people who share its short-lived network
// label, or are half of a quantum-safe notice, so failing to open is normal.
func openCompact(key *InboxKey, m *half) (opened, error) {
	pt, err := openSealedWith(key, m.stream, m.ctT)
	if err != nil {
		return opened{}, err
	}
	return readPlaintext(key, m.stream[:keyRepLen], pt, modeCompact)
}

// readPlaintext reads an opened notice sealed with the encoded keys, the way
// mode says. A notice whose sender's inbox doesn't prove out is refused
// whole: anyone can seal to an inbox and claim any address. So is a reply
// that doesn't say who sent it, and reply keys anywhere but in a
// quantum-safe notice including its sender's inbox.
func readPlaintext(key *InboxKey, keys, pt []byte, mode sealMode) (opened, error) {
	if len(pt) < noticeHeaderLen || pt[0] != noticeVersion {
		return opened{}, errors.New("unknown notice version")
	}
	end := noticeHeaderLen + int(binary.BigEndian.Uint16(pt[2:4]))
	if end > len(pt) || len(bytes.Trim(pt[end:], "\x00")) != 0 {
		return opened{}, errors.New("malformed notice")
	}
	n := opened{kind: pt[1], round: binary.BigEndian.Uint32(pt[4:8])}
	copy(n.id[:], pt[8:noticeHeaderLen])
	rest := pt[noticeHeaderLen:end]
	if mode == modeReply && n.kind&noticeFrom == 0 {
		return opened{}, errors.New("a reply that doesn't say who sent it")
	}
	if n.kind&noticeReplyKeys != 0 && (!mode.quantumSafe() || n.kind&noticeFrom == 0) {
		return opened{}, errors.New("reply keys where there can't be any")
	}
	if n.kind&noticeFrom != 0 {
		n.kind &^= noticeFrom
		var err error
		if n.from, n.name, rest, err = checkFrom(key, keys, pt, end); err != nil {
			return opened{}, err
		}
		if n.kind&noticeReplyKeys != 0 {
			n.kind &^= noticeReplyKeys
			if len(rest) < ReplyKeysLen {
				return opened{}, errors.New("malformed reply keys")
			}
			if n.replyKeys, err = ParseReplyKeys(rest[:ReplyKeysLen]); err != nil {
				return opened{}, err
			}
			rest = rest[ReplyKeysLen:]
		}
	}
	body, err := validateNotice(n.kind, rest)
	if err != nil {
		return opened{}, err
	}
	n.kind &^= NoticeDeflate
	n.body = bytes.Clone(body)
	return n, nil
}

// checkFrom reads the sender's inbox from a plaintext whose body ends at end
// and checks its proof, giving the inbox, its name and what follows.
func checkFrom(key *InboxKey, keys, pt []byte, end int) (*InboxAddress, string, []byte, error) {
	body := pt[noticeHeaderLen:end]
	if len(body) < FromOverhead(0) {
		return nil, "", nil, errors.New("malformed sender")
	}
	from, err := ParseInboxAddress(body[:InboxAddressLen])
	if err != nil {
		return nil, "", nil, err
	}
	nameLen := int(body[InboxAddressLen])
	if nameLen > MaxFromName || len(body) < FromOverhead(nameLen) {
		return nil, "", nil, errors.New("malformed sender")
	}
	name := body[InboxAddressLen+1 : InboxAddressLen+1+nameLen]
	if !utf8.Valid(name) {
		return nil, "", nil, ErrFromName
	}
	proofAt := noticeHeaderLen + InboxAddressLen + 1 + nameLen
	k, err := fromKey(key.xpriv, from.xpub, from, key.Address)
	if err != nil {
		return nil, "", nil, err
	}
	if !hmac.Equal(pt[proofAt:proofAt+fromProofLen], fromProof(k, keys, pt, proofAt, end)) {
		return nil, "", nil, errors.New("the sender's inbox doesn't prove out")
	}
	return from, string(name), pt[proofAt+fromProofLen : end], nil
}

// messageStream is the stream a notice's message carries (see the top).
func messageStream(msg format.Message) []byte {
	fp := msg.GetKeyFP()
	stream := append(bytes.Clone(fp[1:]), msg.GetMac()[1:]...)
	return append(stream, msg.GetContents()...)
}

// splitStream is messageStream's inverse: the fields a stream fills for
// messages of msgLen bytes of contents, with the fingerprint's and MAC's
// first bytes random (their top bits must be 0).
func splitStream(stream []byte, msgLen int) (fp format.Fingerprint, mac, contents []byte, err error) {
	if len(stream) != noticeStreamLen(msgLen) {
		return fp, nil, nil, errors.Errorf("stream is %d bytes, need %d", len(stream), noticeStreamLen(msgLen))
	}
	var first [2]byte
	if _, err = rand.Read(first[:]); err != nil {
		return fp, nil, nil, err
	}
	fp[0] = first[0] & 0x7f
	n := copy(fp[1:], stream)
	mac = make([]byte, format.MacLen)
	mac[0] = first[1] & 0x7f
	n += copy(mac[1:], stream[n:])
	return fp, mac, bytes.Clone(stream[n:]), nil
}

// SendNotice seals a message to an inbox and sends it, returning once it
// has been delivered: one cMix message for a compact address or a reply,
// two for a quantum-safe address, in the same round or, with Apart, a few
// seconds apart (apart.go). The sender never tracks the mailbox: that would
// tie their IP address to the inbox. So "delivered" means the network
// accepted it, not that anyone has read it. ErrNoticeUnconfirmed means the
// round's outcome is unknown; sending again may deliver a second copy.
//
// It goes on the beat of cover messages: with cover on, in place of a blank
// message at the loop's next beat; with it off, after a pause as long as a
// gap between cover bursts. Either way it never goes the moment it's asked
// for, nor among the first messages after connecting. progress hears
// "waiting" until then, and "apart" once the first of a notice sent apart
// has been delivered. from, if not nil, includes the sender's own inbox.
func (c *Client) SendNotice(to *InboxAddress, kind byte, body []byte, from *From, reply *ReplyKeys, progress Progress) (sent time.Time, err error) {
	return c.SendNoticeAt(to, kind, body, from, reply, NoticeTiming{AtRandom: true}, progress)
}

// NoticeTiming is when a notice's messages go.
type NoticeTiming struct {
	// AtRandom waits for the beat of cover messages (or a gap's length
	// without them), so the moment it goes says less about when its sender
	// pressed Send; otherwise it goes now (an
	// opt-in setting, off by default).
	AtRandom bool
	// Apart sends a quantum-safe notice's two messages one at a time, each
	// in a round of its own (2026-10-18: first an opt-in
	// setting; slynk.me's page always asks for it since 2026-10-19;
	// apart.go). On the beat of cover messages, each takes a blank message's
	// place.
	Apart bool
}

// SendNoticeAt is SendNotice, choosing when it goes. reply, if not nil, is
// the reply keys the inbox at to gave the inbox in from: the notice is then
// sealed as a reply, quantum-safe in one message (reply.go).
func (c *Client) SendNoticeAt(to *InboxAddress, kind byte, body []byte, from *From, reply *ReplyKeys, when NoticeTiming, progress Progress) (sent time.Time, err error) {
	c.touch()
	defer c.touch()
	net, _ := c.network()
	job, err := newNoticeJob(to, kind, body, from, reply, net.GetMaxMessageLength(), when.Apart)
	if err != nil {
		return time.Time{}, err
	}
	job.progress = progress
	res := noticeResult{again: true}
	if when.AtRandom {
		progress("waiting", 0, 0)
		if c.cover.offer(job) {
			res = <-job.done
		}
		if res.again && !job.between() {
			_, gap := coverActive.next()
			time.Sleep(gap)
		}
	}
	if res.again {
		res = c.sendAll(job)
	}
	if res.err != nil {
		return time.Time{}, res.err
	}
	switch res.status {
	case cmix.Succeeded:
		return roundTime(res.round), nil
	case cmix.Failed:
		return time.Time{}, ErrNoticeFailed
	default:
		return time.Time{}, ErrNoticeUnconfirmed
	}
}

// newNoticeJob gets a notice ready to send to the inbox's mailbox: sealed as
// to and reply say, in as many messages as that takes, and, with apart, a
// quantum-safe notice's sent one at a time.
func newNoticeJob(to *InboxAddress, kind byte, body []byte, from *From, reply *ReplyKeys, msgLen int, apart bool) (*noticeJob, error) {
	seal, err := newNoticeSealer(to, kind, body, from, reply, msgLen)
	if err != nil {
		return nil, err
	}
	mode := modeOf(to, reply)
	job := &noticeJob{recipient: to.mailbox, pieces: mode.pieces(), seal: seal, done: make(chan noticeResult, 1)}
	if apart && mode == modeQS {
		if job.apart, err = newApartSend(); err != nil {
			return nil, err
		}
	}
	return job, nil
}

// UploadNoticeDelay draws how long after an upload the notice announcing it
// waits, unpredictably, before it goes on the beat of cover messages.
func UploadNoticeDelay() time.Duration {
	return uploadNoticeMin + time.Duration(randBelow(int64(uploadNoticeMax-uploadNoticeMin)+1))
}

// UploadNoticeTime draws when the notice announcing an upload that ended at
// since may go. A since after now counts as now, so a wrong clock never
// makes the wait longer than uploadNoticeMax.
func UploadNoticeTime(since, now time.Time) time.Time {
	if since.After(now) {
		since = now
	}
	return since.Add(UploadNoticeDelay())
}

// Notice is one message found in an inbox.
type Notice struct {
	// ID tells this notice from every other: worked out from the random id
	// sealed in it, so it's the same whenever a look-back finds it again, and
	// for a second copy a retry delivered.
	ID   [16]byte
	Kind byte // NoticeText or NoticeLink; a compressed text comes unpacked
	Body []byte
	// RoundTime is when the round carrying it ran: its send time, since a
	// notice found in any round but the one it was sealed for is dropped.
	RoundTime time.Time
	Round     uint64
	// QuantumSafe means it was sent to the inbox's quantum-safe address, or
	// as a reply with reply keys this inbox gave its sender (Reply).
	QuantumSafe bool
	Reply       bool
	// From is the sender's own inbox, if they included it so the owner can
	// reply, proved by the sender's inbox key; FromName is the name they
	// chose to show with it (UTF-8, unchecked otherwise: clean it before
	// showing it). Both nil and empty for an anonymous message.
	From     *InboxAddress
	FromName string
	// ReplyKeys are the sender's reply keys for this inbox, which a
	// quantum-safe notice including their inbox carries: with them, a reply
	// to the sender is quantum-safe too (SendNotice).
	ReplyKeys *ReplyKeys
}

// InboxSession checks one inbox for as long as it's open.
type InboxSession struct {
	c     *Client
	key   *InboxKey
	found func(Notice)

	mu     sync.Mutex // guards seen, others and copies
	seen   map[[noticeIDLen]byte]bool
	others int
	copies int

	pairs pairing // messages waiting to be tried as halves of a quantum-safe notice

	deliver sync.Mutex // serialises found, and guards closed
	closed  bool

	look lookback
	stop chan struct{} // closed by Close: ends the look-back reports
}

// OpenInbox starts tracking the inbox's mailbox and looks back through the
// network's history to since (the network keeps about 500 hours; xxDK looks
// back at least a day). Each notice found is passed to found once. Calls to
// found never overlap and none start after Close returns; found should
// return quickly, because it holds up message handling. progress, if not
// nil, hears how the look-back is going whenever that changes (see
// Lookback). Open an inbox at most once per Client: xxDK tracks a mailbox
// only once.
func (c *Client) OpenInbox(key *InboxKey, since time.Time, found func(Notice), progress func(Lookback)) *InboxSession {
	return c.OpenInboxSkipping(key, since, time.Time{}, time.Time{}, found, progress)
}

// OpenInboxSkipping is OpenInbox, except that past days lying wholly within
// [skipFrom, skipTo] aren't looked through again: an owner who keeps the
// inbox on their device has what they held, from a look-back cut short.
// A zero skipTo skips nothing.
func (c *Client) OpenInboxSkipping(key *InboxKey, since, skipFrom, skipTo time.Time, found func(Notice), progress func(Lookback)) *InboxSession {
	c.touch()
	s := newInboxSession(key, found)
	s.c = c
	s.look.opened = time.Now()
	status, _ := c.net.GetCmix().(cmix.LookbackReporter) // the xxdk-client patch
	if status != nil && !skipTo.IsZero() {
		status.AddIdentityWithHistorySkipping(key.Address.mailbox, identity.Forever, since, skipFrom, skipTo, false, s)
	} else {
		c.net.GetCmix().AddIdentityWithHistory(
			key.Address.mailbox, identity.Forever, since, false, s)
	}
	go s.report(status, progress)
	return s
}

func newInboxSession(key *InboxKey, found func(Notice)) *InboxSession {
	return &InboxSession{key: key, found: found, seen: map[[noticeIDLen]byte]bool{}, stop: make(chan struct{})}
}

// Lookback is how far opening an inbox has got. The network files messages
// under a label that changes daily, and an inbox's owner looks back through
// each past day's label in turn, then collects what they hold.
type Lookback struct {
	// DaysLeft of DaysTotal past labels are still to be checked.
	DaysLeft, DaysTotal int
	// Collecting counts pickups of messages found that haven't finished,
	// including any the network failed to hand over and that will be tried
	// again.
	Collecting int
	// Finished means every past label has been checked and everything found
	// collected, or as much as the network would hand over: Missing counts
	// rounds it failed to, which are tried again (from seconds to hours
	// apart) while the inbox stays open. Messages that arrive later still
	// turn up.
	Finished bool
	Missing  int
	// DoneFrom, while the look-back runs: everything delivered from then
	// until now has been collected (past days are looked through newest
	// first, and nothing is in flight or failed). Zero when that can't be
	// said. A kept inbox remembers it, so a look-back cut short can carry on.
	DoneFrom time.Time
}

const (
	// lookbackMinimum is the least time a look-back is given: xxDK adds the
	// mailbox's labels a moment after OpenInbox, and the current day's label
	// needs a few polls too.
	lookbackMinimum = 10 * time.Second
	// lookbackSettle is how long everything must stay done before it counts
	// as finished, in case a label's last poll finds one more round.
	lookbackSettle = 3 * time.Second
	// lookbackNoLabels is how long to wait for past labels to appear before
	// taking it that there are none to check.
	lookbackNoLabels = time.Minute
	// lookbackGiveUp is how long rounds the network failed to hand over may
	// hold up Finished once nothing else is left: xxDK retries them on a
	// back-off of up to hours.
	lookbackGiveUp = time.Minute
	lookbackEvery  = 500 * time.Millisecond
)

// lookback turns xxDK's counts into a Lookback, which once Finished stays so.
type lookback struct {
	opened      time.Time
	sawLabels   bool
	total       int
	failedSince time.Time // since only failed pickups were left
	doneSince   time.Time
	finished    bool
}

func (l *lookback) update(now time.Time, left, inFlight, failed int) Lookback {
	if left > 0 {
		l.sawLabels = true
	}
	l.total = max(l.total, left)
	switch {
	case left > 0 || inFlight > 0 || failed == 0:
		l.failedSince = time.Time{}
	case l.failedSince.IsZero():
		l.failedSince = now
	}
	givenUp := !l.failedSince.IsZero() && now.Sub(l.failedSince) >= lookbackGiveUp
	done := left == 0 && inFlight == 0 && (failed == 0 || givenUp) && now.Sub(l.opened) >= lookbackMinimum &&
		(l.sawLabels || now.Sub(l.opened) >= lookbackNoLabels)
	switch {
	case l.finished:
	case !done:
		l.doneSince = time.Time{}
	case l.doneSince.IsZero():
		l.doneSince = now
	case now.Sub(l.doneSince) >= lookbackSettle:
		l.finished = true
	}
	look := Lookback{DaysLeft: left, DaysTotal: l.total, Collecting: inFlight + failed, Finished: l.finished}
	if l.finished {
		look.Missing = failed
	}
	return look
}

// report checks the look-back's progress until Close, telling progress
// whenever it changes.
func (s *InboxSession) report(status cmix.LookbackReporter, progress func(Lookback)) {
	if progress == nil {
		return
	}
	if status == nil {
		jww.ERROR.Printf("[Slynk] This client can't report how far a look-back has got")
		return
	}
	tick := time.NewTicker(lookbackEvery)
	defer tick.Stop()
	var last Lookback
	first := true
	for {
		select {
		case <-s.stop:
			return
		case now := <-tick.C:
			left, inFlight, failed := status.LookbackStatus(s.key.Address.mailbox)
			l := s.look.update(now, left, inFlight, failed)
			l.DoneFrom = doneFrom(left, inFlight, failed, status.LookbackPendingUntil(s.key.Address.mailbox))
			if first || l != last {
				first, last = false, l
				s.deliver.Lock()
				if !s.closed {
					progress(l)
				}
				s.deliver.Unlock()
			}
		}
	}
}

// doneFrom is Lookback.DoneFrom: with past days still to check but nothing
// in flight or failed, everything after the newest day still to check
// (pending) has been collected.
func doneFrom(left, inFlight, failed int, pending time.Time) time.Time {
	if left == 0 || inFlight > 0 || failed > 0 {
		return time.Time{}
	}
	return pending
}

// Others counts messages at the mailbox's labels that weren't for this
// inbox, including halves that never found their other half.
func (s *InboxSession) Others() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.others
}

// Copies counts notices for this inbox seen in a round they weren't sealed
// for: copies someone sent again. A quantum-safe one counts each time a pair
// including a copy is tried, so it can exceed the copies sent.
func (s *InboxSession) Copies() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.copies
}

// Close stops tracking the inbox.
func (s *InboxSession) Close() {
	s.c.net.GetCmix().RemoveIdentity(s.key.Address.mailbox)
	s.deliver.Lock()
	if !s.closed {
		close(s.stop)
	}
	s.closed = true
	s.deliver.Unlock()
}

// Process satisfies message.Processor: every message at the mailbox that no
// fingerprint or service claims comes here, from several goroutines at once,
// one by one with no grouping by round. Each is tried as a compact notice
// first, then as a reply sealed with reply keys; what doesn't open waits to
// be tried as half of a quantum-safe one with the other messages that come
// (pair).
func (s *InboxSession) Process(msg format.Message, _ []string, _ []byte,
	_ receptionID.EphemeralIdentity, r rounds.Round) {
	// Anyone can send to an inbox, and xxDK doesn't recover panics in
	// message handlers, so a malformed message must never stop a check.
	defer func() {
		if recover() != nil {
			s.count(&s.others, 1)
		}
	}()
	// Its first 32 bytes are a compact notice's one-time key and a
	// quantum-safe notice's X25519 key alike: revealed once for both tries.
	m := newHalf(messageStream(msg))
	m.round, m.at, m.start = r.ID, roundTime(r), r.Timestamps[states.QUEUED]
	// sent is the half sealed for its own round: m, or, for a quantum-safe
	// notice, whichever half's round started first (pair checks it).
	sent := m
	o, err := openCompact(s.key, m)
	if err != nil {
		// A reply and the pairing tag start from the same X25519 result,
		// worked out once (half.shared). A reply that opened but was refused
		// is no half, so it isn't held for pairing.
		if o, err = openReply(s.key, m); errors.Is(err, errReplyRefused) {
			s.count(&s.others, 1)
			return
		} else if err != nil {
			o, other, ok := s.pair(m)
			if !ok {
				return
			}
			if startsBefore(other, m) {
				sent = other
			}
			s.deliverNotice(o, sent)
			return
		}
	}
	if o.round != uint32(r.ID) {
		s.count(&s.copies, 1)
		return
	}
	s.deliverNotice(o, sent)
}

// deliverNotice passes on a notice once, as sent in the round of sent.
func (s *InboxSession) deliverNotice(o opened, sent *half) {
	n := Notice{Kind: o.kind, Body: o.body, RoundTime: sent.at, Round: uint64(sent.round),
		QuantumSafe: o.quantum, Reply: o.reply, From: o.from, FromName: o.name, ReplyKeys: o.replyKeys}
	h := sha256.Sum256(append([]byte(inboxIDInfo), o.id[:]...))
	copy(n.ID[:], h[:])

	s.deliver.Lock()
	defer s.deliver.Unlock()
	s.mu.Lock()
	dup := s.seen[o.id]
	s.seen[o.id] = true
	s.mu.Unlock()
	if !dup && !s.closed {
		s.found(n)
	}
}

func (s *InboxSession) count(n *int, by int) {
	s.mu.Lock()
	*n += by
	s.mu.Unlock()
}

func (s *InboxSession) String() string { return "slynk inbox" }

func roundTime(r rounds.Round) time.Time {
	if t, ok := r.Timestamps[states.QUEUED]; ok {
		return t
	}
	return r.Timestamps[states.PRECOMPUTING]
}
