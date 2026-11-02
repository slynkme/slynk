# Slynk's technical write-ups

*Slynk, 2026-10-31. All times UTC.*

Slynk is a private, link-based drop for files and messages, carried by the xx network's
cMix mixnet. Everything happens in the visitor's browser and in memory: the page joins the
mixnet as a brand-new identity, sends encrypted pieces to a random single-use address, and
hands back a link whose secret lives after the `#`. These write-ups explain how it works,
the choices behind it, and what we learned about the xx network along the way. They're
written for xx network developers first, and for anyone curious enough to read on from the
[About page](https://slynk.me/about/).

Each one is checked against the code in this repository, and cites outside code at a
tagged version. If you find something wrong, please say so.

## Where to start

- [The privacy choices behind Slynk, and why](decisions.md): every decision in one place,
  with what each one costs, and links to the rest.
- [What the xx network's computers can see](gateway-metadata.md): the honest limits of
  using the mixnet from a browser today.

## How Slynk works

- [One-time links, the key server and cover requests](one-time-links.md): why the mixnet
  can't delete anything, so a link's key comes in two halves, and how slynk.me's key server
  keeps its half.
- [Why every slynk.me link opens once](why-links-open-once.md): slynk.me's rule, and how
  your own copy of Slynk can choose differently.
- [The link and envelope formats](link-and-envelope-format.md): every byte of a link, the
  seal and password layers, and what's inside.
- [Slynk's anonymous inbox](inbox.md): a mailbox made of the xx network, opened with
  12 words.
- [Quantum safety in Slynk](quantum-safety.md): what's protected against a future quantum
  computer, and the quantum-safe inbox address.
- [Removing hidden details from files](hidden-data-cleaning.md): what's removed from each
  kind of file before it leaves the browser, and what can't be.
- [Stopping an upload part-way](cancel-upload.md): what stopping can and can't take back.

## Slynk on the xx network

- [A new identity per visit](network-identities.md): what Slynk asks of the network's
  daily allowance of new identities, and how that could be eased.
- [Upload throughput over cMix](upload-throughput-2026-10.md): what limits a single
  client's upload rate, and the choices Slynk made.
- [Notes from building Slynk on the xx network](notes.md): retention, joining, round order
  and other short findings.

## Changes to the xx client, and bugs found

- [Slynk's changes to xxDK](xxdk-changes.md): every change Slynk makes to the xx client
  SDK, why, and which might be worth taking upstream.
- [comms: `RoundUpdates` drops upcoming rounds](comms-roundupdates-bug.md): a bug report,
  with how Slynk works around it.
- [client: a failed pickup waits for the 120 s sweep](pickup-retry-delay.md): a bug
  report, with Slynk's quick retry.

## For your own app

- [Preparing files for the mixnet](preparing-files.md): Slynk's file cleaning, shrinking
  and compression, with an example you can copy into your own project, given as is.

## Ideas

- [Open a kept inbox with a passkey](../ideas/passkey-unlock.md): researched, not built.

## Credits

Slynk stands on David Chaum's cMix, the xx foundation's network and SDK (Rick Carback its
leading contributor), and Keith Millette's fork of that SDK. See
[CREDITS.md](../../CREDITS.md).

— Slynk
