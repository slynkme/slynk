# What the xx network's computers can see

*Slynk, 2026-10-31. All times UTC.*

Slynk sends files and messages through the xx network's cMix mixnet. The mixnet keeps
contents secret and hides which message going in became which coming out, but the
network's computers still see some things about who sends, when and how much. This note
sets out what the nodes and gateways see of Slynk's traffic, what gateways share with
each other, what one curious operator could work out from it, and what Slynk does about
it. It's for xx developers and technical readers who want more than the About page's
summary.

It comes from reading the public code: the gateway at v3.16.1, comms v0.0.6 and xxDK
v4.8.4. The node software isn't public, so what nodes do comes from xx's design
documents. Which gateway version mainnet runs, and each operator's settings, can't be
checked from outside.

## In short

- **Contents and the link never leave the browser unencrypted.** No node or gateway can
  read what's sent.
- **Nodes** see each piece's sender ID, the tab's temporary identity, but never an IP
  address.
- **Gateways** see IP addresses. The gateway that collects a round's pieces keeps, for
  each round, a list of every piece's sender ID and IP address, and gateways share those
  lists, and each round's pickup addresses, with one another.
- **So one curious gateway operator, with no help from anyone,** could match a
  multi-piece upload to its link's pickup address: within one round while the network is
  quiet, or across a few rounds from what gateways share. Tying it to the person who later
  downloads it needs a gateway that person's browser uses.
- **Slynk** confirms uploads by round results instead of reading them back, offers
  opt-in cover messages and uneven uploads, uses a fresh identity per tab, and suggests a
  VPN. None of these hides a large upload from a curious gateway.

## 1. Terms

- **Round:** one run of the mixnet. A **team** of 5 nodes takes a batch of up to 1,000
  pieces (slots) and shuffles them. On mainnet about 1.2 rounds finish a second.
- **Node:** one of the computers that does the mixing. Clients never talk to nodes.
- **Gateway:** each node's front door to the internet. Each node is paired with one
  gateway (xx's `cmix.md`), which takes its identity from its node (the gateway's
  `cmd/instance.go`), so the two are normally in one operator's hands. Clients talk only
  to gateways.
- **Entry gateway:** the gateway of a round's first node. It collects the round's pieces
  and hands them to its node.
- **Proxy gateway:** whichever gateway the browser sends through. The browser keeps a
  pool of 7 of the ~180 gateways, so a round's entry gateway is usually not among them,
  and the proxy forwards the pieces to it. Even our native client, with a pool of 14,
  sent 92% of its upload calls this way.
- **Sender ID:** the mixnet identity a piece is sent from. For Slynk it's the tab's
  temporary identity, made from a fresh key when the tab joins.
- **IP address:** the internet address the browser connects from. It's not the same
  thing as the sender ID, and the protocol keeps them in different places.
- **Pickup address:** the short address a delivered piece is filed under, worked out
  from its recipient's ID and cut to 18 bits, so there are 262,144 of them. It changes
  about once a day. A Slynk link's pickup address is worked out from the random,
  single-use recipient ID inside the link.

## 2. What never leaves the browser

- **The link's secret.** It travels only in the link's `#fragment`, which browsers never
  send to a server, and the page removes it from the address bar once read.
- **Contents.** xxDK's file transfer encrypts each part with ChaCha20 under a random
  transfer key, and the whole file is checked against a MAC; the key is only in the link.
  On slynk.me every link is also sealed inside a one-time layer (see
  [one-time-links.md](one-time-links.md)). Messages to inboxes are sealed with HPKE to the
  inbox's key.
- **Why that matters.** cMix's own encryption ends at the team's last node (xx's
  `threat_model.md`), so contents stay safe after that because of Slynk's encryption, not
  the mixnet's.

Every piece is the same size, so contents can't be told apart by length. Their number
can: an upload's pieces show its size to within about 920 bytes.

## 3. What nodes see

A piece, as nodes handle it, is a `Slot`: a sender ID, two encrypted payloads, a salt,
one key MAC per node, an optional client key and a few flags (comms' `mixmessages.proto`). There's **no IP
field**, and the batch a gateway uploads to its node holds only slots. So no node receives
a client's IP address from the protocol, not even the first.

Per xx's design (`cmix.md`), the sender ID, salt and MACs travel with each piece through
the team, because each node needs them to find the key it shares with that client; they
are stripped before the output. So **every node in the team sees which sender IDs took
part in the round, and how many pieces each sent**. The last node also sees the outputs:
each piece's pickup address and its still-encrypted contents.

That "nodes never see IPs" is a fact about the protocol, not about the people: a node
and its paired gateway are normally run by the same operator (§1).

What the team protects is the shuffle. If any one of its 5 nodes keeps its part secret,
nobody can tell which piece going in became which coming out. It doesn't hide who took
part in a round, how many pieces each sender put in, or which pickup addresses received
them. The cMix paper says as much, and so does xx's threat model.

## 4. What gateways see

- **The proxy gateway** reads the browser's IP address from the connection, and sees each
  piece's sender ID, the round and how many pieces go in each call: 9–11 for a Slynk
  upload by default.
- **The entry gateway** gets the IP address too: the proxy writes it into the forwarded
  pieces (`IpAddr`, in the gateway's `cmd/gateway.go`). It uses the address and sender
  ID for rate limits, and keeps, for each round, a list with one (sender ID, IP address)
  entry per piece (`storage/unmixedMapBuffer.go`). Those lists aren't freed after the
  round is sent, so they stay in memory until the gateway restarts.
- **All 5 gateways of the team** receive the mixed output: per xx's design
  (`message_pickup.md`), the last node passes it to its gateway and to the team's other
  nodes, which pass it to theirs. Each gateway drops the gateways' own filler pieces,
  which are labelled, and stores the real ones under their pickup addresses
  (`processMessages` in `cmd/gateway.go`), so each knows how many pieces every pickup
  address received in that round. The entry gateway is one of them.
- **Anyone at all** can ask a gateway which rounds a known pickup address received in,
  and fetch what's stored there: polls and message requests need no authentication
  (`Poll` in `cmd/poll.go`, `RequestMessages` in `cmd/gateway.go`). What they get back is
  encrypted.
- **The downloader's own gateways.** To collect a link, the browser polls its handful
  of gateways for the link's pickup address, from its IP address. A request they forward
  to the team's gateways carries no IP (comms' `GetMessages`). So only the gateways in the
  downloader's pool see the downloader's address next to the pickup address.

Two more parties see a little. The **client registrar** sees a browser's IP address
once, when the tab's new identity is admitted (see
[network-identities.md](network-identities.md)). And the network's directory lists a
**notification server** (it did on 2026-10-13): team gateways send it, every round, the
pickup address, an identity fingerprint and a hash of the contents of each real piece
(`cmd/gateway.go`). We don't know who runs it or what it keeps.

## 5. What gateways share

Gateways pass two kinds of signed notes to each other, by gossip: each note goes to a few
random gateways, which pass it on. Both are on unless an operator sets `disableGossip` in
the gateway's configuration file or environment (`cmd/params.go`); the `--enableGossip`
command-line flag is never read, and no published configuration sets `disableGossip`.

- **Senders, for rate limits.** After uploading a round's batch, the entry gateway sends
  the round's list of sender IDs and IP addresses, one entry per piece (`BatchSenders`),
  to 4 random peers, which pass it on up to twice while it's under 10 s old
  (`cmd/rateLimitGossip.go`). Only IPv4 addresses are included: an IPv6 address is left
  out of the list and written to the entry gateway's log instead. The gossiped addresses
  look to have no effect: a receiving gateway files them in its table of sender-ID limits
  (`idRateLimiting`), which is only ever looked up by sender ID, not in its table of IP
  limits (`ipAddrRateLimiting`, `cmd/gateway.go`).
- **Recipients, for pickups.** After storing a round's output, each team gateway sends the
  set of pickup addresses that received in it, without counts, to 25 random peers, which
  keep it as a bloom filter for as long as messages are kept (`cmd/bloomGossip.go`). This
  is how any gateway can tell a client which rounds hold something for it.

Mainnet almost certainly gossips: Slynk's downloads work through gateways that weren't in
the round's team, and the same switch controls both kinds. Every gateway in the directory
is a peer, so the notes reach most gateways; we haven't measured how many.

Gossip is sent over TLS and signed, so outsiders can't read it. Every receiving gateway
gets the lists in the clear. A stock gateway logs only counts at its default level, but
recording the lists would take a few lines of code, and nobody else could tell.

## 6. What one curious operator could learn

By a **curious operator** we mean one whose gateway follows the protocol but keeps what
it receives. That's one party acting alone, with no collusion, and nothing the protocol
can detect.

- **The entry gateway, within a single round.** It sees a sender ID, at an IP address,
  put 10 pieces into the round. As one of the team's gateways it also sees that one
  pickup address received 10. Filler is labelled, so the crowd that hides the match is
  only the round's real pieces. In a quiet round the match is immediate, and turning gossip
  off wouldn't change it.
- **Any gateway, from gossip, across rounds.** It sees the same sender ID with 9–11
  entries in round after round, and each round's set of pickup addresses. Even if a round
  had 1,000 different recipients, an unrelated pickup address would be in it about 0.4% of
  the time (1,000 in 262,144), so after three rounds hardly any address but the link's
  fits, and a 250 KB upload spans about 27. Per-round counts, to settle the rest, are
  there for anyone to ask.

Either way the operator learns the uploader's IP address and the link's pickup address,
not the link: it still can't open anything. Before 2026-10-14 there was a third, easier
route, now closed (§7).

Some things need more than one party:
- **Which piece became which** needs all 5 nodes of the team.
- **The downloader's IP address** is seen only by the gateways in the downloader's pool:
  7 of about 180, so about 4% of the time for any one gateway, more for an operator who
  runs several, or for several working together.
- **Contents** need the link.

A single piece, such as a short message to an inbox, hides among the round's real
senders, which is much harder to pick out than an upload. How big that crowd is, nobody
outside the network knows: no public figure gives real pieces per round, only rounds and
slots. And an inbox's address is public by design, so anyone with it can see when its
pickup address received something, though never from whom.

## 7. What Slynk does about it

- **Uploads confirm by round results.** Stock xxDK confirms an upload by downloading
  each part back, so the uploader polled its link's pickup address from its own IP
  address, through the same gateways that carried the upload: the most direct link of
  all. Since 2026-10-14 a part counts once its round reports success, and the uploader
  never polls the pickup address
  ([channelsFileTransfer/confirmByRound.go](../../third_party/xxdk-client/channelsFileTransfer/confirmByRound.go);
  details in [upload-throughput-2026-10.md](upload-throughput-2026-10.md)).
- **Opt-in cover messages.** While a tab is connected, it sends 1–5 blank messages every
  5–55 s, slowing to 1–2 every 2–18 minutes after 30 minutes without a transfer. Each
  is a single full-size piece to a random recipient, built and sent exactly like a
  one-piece message to an inbox ([core/transfer/cover.go](../../core/transfer/cover.go)).
  They make a tab's real single messages one of many, and grow the crowd for everyone, more so as
  more people turn them on. They can't disguise an upload: its pieces all go to one
  pickup address, and cover never does.
- **Uneven uploads**, an opt-in setting, sends a random 1–11 pieces per round instead of
  9–11. It changes the pattern, not the one recipient, so it doesn't stop the matching
  above, and Slynk claims nothing more for it.
- **A fresh identity per tab**, so visits don't share a sender ID. Messages to inboxes go
  from a second identity when the tab's own also makes links or checks an inbox, so the
  network can't tie them together by sender ID. Sent from the same connection, though,
  they share an IP address, which gateways see.
- **A VPN, suggested on the About page.** It hides the visitor's IP address from the
  gateways and the registrar. It doesn't stop a gateway matching an upload's sender ID to
  its pickup address; it means the match leads to the VPN's address.
- **Plain wording.** The About page says what the network can see, in these terms but
  shorter.

## 8. The limits

- A multi-piece upload stands out to gateways whatever Slynk does, and its size shows.
- The crowd is small while few people use the network, so timing alone can narrow down
  who sent a single message.
- Whenever a browser uses Slynk, the gateways in its pool see its IP address.
- We can't check what mainnet gateways run or record, whether any operator puts something
  in front of its gateway, or what the notification server keeps.

## 9. Questions for the xx foundation

1. Which gateway version does mainnet run, and with which gossip settings?
2. Gossiped IP addresses seem to have no effect on rate limits (§5). Is that intended,
   and if so, could `BatchSenders` stop carrying them?
3. Could the entry gateway free each round's sender and IP lists once its batch is sent?
4. Who runs the notification server in the directory, and what does it keep?
5. Is cover traffic at the rates above acceptable to the network? xxDK's own dummy
   traffic drops to 1–2 messages every 2–18 minutes once it has sent 20; was that for the
   network's sake?
6. Could the network publish how many real pieces rounds carry, so apps can describe
   their crowd honestly?

## Sources

- The gateway, `github.com/xxfoundation/elixxir-gateway` (tag `v3.16.1`):
  `cmd/gateway.go`, `cmd/rateLimitGossip.go`, `cmd/bloomGossip.go`, `cmd/poll.go`,
  `cmd/params.go`, `cmd/instance.go`, `cmd/ipAddress/convert.go`,
  `storage/unmixedMapBuffer.go`.
- comms v0.0.6, `github.com/xxfoundation/elixxir-comms` (tag `v0.0.6`):
  `mixmessages/mixmessages.proto` (`Slot`, `GatewaySlots`, `BatchSenders`,
  `GetMessages`).
- xxDK v4.8.4, `github.com/xxfoundation/elixxir-client` (tag `v4.8.4`):
  `cmix/gateway/defaults_js.go`, `dummy/send.go`.
- xx's design documents, `github.com/xxfoundation/elixxir-docs` (commit `e5d8289`):
  `cmix.md`, `threat_model.md`, `message_pickup.md`.
- D. Chaum, D. Das, F. Javani, A. Kate, A. Krasnova, J. de Ruiter and A. T. Sherman,
  "cMix: Mixing with Minimal Real-Time Asymmetric Cryptographic Operations", IACR ePrint
  2016/008.
- Slynk: [third_party/xxdk-client/](../../third_party/xxdk-client/),
  [core/transfer/cover.go](../../core/transfer/cover.go),
  [core/transfer/transfer.go](../../core/transfer/transfer.go).

## Credits

Thanks to David Chaum and the cMix authors, to the xx foundation, and to Rick Carback,
Benjamin Wenger and David Stainton, the authors of xx's design documents, whose open code
and documents made it possible to check all this.

— Slynk
