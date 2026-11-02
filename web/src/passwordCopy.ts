// Wording for password links (password.ts). Every line must stay true:
// - The password never leaves the browser, so nobody (slynk.me included) can
//   reset it or open the link without it.
// - A wrong password never uses up a one-time link (the page checks it before
//   asking slynk.me for its half of the key), but only the About page says so.
// - Say "pass it on separately", not "send it a different way", which reads
//   like something to do on this site.
// - Keep the screens plain: how it works (Argon2id, the salt, which layer
//   comes first) is on the About page, not here.
//   password-copy.test.ts checks the About page says it.

// --- Sender: choosing ----------------------------------------------------------------

export const PASSWORD_LABEL = 'Lock with a password'
/** The box starts with suggested words: say they can be swapped. */
export const PASSWORD_HELP =
  'Use the suggested words or type your own. Your recipient will need it as well as the link, so pass it to them separately.'
/** In the box if the sender clears it. */
export const PLACEHOLDER = 'Type a password'
/** Read by screen readers for the password box. */
export const PASSWORD_FIELD = 'Password'
export const NEW_WORDS = 'New words'
/** Added to the closed "Link options" line. */
export const SUMMARY = 'Password'

/** On the Send button while the password won't do. */
export const TOO_SHORT = (min: number) => `Use a password of at least ${min} characters`
export const TOO_LONG = (max: number) => `Use a password of at most ${max} characters`

// --- Sender: sending -----------------------------------------------------------------

export const LOCKING = 'Locking it with your password…'
export const LOCK_FAILED = 'Couldn’t lock it with your password. Reload the page and try again.'

// --- Sender: after sending -------------------------------------------------------------

export const SENT_LABEL = 'Password'
export const SENT_NOTE = 'Your recipient will need this password too. Pass it to them separately from the link.'
// index.html: "Anyone with this link[ and its password] can open it until …"

// --- Recipient --------------------------------------------------------------------------

export const NEEDED = 'This link is locked with a password. Ask the sender if you don’t have it.'
/** Visible label of the recipient's password box. */
export const FIELD_LABEL = 'Password'
/** The eye inside it: its name for screen readers, and its tooltip as it shows what's typed or stops (no "hide" in this wording). */
export const SHOW = 'Show the password'
export const STOP_SHOWING = 'Stop showing the password'
export const CHECKING = 'Checking the password…'
/** The same for every kind of link: saying a wrong guess costs nothing gives too much away. */
export const WRONG = 'That password didn’t work. Check it and try again.'
/** The button once it has arrived and only the password is left. */
export const UNLOCK_BUTTON = 'Unlock'

export const CHECK_FAILED_TITLE = 'Couldn’t check the password'
export const CHECK_FAILED = 'Try again. If it keeps happening, reload the page and open the link again.'
