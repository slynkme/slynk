# Idea: open a kept inbox with a passkey

*Slynk, 2026-10-31. All times UTC.*

**Status:** researched and shelved. Nothing here is built. Browser versions and behaviour
below are as of October 2026, from the sources listed at the end; they change often, so
they need checking again before anyone builds this.

An inbox owner who keeps their inbox on their device can already have Slynk remember its
12 words, as they are or sealed under a password ("Remember my passphrase"). This note
looks at a third way: opening the inbox with Face ID, a fingerprint or the device's PIN,
through a passkey. It's for anyone curious about WebAuthn's PRF extension in practice, or
thinking of building this into Slynk or a copy of it.

## In short

- A passkey's PRF extension can release a secret only after the device's own unlock, so
  it could seal the 12 words on the device with nothing sent to any server.
- Support is real but patchy: recent Apple systems, Android and desktop Chrome with
  Google's passkeys, and only fully updated Windows 11. No page can tell in advance
  whether a person's passkey supports it.
- It's weaker than the words for anyone who shares, or can be made to unlock, their
  device, and it leaves a lasting, synced trace ("slynk.me" in their saved passwords).
- Slynk offers "Remember my passphrase", with an optional password, instead.

## 1. The idea

The 12 words would be sealed on the device under a key that only the owner's passkey can
release, using WebAuthn's PRF extension (a passkey feature that returns a secret derived
from a value the site supplies, after the person unlocks the passkey). Opening the inbox
would then be one Face ID, fingerprint or PIN prompt. Nothing would go to slynk.me: there
is no server side to it at all. The 12 words would always still work.

## 2. How it would work

- **Setting it up** (from the inbox's menu, only for an inbox kept on this device):
  1. `navigator.credentials.create()` with `extensions.prf.eval.first` set to a fresh random
     32-byte salt, `userVerification: 'required'`, `residentKey: 'required'`,
     `authenticatorAttachment: 'platform'`, `attestation: 'none'`, and a random `user.id`
     made for this enrolment only (never anything from the inbox).
  2. Then one `navigator.credentials.get()` with `allowCredentials` set to that credential
     (transports including `'internal'`) and the same salt, behind a second tap.
  3. The 32-byte PRF result from the `get()` goes through HKDF-SHA256 to a non-extractable
     AES-256-GCM key, which seals the 12 words. The sealed words, the credential ID and the
     salt are stored beside the kept inbox. If `create()` also returned a result and it
     differs from the `get()` result, set-up is refused.
- **Opening:** one `get()` with the stored credential and salt, straight from the tap; the
  key unseals the words, and the inbox opens as if they had been typed. Since the kept
  inbox's own key comes from the words, the passkey would guard everything kept, as a
  password does today.
- **Turning it off, or forgetting the device:** the sealed words are deleted, and
  `PublicKeyCredential.signalUnknownCredential()` is called where the browser has it. The
  page should still tell the owner how to delete the passkey themselves.
- **Losing it:** a deleted passkey, a new phone or a cancelled prompt all look the same to
  the page (the browser deliberately doesn't say which), so the page falls back to the
  words and offers to set it up again.

The salt and credential ID need no secrecy: the security rests on the secret the passkey
holds and on the device's unlock.

## 3. Where it works

| Platform | Works? | Notes |
|---|---|---|
| iPhone and iPad, iOS 18 or later (Safari and every other iOS browser), Apple's own passkeys | Yes | One prompt is enough at set-up on Apple's side, but the design above uses two |
| Mac, macOS 15 or later (Safari, Chrome, Firefox 139+), Apple's passkeys | Yes | macOS 13 and 14 have no PRF in Safari at all, whatever the Safari version |
| Android, Chrome and Google Password Manager | Yes | Since Chrome 116 |
| Chrome on Windows, macOS or Linux, signed in and syncing, Google Password Manager | Yes | Works in a Google-run service, not on the device (section 4). Chrome's older "Chrome profile" store has no PRF |
| Windows Hello on Windows 11 24H2/25H2, fully updated since about February 2026 | Yes | Chrome/Edge 147+ or Firefox 147+ for results at set-up; Hello reports no PRF support at set-up unless a salt is passed |
| Windows 10, or older Windows 11 builds, with Windows Hello | No | Chrome's Google passkeys work instead |
| Firefox on Linux | Only with a security key or a browser-extension password manager | No built-in passkey store |
| Third-party managers | Varies | Work: 1Password's browser extension, Proton Pass, Enpass, Keeper. Get only: Samsung Pass. Don't work: Dashlane, NordPass, Microsoft's password manager in Edge (set-up works, opening fails). Bitwarden: inconsistent |
| Phone used by scanning a QR code on a computer | Avoid | iPhones on iOS 18.0–18.3 gave wrong values this way; a 2026 report says it can still happen |

There's no way to know in advance whether the passkey a person picks supports PRF:
`getClientCapabilities()['extension:prf']` says whether the browser handles the extension,
not whether that passkey's provider will. Only the set-up itself can tell, and a failed
set-up leaves a useless passkey behind.

The copy of Slynk that runs on a person's own computer serves its page at `127.0.0.1`,
and WebAuthn doesn't accept an IP address as a site's identity, so it couldn't offer this.

## 4. What it would mean for privacy

- **Anyone who can unlock the device could open the inbox.** That means anyone who knows
  its passcode, PIN or password, or whose face or fingerprint is set up on it (an iPhone's
  "alternate appearance" can be anyone's face). That is weaker than typing the 12 words for
  someone who shares, or is made to unlock, their phone. iPhone's Stolen Device Protection
  can insist on Face ID or Touch ID away from familiar places, but only if it's switched on.
- **The passkey is a visible, lasting trace.** It appears as "slynk.me" in the person's
  saved passwords on every device that syncs them, until they delete it. A website can't
  ask for a passkey that doesn't sync.
- **What Google can see.** With Chrome's sync on, the passkey's site, account name, user ID
  and when it was created and last used reach Google's sync servers without sync
  encryption, unless the person set a sync passphrase. The last-used time updates on every
  use.
- **Chrome on a computer uses a Google service each time.** With Google Password Manager on
  desktop, every set-up and unlock goes to a Google-run "enclave" service, tied to the
  Google account, carrying the site, the salt and the passkey's encrypted record; the PRF
  result is computed there. Chrome doesn't currently verify the service's attestation.
- **Phones as authenticators over a QR code** use Bluetooth plus a relay run by Google or
  Apple, which sees internet addresses and timing (the content is end-to-end encrypted).
- **Malicious software on the device** defeats it: it can read the sealed words and the
  salt, and on a desktop with Google's passkeys it has been shown to sign without the
  person. Passkey unlock doesn't protect against that.
- **Private windows:** IndexedDB is gone when the window closes, but a passkey made there
  stays in the password manager. The option shouldn't be offered there.
- **Deleting the passkey:** Chrome hides it, shows a "passkey deleted" message, and removes
  it for good after 30 days. What Apple does with the signal isn't documented.

## 5. Why it's shelved

Convenience is the whole point, and the convenience is uneven: whether it works depends on
the device, the browser and the password manager, and a page can only find out by trying,
leaving a dead passkey behind when it fails. Where it does work, it trades the inbox's
strongest protection, the 12 words, for the device's unlock, and adds a synced record
that the person uses Slynk, and on desktop Chrome a Google service in every unlock. For a
tool whose inboxes are meant to be anonymous, those are real costs.

"Remember my passphrase", with or without a password, gives most of the convenience with
none of the third parties, and its warnings can say plainly what it risks. If passkey
support settles, and especially if a page can learn in advance whether a passkey offers
PRF, this is worth looking at again.

## 6. Notes for building it

- **The security header must change first.** Slynk's `Permissions-Policy` sends
  `publickey-credentials-get=()` ([web/public/.htaccess](../../web/public/.htaccess)),
  which makes every `get()` fail at once in Chrome and Edge (Safari and Firefox ignore the
  header, so testing there hides it). It would become
  `publickey-credentials-get=(self), publickey-credentials-create=(self)`.
- **Use the same user verification every time** (`'required'` on both calls): an
  authenticator can hold different secrets with and without it.
- **Branch on `prf.results?.first`, never `prf.enabled`.** Chrome reports them separately,
  and Windows Hello can say "not enabled" while returning results. Wrap results in
  `new Uint8Array()`: one extension returns a plain array.
- **Always list `'internal'` in `allowCredentials[].transports`:** Firefox 156+ on macOS
  15–26.3 sends a request without it to its security-key-only code.
- **No tap is needed before the calls** (Safari dropped that rule in 17.4), but the page
  must have focus, and the calls must never overlap. A second tap before the `get()` at
  set-up avoids focus and rate-limit trouble.
- **WebAuthn isn't available in Web Workers:** the ceremony runs on the page.
- **http://localhost works for development** (127.0.0.1 doesn't). A passkey made there is a
  real one in the developer's password manager. Firefox's WebDriver virtual authenticator
  is handy for tests, but its PRF ignores the credential, so it can't test "another passkey
  doesn't open it".
- **A copy of Slynk on its own domain** gets its own, unrelated passkeys. Any page on a
  subdomain of slynk.me could claim slynk.me's, so its subdomains must stay Slynk's own.

## 7. Open questions

- Whether Apple's Passwords app hides or deletes a passkey on `signalUnknownCredential`.
- What Apple's servers see of a synced passkey's details.
- Whether adding or removing a fingerprint or face ever changes a passkey's PRF output (no
  vendor says; for synced passkeys it shouldn't).
- Whether the 2026 reports of Apple passkeys giving different values across devices or iOS
  versions are fixed.
- Safari on http://localhost (should work; untested).

## Sources

- W3C Web Authentication Level 3 (PRF: §10.1.4; Permissions Policy: §5.9; signal methods:
  §5.1.10; privacy: §14.5.2): https://w3c.github.io/webauthn/
- FIDO CTAP 2.2 (hmac-secret; hybrid transport §11.5):
  https://fidoalliance.org/specs/fido-v2.2-ps-20250714/fido-client-to-authenticator-protocol-v2.2-ps-20250714.html
- Safari release notes (18: PRF; 26: Signal API; 26.4: PRF with security keys):
  https://developer.apple.com/documentation/safari-release-notes
- Apple: passkeys on iPhone, https://support.apple.com/guide/iphone/use-passkeys-to-sign-in-to-websites-and-apps-iphf538ea8d0/ios ;
  Stolen Device Protection, https://support.apple.com/en-us/120340 ;
  developer forum threads 764730, 774111, 822523 and 747036 on developer.apple.com/forums
- Google: Security of passkeys in Google Password Manager,
  https://security.googleblog.com/2022/10/SecurityofPasskeysintheGooglePasswordManager.html ;
  supported environments, https://developers.google.com/identity/passkeys/supported-environments ;
  the WebAuthn Signal API, https://developer.chrome.com/docs/identity/webauthn-signal-api
- Chromium source: `components/sync/protocol/webauthn_credential_specifics.proto`,
  `components/sync/base/data_type.cc`, `device/fido/enclave/`, `device/fido/win/`,
  `third_party/blink/renderer/modules/credentialmanagement/`
- Firefox source: `dom/webauthn/WebAuthnService.cpp`, `dom/webauthn/PublicKeyCredential.cpp`;
  Bugzilla 1935280, 1993280, 1531012
- WebKit: bug 264444 (gesture rule removed), `WebAuthenticatorCoordinatorProxy`
- Microsoft: passkeys in Windows, https://support.microsoft.com/en-us/windows/passkeys-in-windows-301c8944-5ea2-452b-9886-97e4d2ef4422 ;
  Windows Hello for Business PIN reset, https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/pin-reset
- Yubico, Developer's guide to PRF: https://developers.yubico.com/WebAuthn/Concepts/PRF_Extension/Developers_Guide_to_PRF.html
- Corbado, PRF support across providers (2026): https://www.corbado.com/blog/passkeys-prf-webauthn
- Bitwarden, Windows Hello PRF fix: https://github.com/bitwarden/clients/pull/21998
- Palo Alto Networks Unit 42, passkey malware research (2026):
  https://unit42.paloaltonetworks.com/passwordless-authentication-security-risks/

— Slynk
