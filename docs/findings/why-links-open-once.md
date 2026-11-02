# Why every slynk.me link opens once

*Slynk, 2026-10-31. All times UTC.*

Every link slynk.me makes opens once, and slynk.me opens no other kind. This piece
explains that choice: what it's for, what it costs, what it doesn't prevent, and how a
copy of Slynk running somewhere else can choose differently. It's slynk.me's choice, not
a rule for everyone who builds on the xx network, and the code is written so that others
can make their own. How one-time links work underneath is in
[one-time-links.md](one-time-links.md).

## 1. What slynk.me is for

Slynk passes something privately from one person to another: a message or a few files
become a link, and the person who gets the link opens it. With an anonymous inbox, many
people can write privately to one. What slynk.me doesn't do is one-to-many: a link posted
somewhere for anyone to open, again and again.

So the page makes only one-time links, and refuses any other kind on arrival ("This link
doesn't open here"), before anything connects. The first person to press Open it now has
the link held for them for 15 minutes while they collect it. Anyone else who taps
meanwhile is turned away before downloading anything, and once it's open it won't open
again. To send something to several people, the sender gives each of them their own
link.

## 2. Why

**The network can't carry crowds.** Everyone who opens a Slynk link joins the xx network
as a brand-new identity, in that browser tab's memory, and collects every piece of the
item from the gateways of the rounds that carried it. A link shared widely would turn one
upload into a crowd of joins and full downloads:

- Each new identity goes through the network's client registrar, whose published example
  configuration admits 1,000 new identities a day across the whole network; the live
  setting isn't public (see [notes.md](notes.md)). At that setting, a single popular link
  could use up a day's allowance for everyone.
- Each download is the whole item, in pieces of about 920 bytes, each fetched from one of
  the gateways of the round that carried it. A full 2 MB took 2 min 4 s to collect after
  the tap, measured on mainnet on 2026-10-15.
- The nodes and gateways are run by independent operators on their own hardware. They
  weren't built to serve the same file to thousands of people, and the mixnet has none of
  the caches and mirrors that make that cheap on the open web.

**It shouldn't spread things with Slynk's name on them.** A link anyone can open many
times is a way to distribute something to crowds, including things that should never be
shared. A link that opens once is a way to hand something to one person. slynk.me
prefers to be only the second.

The two reasons point the same way, and the design follows from them rather than from a
technical limit: the key server could just as easily hand a half-key out many times.

## 3. What's accepted

- **Whoever opens a link can pass on what's inside,** by any other means. One-time stops
  a link being opened twice; it can't stop its contents being copied. Slynk doesn't
  pretend otherwise.
- **Anyone who has a link can learn whether it's still waiting,** but only by starting to
  open it, which holds it for 15 minutes. The About page says so.
- **Links rely on slynk.me's key server.** Every one-time link needs it, so with the rule
  on, every link does. If it's unreachable, links can't be made or opened until it's back,
  and a crash there loses the links waiting at that moment.
- **A sender can't make one link for a group.** They make one each.

## 4. How a copy of Slynk turns it off

Everything that makes the site slynk.me is in one file,
[web/src/site.ts](../../web/src/site.ts). The rule is one setting there:

```ts
export const ONE_TIME_ONLY = true
```

The key server enforces the rule too, on its own machine, so it can't read the page's
setting. A copy that turns the rule off also runs its key server with
`-one-time-only=false` ([core/cmd/keyserver/main.go](../../core/cmd/keyserver/main.go));
otherwise the key server refuses to store expiring links and won't hand them out, and
they fail. Setting one up is described in
[deploy/keyserver/README.md](../../deploy/keyserver/README.md).

With the rule off:

- **The composer offers all three kinds of link,** under Link options: an ordinary link,
  which lasts up to three weeks and opens any number of times; a link that stops working
  after 1 hour, 1 day or 7 days, and opens any number of times until then; and a one-time
  link, with a switch. Expiring and one-time links can be cancelled.
- **Ordinary links need no key server.** They're the core's plain 148-byte link, with the
  whole key inside, so nothing can take them back
  ([link-and-envelope-format.md](link-and-envelope-format.md)).
- **Expiring links use the key server's `get`,** which hands out the half-key until the
  link expires or is cancelled, without using it up.
- **The page opens every kind,** and its wording follows: the busy and unreachable
  messages ([web/src/burnCopy.ts](../../web/src/burnCopy.ts)) and the About page's
  answers, which are written in both versions and picked at build time
  ([web/scripts/rules.ts](../../web/scripts/rules.ts)). Tests check both versions.

The other code paths stay in the repo and stay tested, so turning the rule off is the
setting and the key server's flag, nothing more.

## 5. The choice is the copy's

Slynk's code is open, and anyone may run their own version of it. Someone launching a
similar service can switch multi-use links on if they wish. The choice, and what comes
of it, would be theirs: the load their users put on the xx network, and what their links
are used to spread. slynk.me has chosen not to, to act responsibly towards the network
and the people it could reach, while still being a useful tool for everyone.

## Sources

- Slynk: [web/src/site.ts](../../web/src/site.ts) (`ONE_TIME_ONLY`, `opensHere`),
  [web/src/linkv2.ts](../../web/src/linkv2.ts) (`linkKindFor`),
  [web/src/burn.ts](../../web/src/burn.ts) (`reserve`),
  [core/keyserver/store.go](../../core/keyserver/store.go) (`opPut`, `opGet`),
  [core/keyserver/server.go](../../core/keyserver/server.go) (`OneTimeOnly`)
- xxDK v4.8.4: `gitlab.com/elixxir/client/v4`, mirrored at github.com/xxfoundation

## Credits

Thanks to the xx foundation for cMix, the xx network and xxDK, to Rick Carback, the
leading contributor to xxDK, and to the independent operators who run its nodes and
gateways.

— Slynk
