# A new identity per visit: what Slynk asks of the xx network

*Slynk, 2026-10-31. All times UTC.*

Each visit to Slynk joins the xx network as a new, temporary identity, which helps keep
visits unlinkable. New identities are admitted by one central service for the whole
network, and only so many a day, and each one costs the network's nodes and gateways a
little work. If Slynk grows, it could use a noticeable share of that allowance. This
note says so openly, so it comes as no surprise: what an identity costs, what Slynk
already does to keep the number down, and what could help. It's written for the xx
foundation and xx developers first, as an offer to work on this together.

## In short

- Every new identity is admitted by the **client registrar** through a leaky bucket:
  1,000 per 24 hours in its published example configuration. The live setting isn't
  public. Identities it already knows, and holders of registration codes, skip the
  bucket.
- A new identity then registers with every node, about 180: a Diffie–Hellman exchange
  in the 4,096-bit cMix group for each, a signature from each node's gateway, and a row
  in each gateway's database that nothing deletes.
- Slynk joins only when someone starts to send or receive, and uses one identity per
  tab for everything it can, with a second one only where privacy needs it.
- Two things could help: visits that only receive and skip registration (untested), and
  whatever paid or subsidised sending the network adopts.

## 1. Why a new identity each time

Slynk keeps nothing in the browser unless the visitor asks: the identity lives only in
the memory of the tab's worker ([core/transfer/memkv.go](../../core/transfer/memkv.go)) and
is gone when the tab closes. So two visits never share a mixnet sender ID, and the
network can't use one to tie them together. That's part of what makes visits
unlinkable, and it's why Slynk makes far more identities per person than an app that
registers once per install and keeps its keys.

## 2. How the network admits a new identity

When xxDK creates an identity, it generates two RSA key pairs (transmission and
reception) and, the first time the client loads, sends their public halves to the
**client registrar** (`initPermissioning` in `xxdk/cmix.go`). The registrar is a central
service, split out of the permissioning server, which schedules rounds and publishes the
network's directory (the NDF). It signs both keys with a
timestamp, and that signature is what nodes accept as proof of admission.

The registrar's `RegisterUser` (`cmd/registration.go`) decides in this order:

1. **A transmission key it already knows** is signed again, without touching any limit.
2. **A registration code**, if the client sends one, is checked and one of its uses
   spent. Codes have a fixed number of uses.
3. **Anything else** takes a token from one leaky bucket. When the bucket is empty, the
   request is refused with "Too many client registrations. Try again later".

The bucket's capacity and leak period come from the registrar's database if they're set
there, and otherwise from its configuration (`cmd/impl.go`). Its published example
configuration, and its code's own defaults, are 1,000 per 24 hours (`README.md`,
`cmd/root.go`). The live setting isn't public. As far as the public code shows, there is
one bucket for the whole network: every app's new identities draw on the same
allowance.

Slynk sends no registration code (`NewCmixWithKV` in
[core/transfer/transfer.go](../../core/transfer/transfer.go) passes an empty one), so each
of its new identities takes one token.

## 3. What each identity costs the network

- **The registrar** signs two keys and stores a record of the identity (its keys and
  the time). Its storage has no call that deletes these records.
- **Every node, through its gateway.** The new identity then registers with each node
  in the directory, about 180 (181 on 2026-10-13). Each request goes to the node's
  gateway, which passes it to its node. The node carries out a Diffie–Hellman key
  exchange in the network's 4,096-bit cMix group (the RFC 3526 prime; the client's side
  is in `cmix/nodes/request.go`). The node's own code isn't public, so its exact work
  comes from xx's design documents. The gateway signs the node's reply with its own RSA
  key and stores a row with the client's ID and key (`requestClientKeyHelper` in the
  gateway's `cmd/gateway.go`). Nothing in the gateway's code deletes those rows.
- **The visitor's own device** does its half: two RSA key pairs and a Diffie–Hellman
  exchange per node, part of the 12–27 s a join usually takes.

Each of these is small. Multiplied by an identity per visit, and by every node, it adds
up faster than for an app that registers once per install.

## 4. What Slynk already does

- **It joins only when needed.** The page stays idle until someone starts writing, adds
  a file, opens a link or taps the connection pill. A "Connect when the page opens"
  setting exists, off by default
  ([web/src/ui/settings.ts](../../web/src/ui/settings.ts)). Someone who receives a link
  joins only after tapping to open it, and a link that has already been used says so
  without joining at all.
- **One identity per tab, reused for everything it can.** A tab's identity makes all of
  its links, collects every link opened in it, and opens the visitor's inbox.
- **A second identity only where privacy needs it.** The network's nodes see each
  message's sender ID, so a message to an inbox sent from the identity that also made
  links, or checks an inbox, could be tied to them. So when a tab has done both, its
  messages to inboxes go from a second identity, connected for the purpose
  ([core/cmd/wasm/inbox.go](../../core/cmd/wasm/inbox.go), and "Which identity does
  what" in [web/src/main.ts](../../web/src/main.ts)). A tab that only writes to inboxes
  uses its one identity for that.
- **Few restarts.** A join that stalls starts again with a fresh identity at most 3
  times, and only after 30 s without progress or 90 s without being ready (`retryJoin` in
  [core/transfer/transfer.go](../../core/transfer/transfer.go)).
- **Small, single-use links.** Every slynk.me link carries at most 2 MB and opens once,
  so one upload brings at most one download, and one identity, to the network.
- **Cover messages draw nothing from the registrar.** The opt-in cover messages go from
  the tab's existing identity, with its existing node keys.

## 5. If Slynk grows

With the example setting, a thousand visits a day that send or receive something would
use the whole allowance, for every app on the network. We don't know the live setting or
how close the network runs to it, so we can't say when that would matter. When the
bucket is empty, every app's new users are refused until it refills, which nobody wants.

## 6. What could help

**Receiving without registering.** A gateway answers polls and message
requests without any authentication or node key (`Poll` in the gateway's `cmd/poll.go`,
`RequestMessages` in `cmd/gateway.go`). So a visit that only collects a link, or only
reads an inbox, may not need to be admitted or to register with nodes at all. Many of
Slynk's visits are like that: everyone who opens a link, and an inbox owner reading
their messages. xxDK registers every new identity when it's created, so skipping it
would need a change to the client, and we haven't tried it. Sending, replying and cover
messages would still need registration. We'd like to know whether gateways or nodes
would object to clients that never register.

**Paid or subsidised sending.** The xx network's site describes planned "postage" for
this: a free allowance for everyday use, with heavier users and apps paying for more in
xx coins. It's described as something the community may adopt; for now, sending is free
([xx Coin](https://xx.network/xx-coin/)). Slynk would follow whatever the network adopts. One thing to design for: payment
that's tied to an account could link visits that Slynk keeps apart on purpose, so a
per-app allowance, or something that can't be traced to a visitor, would suit a service
like this better.

**Registration codes.** The registrar already lets code holders skip the bucket. A code
for Slynk would keep its visitors from using up everyone else's allowance, at the cost of
telling the registrar which new identities are Slynk's, which it could largely guess
anyway. We'd be glad to use one if that's the intended route.

## 7. Questions for the xx foundation

1. What is the live registrar setting, and how close does the network run to it?
2. Would clients that only receive, and never register, be acceptable to the network?
3. Are registration codes the intended route for an app that makes an identity per
   visit?
4. How might postage, or something like it, work for a service that deliberately has no
   accounts?

## Sources

- The client registrar, `github.com/xxfoundation/elixxir-client-registrar` (commit
  `a1634ab`, branch `release`): `cmd/registration.go`, `cmd/impl.go`, `cmd/root.go`,
  `storage/`, `README.md`.
- The gateway, `github.com/xxfoundation/elixxir-gateway` (tag `v3.16.1`):
  `cmd/gateway.go` (`RequestClientKey`, `RequestMessages`), `cmd/poll.go`,
  `storage/gatewayDb.go`.
- xxDK v4.8.4, `github.com/xxfoundation/elixxir-client` (tag `v4.8.4`): `xxdk/cmix.go`,
  `xxdk/user.go`, `cmix/nodes/request.go`.
- The cMix design, `github.com/xxfoundation/elixxir-docs` (commit `e5d8289`): `cmix.md`.
- The xx network, [xx Coin](https://xx.network/xx-coin/) (postage).
- Slynk: [core/transfer/transfer.go](../../core/transfer/transfer.go),
  [core/cmd/wasm/inbox.go](../../core/cmd/wasm/inbox.go),
  [web/src/main.ts](../../web/src/main.ts).

## Credits

Thanks to the xx foundation, which keeps the network going, to Rick Carback, the leading
contributor to xxDK and among the main contributors to the registration code read here,
and to every node operator who carries the work described here.

— Slynk
