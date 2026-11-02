// Wording for the anonymous inbox's screens, kept together
// so it can be reviewed, approved and tested in one place. Screens say what
// an inbox is for and what happens; how it works (keys, the mixnet, the
// look-back) is on the About page. Never "tips": say messages.
//
// Retention: the network keeps messages for about 500 hours. Opening an
// inbox looks back that far; an 18-day look-back has been tested on mainnet
// (2026-10-31, docs/findings/notes.md), so screens say
// "up to about three weeks" for how long messages wait, and ask owners to
// open their inbox at least once a week.
//
// Names: an inbox's codename can't be a point of contact without a directory,
// so no screen shows one. The link (or QR code) is the address; owners give
// their inbox a label of their own, and name the inboxes they write to in an
// address book.
//
// Replies: a sender who has their own inbox open may include it, with a name
// to show if they like. Anonymous stays the default. A name is only what they
// chose to be called, so it's shown as their suggestion, isolated from the
// text around it, and the owner is warned when it changes or looks like
// someone else's. Never a codename: "Sender 1", "Sender 2".
import { FILE_PREFIX, SITE_ADDRESS, SITE_NAME } from '../site.ts'

/** Text with names in it: each name is shown isolated (a <bdi>), so it can't reorder the words around it. */
export type Part = string | { name: string }

// --- Heroes (the big text above the card) -------------------------------------

export const HERO_SENDER = {
  eyebrow: 'Anonymous inbox',
  title: ['Write to them ', 'anonymously.'],
  lede: 'Your message is encrypted in your browser so that only the inbox’s owner can read it, then mixed in with everyone else’s traffic on the xx network. No account, and nothing to keep.',
}

export const HERO_CREATE = {
  eyebrow: 'Anonymous inbox',
  title: ['Let people reach you ', 'anonymously.'],
  lede: 'A private address anyone can write to, without an account, a name or an email address.',
}

export const HERO_OPEN = {
  eyebrow: 'Anonymous inbox',
  title: ['Read your ', 'messages.'],
  lede: `Type your passphrase, or restore your inbox from a backup file. ${SITE_NAME} remembers your passphrase only if you ask it to.`,
}

// --- Footer ----------------------------------------------------------------------

/** At the top of the inbox's own screens (creating one, opening one), so nobody is stranded there. */
export const BACK_HOME = 'Back to the front page'
export const FOOTER_CREATE = 'Create an anonymous inbox'
export const FOOTER_OPEN = 'Unlock my inbox'

// On the front page, under the main card, while no inbox is open or kept on this device.
export const ENTRY_TITLE = 'Anonymous inbox'
export const ENTRY_LEAD =
  `An anonymous inbox is different to ${SITE_NAME} links: a permanent address anyone can write to, as often as they need, without saying who they are.`
/** Who it's for, so it isn't taken for a general messenger: the good causes, as on the creation screens. */
export const ENTRY_FOR =
  'Made for organisations people need to reach in confidence, such as refuges, support services, charities, newsrooms, whistleblowing channels and advice services.'
/**
 * Short enough for one line on a tile: the card's heading already says "Anonymous inbox".
 * "Create", not "Get": "Get an inbox" was taken for somewhere to send a link to.
 */
export const ENTRY_CREATE = 'Create an inbox'
/**
 * New or existing, since both end in the inbox; what an inbox is for is the card's lead. Asked as
 * the composer's "Want a reply? … Already got one?" asks. Long enough to take two lines on a phone,
 * as the Unlock tile's does, so the two are the same height.
 */
export const ENTRY_CREATE_SUB = 'Don’t have one yet? Make one, no account needed'
// "Unlock", not "Open": beside "Create an inbox", "open" sounded like making one. It pairs
// with the inbox's own Lock button, and says the inbox is there already, behind its passphrase.
export const ENTRY_OPEN = 'Unlock my inbox'
export const ENTRY_OPEN_SUB = 'Already have one? Unlock it with your passphrase'
/** Making a second inbox while this device keeps one: the way to it is hidden, and this says why. */
export const CREATE_KEPT = 'This device already keeps an inbox. To make a new one, forget it first.'

// --- Creating an inbox: what it's for ------------------------------------------------

// "Who": what follows is mostly who it's made for.
export const PURPOSE_TITLE = 'Who an anonymous inbox is for'
export const PURPOSE_LEAD =
  `An anonymous inbox is different to ${SITE_NAME} links: a permanent address you can publish, so anyone can write to you, as often as they need to, without an account, a name or an email address. You won’t learn who they are unless they tell you.`
export const PURPOSE_FOR = 'It’s made for organisations that people need to contact in confidence, such as:'
export const PURPOSE_USES = [
  'Refuges and support services',
  'Charities',
  'Journalists and newsrooms',
  'Whistleblowing and staff-concern channels',
  'Advice services',
]
/** Under the list: an inbox of one's own is also how to get replies from them. */
export const PURPOSE_REPLY = 'Writing to one of them? With your own inbox, they can reply to you.'
export const PURPOSE_BASE =
  `Put its link or QR code on your website, posters or leaflets, and you have a place on ${SITE_NAME} where anyone can reach you safely. You can make one just for yourself, too.`
export const PURPOSE_YOURS = 'Only you can read what arrives: you open your inbox with a passphrase that only you hold.'
export const PURPOSE_HELD = `Messages never go to ${SITE_ADDRESS}. They wait on the xx network, and on your device if you choose.`
export const PURPOSE_TRUST = 'People will trust you with what they write. Look after it as your organisation’s rules for sensitive information require.'
export const PURPOSE_HOW = 'How does it work?'
/** Opens the comparison with messaging apps; short, to sit beside PURPOSE_HOW on a phone. */
export const PURPOSE_COMPARE = 'How it compares'
export const PURPOSE_NEXT = 'Next'

// --- A name for the owner's own screens (never an address) -------------------------

export const LABEL_TITLE = 'Name it for yourself'
export const LABEL_LEAD = 'A name for your own screens, like “Staff concerns”, so you can tell which inbox is open. You can skip it, and change it later.'
export const LABEL_NOT_ADDRESS =
  'Only you see it. It isn’t an address: people can’t find or write to your inbox by this name, only through its link or QR code.'
export const LABEL_FIELD = 'Its name (optional)'
export const LABEL_PLACEHOLDER = 'e.g. Staff concerns'
export const LABEL_NEXT = 'Next'

// --- The 12 words -------------------------------------------------------------------

export const WORDS_TITLE = 'Your 12-word passphrase'
/**
 * Friendly, but plain that it's all on them: self-custody, said kindly.
 * No "we": Slynk's voice is what's true of it.
 */
export const WORDS_WARNING =
  'It’s a lot to look after, but it’s what keeps your inbox yours: this passphrase is the only way in, and you alone hold it. So keep it secret, and somewhere safe.'
export const WORDS_SAVE = 'Write it down, or keep it in a password manager.'
export const WORDS_COPY = 'Copy the passphrase'
export const WORDS_COPIED = 'Words copied'
// Saving the passphrase as a file (keyfile.ts), on the last step under "Remember my passphrase", only while
// that's off ("key file", then "passphrase file", read as something else; it's the passphrase, saved.
// "Save to this device" sounded like remembering it, so it says what's different).
// No "Or": neither this nor remembering it is needed; and "Back up", which says
// what it's for (its button says what it does). "(optional)": it comes before the link.
export const KEYFILE_TITLE = 'Back up your passphrase (optional)'
export const KEYFILE_WHY = 'To unlock your inbox elsewhere, without this device remembering it'
export const KEYFILE_HELP =
  'This saves it as a small backup file, protected by a password of its own, so you can unlock your inbox without typing your passphrase, on this device or another. Keep the file and its password apart.'
export const KEYFILE_PASSWORD = 'A password for the backup file'
/**
 * Fills the blank box with a suggested password, shown (the box starts blank). "New words" read
 * like new inbox words beside the 12.
 */
export const KEYFILE_NEW = 'Suggest a password'
export const KEYFILE_SAVE = 'Save backup file'
export const KEYFILE_SAVING = 'Making the backup file…'
export const KEYFILE_SAVED = 'Saved · save again'
export const KEYFILE_FAILED = 'Couldn’t make the backup file. Try again.'
export const WORDS_NEXT = 'I’ve saved them'

// --- Checking the words ---------------------------------------------------------------

export const CHECK_TITLE = 'Check your passphrase'
export const CHECK_LEAD = (numbers: number[]) =>
  `To be sure they’re saved, type words ${numbers[0]}, ${numbers[1]} and ${numbers[2]} from your list.`
export const CHECK_LABEL = (n: number) => `Word ${n}`
export const CHECK_WRONG = 'That’s not quite right. Check the passphrase you saved.'
/** The last step's button: Finish, not Check. */
export const CHECK_NEXT = 'Finish'
/** Beside Finish, short enough to share its line on a phone, so it's in sight before the page's own Back. */
export const CHECK_BACK = 'Show phrase again'

// --- Ready to share --------------------------------------------------------------------

export const READY_TITLE = 'Your inbox is ready'
export const READY_SHARE = 'This is your inbox link. Share it or its QR code wherever people should find you.'
export const READY_SAVE_QR = 'Save QR code'
/**
 * The link and QR code, folded away under the choices, so the screen isn't taken for the end of the
 * road.
 */
export const READY_SHOW = 'Show inbox link / QR code'
/**
 * Inside the fold, last: not the only chance (so they're very aware of it), plainly,
 * not bold, with the inbox's own Share button named as it's labelled.
 */
export const READY_AGAIN = 'You don’t have to use it yet. To see it again, choose “Share” in your inbox.'
/**
 * Where to put it, for anyone people need to reach in confidence (organisations,
 * activists, journalists, support workers alike), with what was READY_CHECK: on a website, people can check
 * the inbox is really theirs.
 */
export const READY_WHERE =
  'If people need to reach you in confidence, put the code wherever they’ll see it: on posters, leaflets and notice boards, and on your website, where they can check it’s really yours.'
export const READY_KEEP =
  'To read messages later, choose “Unlock my inbox” on the front page and use your passphrase. Open it at least once a week: messages wait on the xx network for up to about three weeks.'
export const READY_OPEN = 'Open my inbox now'

// --- Two addresses: tabs where one is shared, markers on messages -------------------------
// Every inbox has two addresses from the same 12 words: its secure (compact)
// one and a quantum-safe one. One inbox, rather than a tab for each address:
// its messages in one list, each with a marker, a padlock (secure) or an atom
// (quantum-safe); the two addresses as tabs only where one is shared, on the
// ready screen and in Share, which opens on the one shared last.

/** The two addresses' tabs, on the ready screen and in Share: without "inbox", as it's one inbox. */
export const TAB_SECURE = 'Secure'
export const TAB_QS = 'Quantum-safe'
export const TABS_LABEL = 'Your inbox’s two addresses'
/** New message: which kind of inbox the box holds, once it holds an address. */
export const KIND_SECURE = 'Secure inbox'
export const KIND_QS = 'Quantum-safe inbox'
/** The quantum-safe tab's lead on the ready screen, in place of READY_SHARE. */
export const READY_SHARE_QS = 'This is your inbox’s quantum-safe link. It’s longer than usual, and its QR code more detailed: print the code larger, and scan it from closer.'
export const READY_QR_FILE = (qs: boolean) => (qs ? `${FILE_PREFIX}-quantum-safe-inbox-qr.svg` : `${FILE_PREFIX}-inbox-qr.svg`)
/** Opens the explainer: on the ready screen's quantum-safe tab, and the (i) and a marker's note on a sender's card. */
export const QS_WHAT = 'What’s a quantum-safe inbox?'
/** The (i) beside the tabs (the ready screen, Share), and the link in a marker's note on the owner's screens. */
export const TABS_WHAT = 'About your inbox’s two addresses'
/** The explainer (dialog #qs-why), as plain as it gets: why it exists, what it costs, and the honest line. */
export const QS_TITLE = 'A quantum-safe inbox'
export const QS_WHY = [
  'Messages to an inbox are encrypted so that only its owner can open them. One day a quantum computer, a powerful new kind of computer, may be able to break that encryption which most apps use today, even on messages someone copied years before. A quantum-safe inbox is there for people in the most extreme circumstances.',
  'Messages to it are also encrypted a newer way, built to hold even then.',
  'It’s the same inbox, from the same passphrase, with a longer link and a more detailed QR code.',
  'Initial messages to a quantum-safe inbox, or those not in a conversation, are intentionally slower to send, to add a small amount of extra privacy. Not many people send quantum-safe messages yet, so the way they’re sent could stand out. Senders can safeguard their network privacy further, for example by using a VPN.',
  'No other app on the xx network is known to have an address like this: one you can share openly, for private messages protected against quantum computers.',
]
/**
 * From the (i) beside the atom on a sender's card, and a marker's note there: a short explainer,
 * the About page's answer for more. Every two-piece message is spread over two rounds, with no
 * switch, so it says only that it's slower.
 */
export const QS_SHORT = [
  'Messages to a quantum-safe inbox are encrypted so that only its owner can open them, in a way built to hold even against the quantum computers of the future.',
  'Sending can take a little longer when you write to them for the first time, or anonymously: that adds a little more privacy.',
]
/** From the owner's screens, first: the two addresses, and the markers on their messages. */
export const TABS_TITLE = 'Your inbox’s two addresses'
export const TABS_WHY = [
  'Your inbox has two addresses, made from the same passphrase: a secure one and a quantum-safe one. People can write to either at any time, and every message comes to this one inbox, marked with a padlock (secure) or an atom (quantum-safe). Replies in a quantum-safe conversation are quantum-safe too.',
  'For most people, the secure one is all they need.',
]
/** A marker's name (for screen readers, and on hover), and what it means in one line, shown when it's tapped. */
export const MARK_SECURE = 'Secure'
export const MARK_QS = 'Quantum-safe'
export const MARK_SECURE_NOTE = 'Secure: encrypted so that only the inbox it was sent to can open it.'
export const MARK_QS_NOTE = 'Quantum-safe: also encrypted a newer way, built to hold even against a future quantum computer.'
/**
 * In a conversation marked quantum-safe, when the reply can only go to their secure address the
 * standard way: neither their quantum-safe address nor reply keys from them, as in a
 * conversation from before reply keys.
 */
export const CHAT_NOT_QS = 'This reply goes to their secure inbox: not quantum-safe.'

// --- Opening an inbox ---------------------------------------------------------------------

export const OPEN_TITLE = 'Unlock your inbox'
export const OPEN_WORDS_LABEL = 'Your 12-word passphrase'
/** The eye inside the words box: its name for screen readers, and its tooltip as it shows or hides them. */
export const OPEN_SHOW = 'Show the passphrase'
export const OPEN_HIDE = 'Hide the passphrase'
// "Restore", the other half of "Back up"; not only the passphrase since a backup can
// hold messages too. keyfile.ts says it in every backup file.
export const OPEN_USE_FILE = 'Restore from a backup file'
/** Under the file, once one holding messages is chosen: restoring it keeps the inbox on this device (the switch goes on). */
export const OPEN_FILE_MESSAGES = 'This backup holds messages too, so restoring it keeps your inbox and its messages on this device.'
/** Once a backup's messages are back. */
export const RESTORED = (n: number) => (n ? `${OWNER_COUNT(n)} restored from your backup.` : 'Restored from your backup.')
/** The same, where this device couldn't keep the inbox (another tab has it open, or its storage failed). */
export const RESTORED_TAB = (n: number) => `${n ? `${OWNER_COUNT(n)} restored` : 'Restored'} in this tab only: this device couldn’t keep your inbox.`
export const OPEN_FILE_LABEL = 'Your backup file'
export const OPEN_FILE_PASSWORD = 'The backup file’s password'
export const OPEN_BUTTON = 'Unlock inbox'
export const OPEN_CHECKING = 'Checking…'
export const OPEN_BAD_WORDS = 'That passphrase doesn’t open an inbox. Check each word and their order.'
export const OPEN_NOT_KEY_FILE = `That isn’t a ${SITE_NAME} backup file.`
export const OPEN_NEWER_KEY_FILE = `That backup file was made by a newer version of ${SITE_NAME}. Reload the page and try again.`
export const OPEN_WRONG_PASSWORD = 'That password doesn’t open this backup file.'
export const OPEN_KEY_FAILED = 'Couldn’t open the backup file here. Try again.'
export const OPEN_ALREADY = 'An inbox is already open in this tab. Lock it first.'
export const OPEN_KEEP = 'Keep this inbox on this device'
export const OPEN_KEEP_HELP =
  'Your messages, folders and what you’ve read stay here, encrypted with your passphrase, even after the xx network lets them go. Opening is quicker next time, too.'
export const OPEN_KEEP_MORE = 'What this means'

// --- The owner's inbox, alongside the composer -------------------------------------------

export const OWNER_KIND = 'Anonymous inbox'
/** The card's heading when the owner hasn't named their inbox. */
export const OWNER_LABEL = 'Your inbox'
export const OWNER_RENAME = 'Rename'
export const OWNER_RENAME_LABEL = 'A name for your own screens'
export const OWNER_RENAME_SAVE = 'Save'
export const OWNER_RENAME_CANCEL = 'Cancel'
export const OWNER_SHARE = 'Share'
export const OWNER_HIDE_SHARE = 'Hide'
export const OWNER_LOCK = 'Lock'
/** remembered: its words are remembered here, 'password' when encrypted with the owner's password. */
export const OWNER_LOCK_ASK = (kept: boolean, remembered: false | 'plain' | 'password' = false) =>
  remembered === 'password'
    ? 'Lock your inbox? Your passphrase is remembered on this device, encrypted with your password: to unlock it again you’ll need that password or your passphrase.'
    : remembered
    ? 'Lock your inbox? Your passphrase is remembered on this device, so anyone using this browser can unlock it again with a tap.'
    : kept
      ? 'Lock your inbox? To unlock it again you’ll need your passphrase. What’s kept on this device stays here, encrypted.'
      : 'Lock your inbox? To unlock it again you’ll need your passphrase. Messages stay on the xx network.'
export const OWNER_LOCK_YES = 'Lock it'
export const OWNER_LOCK_NO = 'Keep it open'
export const OWNER_LOCKED = 'Inbox locked'
export const OWNER_LOCK_BUSY = 'Wait for this to finish, then lock it'
/** Files the owner sent from a conversation are uploaded, but the message telling them failed. */
export const OWNER_LOCK_UNTOLD = 'They haven’t been told about files you sent. Try again, or remove them, first.'
export const OWNER_CONNECTING = 'Connecting to the mixnet…'
export const OWNER_JOINING = (pct: number) => `Joining the mixnet… ${pct}%`
export const OWNER_LOOKING = (left: number, total: number) =>
  total > 1 ? `Looking back through the last ${total} days for messages… ${total - left} of ${total} done` : 'Looking back for messages…'
export const OWNER_COLLECTING = 'Collecting the last few messages…'
/** A kept inbox whose last look-back was cut short: only the days it didn't reach. */
export const OWNER_RESUMING = (left: number, total: number) =>
  total > 1 ? `Carrying on where it left off last time… ${total - left} of ${total} days done` : 'Carrying on where it left off last time…'
export const OWNER_FINISHED = 'Finished looking back. New messages appear here while this tab is open.'
export const OWNER_FINISHED_MISSING =
  'Finished looking back, but the xx network hasn’t handed everything over yet. Anything it does hand over, and any new messages, appear here while this tab is open.'
export const OWNER_NONE = 'No messages waiting.'
// Keeping the inbox on this device (inbox/kept.ts)
export const KEEP_ON = 'Kept on this device'
export const KEEP_FORGET = 'Forget this device'
export const KEEP_OFF = 'Only in this tab'
export const KEEP_START = 'Keep on this device'
export const KEEP_ELSEWHERE = 'Open in another tab too, so changes here aren’t kept.'
export const KEEP_STARTED = 'Kept on this device'
/** Offered while an inbox that isn't kept looks back through everything, and after until answered. */
export const KEEP_OFFER = 'Opening takes a couple of minutes each time. Keep your inbox on this device and next time it only checks what’s new.'
export const KEEP_OFFER_NO = 'Not now'
export const KEEP_FAILED = 'Couldn’t keep it on this device: this browser didn’t allow it.'
export const KEEP_UNREADABLE = 'Something kept on this device for your inbox couldn’t be read, so it was left as it is.'
/** The browser's storage didn't answer when the inbox opened: what's kept may not show this time. */
export const KEEP_READ_FAILED = 'Couldn’t read what’s kept on this device this time. Lock and open your inbox again to try once more.'
export const FORGET_ASK =
  'Forget this device? Everything kept here for this inbox is deleted, and the inbox locks. Messages still on the xx network come back next time you open it; older ones are gone for good.'
/** Added to Forget's question when the words are remembered here: their only copy may be this one. */
export const FORGET_ASK_WORDS = 'Your remembered passphrase goes too, so make sure you have it written down or backed up.'
export const FORGET_YES = 'Forget it'
export const FORGET_NO = 'Keep it'
export const FORGOTTEN = 'Forgotten on this device, and locked'
/** Forget locks the inbox too, so it waits for what Lock waits for. */
export const FORGET_BUSY = 'Wait for this to finish, then forget it'
// "Remember my passphrase on this device" (typing them every time is a faff, and password managers
// didn't reliably offer to save them). Off unless switched on, after these
// warnings; it goes with keeping the inbox here.
// No "on this device" (it wrapped on a phone): the line under it says "here".
export const REMEMBER_LABEL = 'Remember my passphrase'
export const REMEMBER_HELP = 'Unlock your inbox here without typing your passphrase. Off unless you switch it on.'
export const REMEMBER_WARN_TITLE = 'Only if this device is yours alone'
export const REMEMBER_RISK_ANYONE = 'Without a password, anyone who can use this browser can open your inbox: read every message, and write to people as you.'
export const REMEMBER_RISK_PLAIN =
  'Without a password, your passphrase is saved as it is, not encrypted. Someone who copies it from this device can open your inbox from anywhere.'
/** The same two, once a password is typed: what it changes, and what it doesn't. */
export const REMEMBER_RISK_ANYONE_PW = 'Anyone who can use this browser and knows your password can open your inbox: read every message, and write to people as you.'
export const REMEMBER_RISK_PLAIN_PW =
  'Your passphrase is encrypted with your password, and so is everything kept with it. Someone who copies it from this device could still try to guess the password, so make it long and unusual.'
export const REMEMBER_RISK_FOREVER = 'An inbox’s passphrase can never be changed. If it gets out, the only fix is a new inbox.'
export const REMEMBER_RISK_LOCK = 'Lock this device with a passcode, and don’t use this on a shared or work computer.'
/** The warnings, as they read with or without a password typed. */
export const REMEMBER_RISKS = (password: boolean) =>
  password
    ? [REMEMBER_RISK_ANYONE_PW, REMEMBER_RISK_PLAIN_PW, REMEMBER_RISK_FOREVER, REMEMBER_RISK_LOCK]
    : [REMEMBER_RISK_ANYONE, REMEMBER_RISK_PLAIN, REMEMBER_RISK_FOREVER, REMEMBER_RISK_LOCK]
/**
 * An optional password for the remembered words, under the warnings:
 * with one, they're encrypted on the device (keyfile.ts, sealWords), and so is what's kept with them,
 * since its key comes from the words. Asked for each time the inbox opens from them.
 */
export const REMEMBER_PW_LABEL = 'A password for your passphrase (optional)'
export const REMEMBER_PW_HELP = 'With one, your passphrase is encrypted on this device, and you type the password to open your inbox here. Forget the password, and your passphrase still opens your inbox.'
/** The box to type it again in, shown once a password is typed, and what's said if the two differ. */
export const REMEMBER_PW_AGAIN = 'Confirm your password'
export const REMEMBER_PW_MISMATCH = 'The two passwords don’t match.'
/** The eye inside the box: its name for screen readers, and its tooltip. */
export const REMEMBER_PW_SHOW = 'Show the password'
export const REMEMBER_PW_HIDE = 'Hide the password'
/**
 * "Show my passphrase…", in the inbox's menu when its words are remembered with a password: a card on
 * top asks for it, then shows them, until it closes.
 */
export const SHOW_WORDS = 'Show my passphrase…'
export const SHOW_WORDS_TITLE = 'Your 12-word passphrase'
export const SHOW_WORDS_LEAD = 'Type the password you gave your remembered passphrase to see it.'
export const SHOW_WORDS_PW = 'Password'
export const SHOW_WORDS_GO = 'Show'
export const SHOW_WORDS_CHECKING = 'Checking…'
export const SHOW_WORDS_WRONG = 'That password doesn’t open it.'
export const SHOW_WORDS_FAILED = 'Couldn’t read the remembered passphrase on this device.'
export const SHOW_WORDS_CAREFUL =
  'Make sure nobody can see your screen. This passphrase is yours alone to hold: anyone who has it can read everything sent to your inbox, and nobody can get it back for you. Write it down, or keep it in a password manager.'
/** Opening an inbox whose words are remembered with a password. */
export const OPEN_REMEMBERED_PW_LABEL = (label: string) => (label ? `Password for ${label}` : 'Password for your remembered passphrase')
export const OPEN_REMEMBERED_PW_GO = 'Open'
export const OPEN_REMEMBERED_PW_WRONG = 'That password doesn’t open it. Try again, or type your passphrase instead.'
export const OPEN_REMEMBERED_PW_CHECKING = 'Checking…'
/** From the inbox's menu, where the page no longer has the words: typed once more, which also shows it's the owner. */
export const REMEMBER_TYPE = 'Type your passphrase once more to remember it'
export const REMEMBER_YES = 'Remember my passphrase'
export const REMEMBER_NO = 'Cancel'
export const REMEMBER_WRONG = 'That isn’t this inbox’s passphrase.'
// "Back up your passphrase…" from the inbox's menu: the file is otherwise offered only
// as the inbox is made. The passphrase is typed once more, since the page doesn't keep it once the inbox is unlocked.
// "Back up your inbox…" since it can hold the messages too: one kind of file, one name.
export const SAVEFILE_START = 'Back up your inbox…'
export const SAVEFILE_TYPE = 'Type your passphrase once more to back up your inbox'
export const SAVEFILE_HELP =
  'This saves a backup file, protected by a password of its own, so you can restore your inbox on this device or another, with its messages if you include them. Keep the file and its password apart.'
export const SAVEFILE_ALL = 'Include its messages'
export const SAVEFILE_ALL_HELP = (n: number) => `${n ? `${OWNER_COUNT(n)}, your` : 'Your'} replies, folders and names. Files sent to you aren’t included.`
export const SAVEFILE_CLOSE = 'Close'
export const REMEMBER_START = 'Remember my passphrase on this device…'
export const REMEMBER_FORGET = 'Forget my passphrase on this device'
export const REMEMBERED = (password: boolean) =>
  password ? 'Your passphrase is remembered on this device, encrypted with your password' : 'Your passphrase is remembered on this device'
export const WORDS_FORGOTTEN = 'Your passphrase is forgotten on this device. Your inbox is still kept here.'
/** "Forget my passphrase on this device" asks first: the words may be kept nowhere else. */
export const WORDS_FORGET_ASK = 'Forget your passphrase on this device? To open your inbox again you’ll need it, so make sure you have it written down or backed up.'
export const WORDS_FORGET_YES = 'Forget my passphrase'
export const WORDS_FORGET_NO = 'Keep them'
/** Asked for, but the inbox couldn't be kept here (another tab has it open, or the browser refused). */
export const REMEMBER_SKIPPED = 'Your passphrase wasn’t remembered: this inbox couldn’t be kept on this device.'
/** Keeping stopped (the browser refused a save), but its words are still remembered here. */
export const KEEP_OFF_REMEMBERED = 'Only in this tab, but its passphrase is remembered here'
export const REMEMBER_FAILED = 'Couldn’t remember your passphrase: this browser didn’t allow it.'
export const KEEP_ON_REMEMBERED = 'Kept on this device, with its passphrase'
// The open screen, where words are remembered here: straight in.
export const OPEN_REMEMBERED_TITLE = 'Remembered on this device'
export const OPEN_REMEMBERED = (label: string) => (label ? `Unlock ${label}` : 'Unlock your inbox')
export const OPEN_REMEMBERED_FAILED = 'The remembered passphrase didn’t open an inbox. Type it instead.'
// The front page's inbox bar, while the inbox is open in this tab: straight back in, no words.
export const BAR_NEW = (n: number) => `${n} new`
export const BAR_NONE = 'No new messages'
export const BAR_CHECKING = 'Checking for messages…'
export const BAR_FAILED = 'Couldn’t open it'
// "Your link is ready", with an inbox open or kept here (a first-time sender expected to send to
// someone, not just get a link). It only copies the link and goes to the inbox:
// who it's for may be someone already written to, so no message is started.
export const SENT_TO_INBOX = 'Copy it and go to my inbox'
export const SENT_TO_INBOX_COPIED = 'Link copied. Paste it into a message in your inbox.'
export const BAR_OPEN = 'Open'
export const BAR_OPEN_LABEL = 'Open your inbox'
/** Back pressed where leaving would lose something (a one-time item on screen, a send under way). */
export const NAV_STAY = 'Finish here first. Your inbox stays open.'
/** A fold for what's good to know but not needed every time. */
export const MORE_ABOUT = 'Good to know'
// On the main page, when this device keeps an inbox (or more): open it, or forget it.
export const KEPT_HERE = (n: number) => (n === 1 ? 'Your inbox is kept on this device.' : `${n} inboxes are kept on this device.`)
export const KEPT_OPEN = (n: number) => (n === 1 ? 'Open it' : 'Open one')
export const KEPT_FORGET = (n: number) => (n === 1 ? 'Forget it' : 'Forget them')
/** Several kept, some by name (their words remembered): the open screen, for the others. */
export const KEPT_OPEN_OTHER = 'Open another'
export const KEPT_FORGET_ASK = (n: number, remembered = false) =>
  (n === 1
    ? 'Forget what’s kept on this device? Messages the xx network no longer holds will be gone for good. Your inbox still opens with its passphrase.'
    : 'Forget what’s kept on this device? Messages the xx network no longer holds will be gone for good. Your inboxes still open with their passphrases.') +
  (remembered ? ` ${FORGET_ASK_WORDS}` : '')
export const OWNER_FAILED = (reason: string) => `Couldn’t open your inbox: ${reason}`
export const OWNER_RETRY = 'Try again'
export const OWNER_COUNT = (n: number) => (n === 1 ? '1 message' : `${n} messages`)
export const OWNER_FLOOD =
  'Lots of messages have arrived. If they’re junk, you can make a new inbox and share that one instead.'
export const OWNER_MORE = (n: number) => `and ${n} more ${n === 1 ? 'message' : 'messages'} not shown`
export const MESSAGE_UNREADABLE = `A message this page can’t read (perhaps from a newer version of ${SITE_NAME})`
/** A message with nothing to show in it (only spaces, say): said, rather than an empty bubble. */
export const MESSAGE_EMPTY = 'An empty message'

// --- The list: folders and rows (inbox/mailbox.ts) -----------------------------------------

export const FOLDER_INBOX = 'Inbox'
export const FOLDER_ARCHIVE = 'Archive'
export const FOLDERS_LABEL = 'Folders'
/** Above the owner's own folders, on a line of their own under Inbox and Archive. */
export const FOLDERS_OWN = 'Your folders'
export const FOLDER_NEW = 'New folder'
export const FOLDER_NAME_LABEL = 'Folder name'
export const FOLDER_CREATE = 'Create'
export const FOLDER_CANCEL = 'Cancel'
export const FOLDER_RENAME = 'Rename folder'
export const FOLDER_SAVE = 'Save'
export const FOLDER_DELETE = 'Delete folder'
export const FOLDER_DELETE_ASK = (name: string) => `Delete “${name}”? Its messages go back to Inbox.`
export const FOLDER_DELETE_YES = 'Delete it'
export const FOLDER_DELETE_NO = 'Keep it'
export const FOLDER_TAKEN = 'You already have a folder with that name.'
export const FOLDER_FULL = 'That’s as many folders as an inbox can have.'
export const FOLDER_EMPTY = 'Nothing here.'
export const FOLDER_UNREAD = (n: number) => `${n} unread`
export const ROW_FROM = 'Anonymous'
export const ROW_MESSAGE = 'Message'
// The owner's own message to another inbox, sent with "Let them reply" off: in their Inbox, so
// they can check later what went where.
/** Before who it went to, on its row ("To Sam"). */
export const ROW_TO = 'To '
/** An inbox the owner has no name or number for. */
export const TO_AN_INBOX = 'an inbox'
export const ROW_MINE = 'Your message'
/** What kind of row it is, beside its small icon (for screen readers, and on hover). */
export const ROW_KIND = { thread: 'Conversation', in: 'One-way, received', out: 'One-way, sent by you' }
export const MINE_NOTE = 'You sent this without letting them reply: it didn’t say who it was from.'
/** After MINE_NOTE, a faint link: writes to the same inbox again. */
export const MINE_WRITE_AGAIN = 'Write to them again'
export const MINE_REMOVE_ASK = (kept: boolean) =>
  kept ? 'Remove your message for good? It won’t come back on this device. They still have it.' : 'Remove your message from the list? They still have it.'
export const ROW_UNREAD = 'Unread'
// Who a message is from, when its sender included their own inbox: the
// owner's own name for them, the name they gave, or their number.
export const FROM_NUMBER = (n: number) => `Sender ${n}`
/** On a row whose sender's name looks like someone else's. */
export const ROW_CAREFUL = 'Careful'
/** On a conversation's row, when a message of the owner's didn't send. */
export const ROW_FAILED = 'Didn’t send'

// --- Conversations: everything to and from one sender's inbox, as a chat --------------------

/** A conversation's row in the list: how many messages it holds. */
export const THREAD_COUNT = (n: number) => (n === 1 ? '1 message' : `${n} messages`)
/** A conversation the owner started, with an inbox they haven't named. */
export const THREAD_TO = 'An inbox you wrote to'
/** Under a name in the chat's heading: it's what they called themselves, not the owner's name for them. */
export const CHAT_GIVEN = 'the name they gave'
export const CHAT_BACK = (folder: string) => `Back to ${folder}`
export const CHAT_MORE = 'More for this conversation'
export const CHAT_LOG = (who: string) => `Your conversation with ${who}`
export const CHAT_LABEL = 'Your reply'
export const CHAT_PLACEHOLDER = 'Write a reply…'
export const CHAT_SEND = 'Send'
/**
 * At the top of a conversation with two or more of their messages and none of
 * the owner's: replies stay on the device they were sent from, so another
 * device shows only theirs. True whether or not the owner ever replied.
 */
export const CHAT_ELSEWHERE = 'Your replies from another device don’t show here.'
export const CHAT_TODAY = 'Today'
export const CHAT_YESTERDAY = 'Yesterday'
/** For screen readers, before each message. */
export const CHAT_FROM_YOU = 'You'
export const CHAT_SENDING = 'Sending…'
/** One of the owner's messages behind another still going: they go one at a time, in order. */
export const CHAT_QUEUED = 'Waiting to send…'
export const CHAT_SENT = 'Delivered'
export const CHAT_FAILED = 'Didn’t send.'
export const CHAT_UNCONFIRMED = 'The xx network didn’t confirm it arrived.'
export const CHAT_RETRY = 'Try again'
export const CHAT_DISCARD = 'Remove'
/**
 * The name the owner shows the person they're writing to, under the reply box.
 * Not "they see you as": they may have a name of their own for the owner.
 */
export const CHAT_AS = (name: string): Part[] => (name ? ['Name shown to them: “', { name }, '”.'] : ['No name shown to them.'])
export const CHAT_AS_CHANGE = 'Change'
export const CHAT_AS_ADD = 'Add one'
/**
 * After changing it: a name goes with each message, so they see the new one only with the next
 * (otherwise owners would expect it to change at their end at once).
 */
export const CHAT_AS_SAVED = (name: boolean) => (name ? 'Saved. They’ll see it with your next message.' : 'Saved. Your next message won’t show a name.')
export const CHAT_WAIT = 'Waiting for your inbox to open…'
export const CHAT_BUSY = 'Wait for this to finish, then send'
// With INBOX_FILES on: files, or a reply too long for one message, go from the chat
// itself, as an upload that a notice announces a few minutes later.
/** The paperclip beside the reply box, for screen readers. */
export const CHAT_FILES = 'Add files'
export const CHAT_FILES_LIST = 'Files to send'
/** In the owner's own message: the files that went with it, by name and size. */
export const CHAT_FILES_SENT = 'Files you sent'
/** A link, or collecting something, waits while files from the chat upload: one at a time. */
export const CHAT_UPLOAD_BUSY = 'Wait for your files to upload, then try again'
/** A link's collection, tapped before files from the chat started uploading, waits for them. */
export const LINK_WAITS_UPLOAD = 'Waiting for your files to finish uploading…'
export const CHAT_UPLOADING = (pct: number) => `Uploading… ${pct}%`
/** At the end of a reply's state line while its files are on their way. */
export const CHAT_CANCEL = 'Cancel'
/** The owner stopped it: Try again sends it afresh, or only tells them if it had uploaded. */
export const CHAT_STOPPED = 'Stopped.'
export const CHAT_TELLING = 'Letting them know in a few minutes; keep this tab open.'
/** The upload went, but the message telling them didn't: Try again sends only that. */
export const CHAT_TELL_FAILED = 'Uploaded, but they haven’t been told yet.'
/** An older record of the owner's files or longer message, from before their text and names were kept. */
export const CHAT_SENT_DROP = (size: string) => `Files or a longer message, ${size}`
export const CHAT_COPY = 'Copy'
export const CHAT_REMOVE = (kept: boolean) => (kept ? 'Remove conversation from this device' : 'Remove conversation from the list')
export const CHAT_REMOVE_ASK = (kept: boolean) =>
  kept
    ? 'Remove this conversation for good? Their messages won’t come back on this device, though the xx network holds them, sealed, for up to about three weeks.'
    : 'Remove this conversation from the list? Their messages come back next time you open your inbox, while the xx network still holds them.'
export const CHAT_REMOVED = 'Conversation removed'
/** Removing one of the owner's own messages from the conversation. */
export const SENT_REMOVE_ASK = 'Remove your message from this conversation? They still have it.'
export const CHAT_REMOVE_BUSY = 'Wait for your message to send, then remove it'
// Blocking a sender: only one who lets the owner reply can be, since an anonymous
// message has nothing to tell its sender by. Their messages still arrive (nobody can tell who sent one before
// it's opened), so it's said as it is: set aside on this device, and they could write some other way.
export const BLOCK_START = 'Block them…'
export const BLOCK_ASK = (who: string) =>
  `Block ${who}? Their messages will be set aside on this device, unseen: not in your inbox, not counted, no alerts. They won’t be told, and could still write anonymously or from another inbox.`
export const BLOCK_YES = 'Block'
export const BLOCK_NO = 'Cancel'
export const BLOCKED = (who: string) => `${who} is blocked`
export const UNBLOCK = 'Unblock'
export const UNBLOCKED = (who: string) => `${who} is unblocked`
/** At the top of a blocked sender's conversation, opened from Blocked senders. */
export const BLOCKED_CHAT = 'You’ve blocked them. Their messages are set aside, and you can’t reply until you unblock them.'
/** In the inbox's menu, while anyone is blocked: a list of them, each with Show and Unblock. */
export const BLOCKED_MENU = (n: number) => `Blocked senders (${n})…`
export const BLOCKED_HELP = 'Their messages are set aside on this device, unseen. Show opens what they sent.'
export const BLOCKED_COUNT = (n: number) => (n ? `${OWNER_COUNT(n)} set aside` : 'Nothing set aside')
export const BLOCKED_SHOW = 'Show'
/** A message's menu button, for screen readers: whose and when. */
export const CHAT_MESSAGE_MORE = (who: string, time: string) => `More for the message from ${who} at ${time}`
/** A new message, when the owner isn't looking at where it lands. */
export const NEW_FROM = (who: string) => `New message from ${who}`
export const NEW_MESSAGE = 'New message'
/** The tab's title while it's in the background. */
export const TAB_NEW = 'New message'

// --- One message, opened in place, and senders ---------------------------------------------

/** Beside an anonymous message: a short answer in a popup. */
export const WHY_REPLY = 'Why can’t I reply?'
export const WHY_REPLY_WHY = 'This message came without an inbox for a reply to go to. The sender wrote anonymously, so there’s no way to reach them, unless their message says how.'
export const WHY_REPLY_HOW = 'Someone with an inbox of their own can switch on “Let them reply” when they write. Their messages then come as a conversation you can answer.'
/** In the sender's menu: the name it would save, isolated as it's shown. */
export const READ_USE_NAME_AS = (name: string) => `Call them ${String.fromCharCode(0x201c, 0x2068)}${name}${String.fromCharCode(0x2069, 0x201d)}`
export const READ_NAME = 'Give them a name'
export const READ_RENAME = 'Change your name for them'
export const READ_NAME_LABEL = 'Your name for them (only you see it)'
export const READ_NAME_SAVE = 'Save'
/** Naming senders needs the address book, which needs keeping. */
export const READ_NAME_KEEP = 'To give this sender a name of your choosing, or block them, keep your inbox on this device.'
// What the owner should know about a sender's name (mailbox.ts, nameFlags).
export const FLAG_WAS = (now: string, was: string): Part[] => ['Now calls themselves ', { name: now }, ' (was ', { name: was }, ')']
export const FLAG_THEIRS = (name: string): Part[] => [
  'Careful: someone else who writes to you uses the name “',
  { name },
  '” too. This message comes from a different inbox, so it may not be the person you think. Be cautious when dealing with the information.',
]
export const FLAG_YOURS = (name: string): Part[] => ['You call someone else “', { name }, '”. This is a different inbox: it could be someone pretending to be them.']
export const FLAG_COPIED = (name: string): Part[] => ['Another inbox has started using the name “', { name }, '”.']
export const READ_COPY = 'Copy'
export const READ_UNREAD = 'Mark as unread'
export const READ_ARCHIVE = 'Archive'
/** First of the buttons in a message opened in the list: folds it, as a tap on its row does. */
export const READ_CLOSE = 'Close'
export const READ_TO_INBOX = 'Move to Inbox'
/** In the message's More menu, above the folders it can go to. */
export const READ_MOVE_HEADING = 'Move to'
export const MOVED_TO_LABEL = (folder: string) => `Move to ${folder}`
/** Screen readers' names for the menus' buttons. */
export const READ_MORE = 'More for this message'
export const OWNER_MENU = 'More for your inbox'
export const READ_TITLE = 'Give it a title'
export const READ_RETITLE = 'Change its title'
export const READ_TITLE_LABEL = 'A title only you see'
export const READ_TITLE_SAVE = 'Save'
export const READ_REMOVE = (kept: boolean) => (kept ? 'Remove from this device' : 'Remove from the list')
export const REMOVE_ASK = (kept: boolean) =>
  kept
    ? 'Remove this message for good? It won’t come back on this device, though the xx network holds it, sealed, for up to about three weeks.'
    : 'Remove this message from the list? It comes back next time you open your inbox, while the xx network still holds it.'
export const REMOVE_YES = 'Remove it'
// The welcome message (mailbox.ts WELCOME): from the site itself, at the bottom of the inbox until the
// owner removes it, and back each time it's unlocked while the inbox isn't kept on the device.
// What the inbox does and how, in a few short lines; nobody sent it.
export const WELCOME_TITLE = 'Welcome to your inbox'
export const WELCOME_FROM = SITE_NAME
export const WELCOME_BODY = [
  'This is your anonymous inbox. Anyone with its link or QR code can write to you here, without an account, a name or an email address.',
  'Share, at the top, shows your link and QR code whenever you want to put them somewhere new.',
  'Messages wait on the xx network for up to about three weeks, so unlock your inbox at least once a week.',
  // Messages open in place, and several can be selected at once.
  'The list never shows what a message says: tap one to read it, and tap its top again or the Close button at the bottom to close it. When open, you can archive it, give it a title, or move it to a folder of your own. The tick box by the folders selects several at once, to archive, move or remove them.',
  'If someone lets you reply, their messages become a conversation, and you can write back. New message writes to another inbox.',
  'Each message is marked with a padlock (secure) or an atom (quantum-safe), for how it came.',
  'The ⋯ menu can keep your inbox on this device, so unlocking it is quicker, and back up your inbox or remember its passphrase here.',
  'Lock your inbox when you’re done.',
  // A little of the About page's manifesto.
  `${SITE_NAME} is a small digital privacy project: free, with no accounts, ads or tracking, and here to help people protect their privacy and safety.`,
  // Not "from Slynk itself", which sounded as if someone sent it.
  'This message was generated in your browser: it wasn’t sent to your inbox. Remove it whenever you like.',
]
export const WELCOME_REMOVE_ASK = (kept: boolean) =>
  kept
    ? 'Remove this welcome message? It won’t come back on this device.'
    : 'Remove this welcome message for now? It comes back each time you unlock your inbox, as your inbox isn’t kept on this device.'
export const REMOVE_NO = 'Keep it'
export const REMOVED = 'Removed'
export const ARCHIVED = 'Archived'
export const MARKED_UNREAD = 'Marked as unread'
export const MOVED = (folder: string) => `Moved to ${folder}`
// Selecting several at once: "Select" by the folders, a tick box on
// every row, and a bar under the list for what's ticked.
export const SELECT = 'Select'
/** The bar's name for screen readers. */
export const SELECT_BAR = 'Selected messages'
export const SELECTED = (n: number) => (n ? `${n} selected` : 'Tap messages to select them')
export const SELECT_ALL = 'Select all'
export const SELECT_NONE = 'Select none'
export const SELECT_CANCEL = 'Cancel'
export const SELECT_MOVE = 'Move to…'
export const SELECT_READ = 'Mark as read'
export const SELECT_REMOVE = 'Remove'
/** How many of each are ticked: "3 messages", "1 conversation", "2 messages and 1 conversation". */
export const COUNT_TICKED = (messages: number, conversations: number) =>
  [messages && (messages === 1 ? '1 message' : `${messages} messages`), conversations && (conversations === 1 ? '1 conversation' : `${conversations} conversations`)].filter(Boolean).join(' and ')
export const MANY_ARCHIVED = (what: string) => `${what} archived`
export const MANY_MOVED = (what: string, folder: string) => `${what} moved to ${folder}`
export const MANY_MARKED = (what: string, read: boolean) => `${what} marked as ${read ? 'read' : 'unread'}`
export const MANY_REMOVED = (what: string) => `${what} removed`
/**
 * Removing several at once, asked once for the lot, as honest as asking for each: kept on this
 * device, they're gone from it for good, though the network still holds what was sent to the
 * inbox; not kept, what was sent to it comes back, and so does the welcome. (One alone is asked
 * about as it would be on its own.)
 */
export const REMOVE_MANY_ASK = (what: string, o: { kept: boolean; received: boolean; own: boolean; welcome: boolean }) =>
  (o.kept
    ? `Remove ${what} for good? They won’t come back on this device${o.received ? ', though the xx network holds messages sent to you, sealed, for up to about three weeks' : ''}.`
    : `Remove ${what} from the list?${o.received ? ' Messages sent to you come back next time you open your inbox, while the xx network still holds them.' : ''}${o.welcome ? ' The welcome message comes back each time you unlock your inbox.' : ''}`) +
  (o.own ? ' The people you wrote to still have your messages.' : '')
export const REMOVE_MANY_YES = 'Remove them'
export const REMOVE_MANY_NO = 'Keep them'
// Files and longer messages, sent as an upload the notice announces. With
// INBOX_FILES (site.ts) on, the owner collects them; with it off, as on
// slynk.me, the row says so instead.
export const DROP_LABEL = 'Files or a longer message'
export const DROP_COLLECT = 'Collect'
/** The button's name for screen readers: what it says, then what it's for. */
export const DROP_COLLECT_LABEL = (action: string, size: string) => `${action}: files or a longer message, ${size}`
export const DROP_COLLECTING = 'Collecting it from the mixnet…'
export const DROP_EXPIRED = 'Too old to collect: the xx network keeps things for up to about three weeks.'
export const DROP_ONE_AT_A_TIME = 'Wait for what’s being collected to finish, then try again'
export const DROP_WAIT_LINK = 'Wait for your inbox to finish collecting, then try again'
/** A link tapped just before an owner's Collect waits its turn. */
export const DROP_LINK_WAITS = 'Waiting for your inbox to finish collecting…'
export const DROP_FAILED = (reason: string) => `Couldn’t collect it: ${reason}`
export const DROP_DAMAGED = `It arrived, but couldn’t be opened: it may be damaged, or from a newer version of ${SITE_NAME}.`
export const DROP_STALLED = (done: number, total: number) =>
  done
    ? `${done} of ${total} pieces have arrived. The rest are taking longer than usual, so it may be incomplete.`
    : 'Nothing has arrived yet. This is taking longer than usual.'
export const DROP_STOPPED = (done: number) =>
  done ? 'Stopped. Some pieces never arrived, so it may be incomplete. You can try again.' : 'Stopped. Nothing arrived. You can try again.'
export const DROP_KEEP_WAITING = 'Keep waiting'
export const DROP_STOP = 'Stop'
export const DROP_TRY_AGAIN = 'Try again'
export const DROP_FORGET = 'Forget'
export const DROP_FORGOTTEN = 'Forgotten. You can collect it again while it’s on the xx network.'
/** An upload's entry, kept on the device: files never are. */
export const DROP_COLLECTED_ON = (date: string) => `Collected on ${date}.`
export const DROP_GONE = (date: string) => `Collected on ${date}. The xx network no longer holds it, so it can’t be collected again.`
export const DROP_NOT_KEPT = 'Files aren’t kept on this device, so save what you need.'
export const DROP_CARE = 'Anyone can write to an inbox, so open files with care, as you would an attachment from a stranger.'
export const DROP_OFF = `Someone sent files or a longer message, which ${SITE_ADDRESS}’s inboxes don’t collect.`
/** In the owner's card: slynk.me isn't where messages are kept. */
export const OWNER_HELD = `Messages never go to ${SITE_ADDRESS}. They wait on the xx network, and on this device if you keep them here.`
export const OWNER_HONEST_IP =
  'While your inbox is open, the mixnet gateways this tab connects through can see you using them. A VPN can add an extra layer of privacy.'

// --- Sending to an inbox --------------------------------------------------------------------

export const TO_LABEL = 'To an anonymous inbox'
export const TO_LABEL_QS = 'To a quantum-safe anonymous inbox'
export const TO_CHECK = 'Make sure this link came from their own website, poster or leaflet.'
/** After TO_CHECK: opens the address check (inbox/check.ts) in a popup. */
export const TO_CHECK_IT = 'Check it.'
/** In place of TO_CHECK when replying: the address came with their message, proved. */
export const TO_REPLYING = 'This is the inbox their message came from.'
/** "The inbox's owner", not "they": at the start of the paragraph, "they" had nothing to refer to. */
export const TO_THEIRS =
  'Only the inbox’s owner can read your message. What happens to it after that is up to them: they may keep it, share it within their organisation or act on it, so include only what you’re comfortable with them having.'
// Replies: only with the writer's own inbox open in this tab.
export const INCLUDE_LABEL = 'Let them reply'
export const INCLUDE_HELP = 'They’ll be able to write back to your inbox, and they’ll know your messages come from the same inbox.'
export const INCLUDE_NAME_LABEL = 'Name to show them (optional)'
export const INCLUDE_NAME_PLACEHOLDER = 'e.g. Sam'
export const INCLUDE_WAIT = 'Waiting for your inbox to open…'
/**
 * Without an inbox open: how to get replies, set out like the switches above it:
 * the question in bold, a button on the right, and "Already got one? Open yours" under it.
 */
export const REPLY_HINT_LEAD = 'Want a reply?'
export const REPLY_HINT_GET = 'Create an inbox'
export const REPLY_HINT_HAVE = 'Already got one?'
export const REPLY_HINT_OPEN = 'Open yours'
/** The button, when this device keeps an inbox: no second one is offered. */
export const REPLY_HINT_OPEN_KEPT = 'Unlock your inbox'
export const TO_SHOW_ADDRESS = 'Show its full address'
// Checking the address written to: from "Check it.", a popup where the
// sender pastes or scans the inbox's address from where its owner published it, and the page
// says whether the two match (inbox/check.ts).
export const ADDR_CHECK_TITLE = 'Check its address'
export const ADDR_CHECK_LEAD = 'Paste its address from their own website, poster or leaflet, or scan its QR code, to compare it with the one you’re writing to.'
/** The box's name for screen readers. */
export const ADDR_CHECK_FIELD = 'The address to compare'
export const ADDR_CHECK_GO = 'Check'
export const ADDR_CHECK_SAME = 'It matches: this is the inbox you’re writing to.'
/** The same inbox by its other address (qs: the address given is the quantum-safe one). */
export const ADDR_CHECK_SAME_INBOX = (qs: boolean) =>
  qs
    ? 'It’s the same inbox: that’s its quantum-safe address, and you’re writing to its secure one.'
    : 'It’s the same inbox: that’s its secure address, and you’re writing to its quantum-safe one.'
export const ADDR_CHECK_OTHER = 'It doesn’t match: that’s a different inbox. Make sure your link came from them before you write.'
export const ADDR_CHECK_BAD = 'That address doesn’t work: it looks damaged or incomplete.'
export const ADDR_CHECK_COPY = 'Copy'
export const ADDR_CHECK_COPIED = 'Copied'
/** For an owner who keeps their inbox: opens the form that names this inbox in their address book. */
export const TO_SAVE_OPEN = 'Save to my address book'
export const TO_PLACEHOLDER = 'Write your message…'
/**
 * The limit as the design: one message, one piece, or two for a quantum-safe
 * inbox, which go a few seconds apart, each in a round of its own (always,
 * with no switch). Compressed, an English letter of about 350 words fits one
 * piece and about 230 two (inbox/pack.ts); said with room to spare. qs: it
 * goes as two pieces, so it takes longer (an anonymous message, or one before
 * any reply).
 */
export const TO_SIZE = (filesOn: boolean, qs = false) =>
  qs
    ? `${filesOn ? 'Up to about 200 words fit in one message.' : 'Room for about 200 words.'} To a quantum-safe inbox, an anonymous or first message takes a bit longer.`
    : filesOn
      ? 'A message of up to about 300 words travels as a single piece, the hardest kind to trace.'
      : 'Room for about 300 words. A message this size travels as a single piece, the hardest kind to trace.'
/**
 * With files to inboxes off (INBOX_FILES, site.ts), as on slynk.me: said on
 * the sender's card, the first creation screen and the note on an upload
 * this site doesn't collect, with a link to the About answer "Can people
 * send files to an inbox?".
 */
export const MESSAGES_ONLY = `${SITE_ADDRESS}’s inboxes take messages, not files.`
export const MESSAGES_ONLY_WHY = 'Why messages only?'
export const MESSAGES_ONLY_HREF = '/about/#inbox-files'
/** name: the owner's name for it in their address book, if any. */
export const TO_SEND = (name?: string) => (name ? `Send to ${name}` : 'Send to this inbox')
export const TO_WRITE = 'Write a message'
export const TO_TOO_LONG = 'Too long to send'
export const TO_FILES = 'Only a message can go to an inbox: remove the files'
export const TO_ROOM = (left: number) => `Room for about ${left} more ${left === 1 ? 'character' : 'characters'}`
export const TO_OVER = (over: number) => `${over} ${over === 1 ? 'character' : 'characters'} too long for one message`
/**
 * Under the card, so it never reads as a way to send the inbox's owner a link.
 * With files to inboxes off, as on slynk.me, it's a file people come looking for.
 */
export const TO_ELSEWHERE = (filesOn: boolean) => (filesOn ? 'Sending something to someone else?' : 'Sending a file?')
export const TO_MAKE_LINK = 'Make a link instead'
export const TO_HONEST_IP =
  'The mixnet gateways can see you using them, but never what you write. A VPN can add an extra layer of privacy.'
/** After TO_HONEST_IP, for a message that goes as two pieces to a quantum-safe address. */
export const TO_HONEST_QS = 'Not many people send quantum-safe messages yet, so the way yours is sent could stand out.'
export const TO_HONEST_TIMING =
  `If someone you’re writing about controls your device or network, like an employer, they could see when you used ${SITE_NAME}. Use a device and connection they don’t control.`
/** Only with INBOX_FILES on, once something needs an upload. */
export const TO_UPLOAD_HONEST =
  'Files and longer messages go as many pieces. Someone running part of the xx network could sometimes match them to this inbox and to your internet address, though never see what’s inside. A VPN keeps your address from them; a short message on its own is the most discreet way to write.'
export const TO_BAD_ADDRESS_TITLE = 'This inbox address doesn’t work'
export const TO_BAD_ADDRESS = 'It looks damaged or incomplete. Ask whoever shared it for the link again.'

// Owners write to another inbox from their own: New message, beside the folders.
/** Opens a step to pick the inbox: a conversation already under way opens; otherwise the usual composer, addressed. */
export const COMPOSE = 'New message'
export const SEND_TO_LABEL = (book: boolean) =>
  book ? 'Paste an inbox’s address, scan a QR code, or type a name from your address book' : 'Paste the inbox’s address or scan a QR code'
export const SEND_TO_GO = 'Write to it'
export const SEND_TO_BAD = (book: boolean) => (book ? 'That isn’t an inbox address, or a name in your address book.' : 'That isn’t an inbox address.')
// Scanning an inbox's QR code instead: the camera button in that box, and its sheet.
/** The camera button's label, and the sheet's title. */
export const SCAN_LABEL = 'Scan a QR code'
export const SCAN_STARTING = 'Starting the camera…'
export const SCAN_POINT = 'Point your camera at the inbox’s QR code.'
/** After a while with no code read: a quantum-safe inbox's code is more detailed. */
export const SCAN_HARD = 'Hold the code steady and come closer, or use a photo instead.'
/**
 * The same on an iPhone or iPad, whose main camera can't focus close up in a web page (seen
 * on an iPhone, 2026-10-19: a quantum-safe code read only from well back): further away, not closer.
 */
export const SCAN_HARD_IOS = 'Hold the code steady and move back a little until it’s sharp, or use a photo instead.'
export const SCAN_NOT_INBOX = 'That QR code isn’t an inbox’s address.'
/** An inbox's code was read: shown for a moment, with a tick, before writing to it. */
export const SCAN_FOUND = 'Inbox found.'
export const SCAN_REFUSED = 'The camera isn’t allowed. Use a photo instead, or allow the camera in your browser’s settings.'
export const SCAN_NO_CAMERA = 'No camera was found. Use a photo instead.'
export const SCAN_CAMERA_FAILED = 'Couldn’t start the camera. Use a photo instead.'
/** Some privacy settings stop the page reading pictures, and with them any scanning. */
export const SCAN_BROKEN = 'This browser won’t let the page read pictures, so it can’t scan. Paste the address instead.'
/** The reader didn't start (a tab left open across an update, say). */
export const SCAN_FAILED = 'Scanning didn’t work this time. Paste the address instead.'
export const SCAN_PHOTO = 'Use a photo instead'
export const SCAN_PHOTO_PICK = 'Choose a photo or screenshot of the inbox’s QR code.'
export const SCAN_PHOTO_READING = 'Reading the photo…'
export const SCAN_PHOTO_NONE = 'No QR code found in that photo. Try one with the whole code in it, close up.'
export const SCAN_PHOTO_FAILED = 'Couldn’t open that photo.'
/** Over the composer's limit for photos (shrink/plan.ts MAX_PIXELS): too big for a phone to open. */
export const SCAN_PHOTO_BIG = 'That photo is too large to read. Try a screenshot of the code instead.'
export const SCAN_CANCEL = 'Cancel'
// The address book, kept on the device with the owner's inbox (only when it's kept).
export const BOOK_TITLE = 'Your address book'
export const BOOK_WRITE = (name: string) => `Write to ${name}`
export const BOOK_REMOVE = (name: string) => `Remove ${name} from your address book`
export const BOOK_REMOVED = (name: string) => `Removed ${name} from your address book`
export const BOOK_SAVE_LABEL = 'Save it in your address book as'
export const BOOK_SAVE_PLACEHOLDER = 'e.g. Advice line'
export const BOOK_SAVE = 'Save'
export const BOOK_SAVED = (name: string) => `Saved as ${name}`
export const BOOK_TAKEN = 'That name is already in your address book.'
export const BOOK_FULL = 'Your address book is full.'

// --- Sending progress and the result -----------------------------------------------------------

export const SENDING_SEPARATE = 'Getting a separate identity for this message…'
/** A join that stalled, starting again by itself with a fresh identity: a send's, or a link's collect. */
export const JOIN_SLOW = 'Joining the mixnet is slow, so trying again with a fresh identity…'
export const UPLOAD_JOIN_SLOW = 'Uploaded. Joining the mixnet is slow, so trying again with a fresh identity…'
export const SENDING_JOINING = (pct: number) => `Joining the mixnet for this message… ${pct}%`
export const SENDING_NOW = 'Sending it…'
/**
 * To a quantum-safe address, two pieces a few seconds apart (always):
 * it takes longer, so the screen says what's happening.
 */
export const SENDING_APART = 'Sending it in two parts…'
export const SENDING_APART_FIRST = 'First part delivered. The second follows shortly…'
export const SENDING_UNCONFIRMED =
  'The xx network didn’t confirm it arrived. It may or may not have, so sending it again could deliver it twice.'
// An upload to an inbox: the pieces first, then the notice that tells the
// owner, from a separate identity, a random 1 to 3 minutes later.
export const UPLOAD_JOINING = (pct: number) => `Uploaded. Getting ready to let them know… ${pct}%`
export const UPLOAD_WAITING = 'Uploaded. Letting them know in the next few minutes, at a random moment. Keep this tab open until then.'
export const UPLOAD_NOTICE_FAILED = (reason: string) =>
  `It’s uploaded, but the message telling them about it didn’t go (${reason}). Try again: nothing is uploaded twice.`
export const UPLOAD_UNDELIVERED =
  'It’s uploaded, but the xx network didn’t deliver the message telling them about it. Try again: nothing is uploaded twice.'
export const UPLOAD_PENDING_NAV = 'They haven’t been told about what you sent yet. Try again first, or start over.'
export const UPLOAD_UNCONFIRMED =
  'It’s uploaded, but the xx network didn’t confirm they were told about it. Try again to be sure: they’ll only see it once.'
// Stopping files on their way, from the composer and from the chat: the question
// follows a link's ("Stop sending?" in bold, then why), and must fit two lines on a phone.
export const STOP_ASK = 'Stop sending?'
export const STOP_WHY = 'They won’t get it, and nobody can open what’s gone so far.'
export const STOP_YES = 'Stop sending'
export const STOP_NO = 'Keep sending'
/** The message telling them had already started to go: it can't be called back. */
export const STOP_TOO_LATE = 'Too late to stop: it’s already on its way.'
export const DELIVERED_TITLE = (name?: string) => (name ? `Sent to ${name}` : 'Sent to the inbox')
/** Not "to the xx network": that read as if the network were the recipient. */
export const DELIVERED_WHEN = (time: string) => `Delivered through the mixnet at ${time}.`
export const DELIVERED_NOTE =
  'It waits for the inbox’s owner, for up to about three weeks. You won’t hear whether it’s been read, and there’s nothing for you to keep. Close this tab when you’re done.'
/** Sent without their inbox, from a tab where it's open: it's noted there too. */
export const DELIVERED_NOTE_MINE = 'It waits for the inbox’s owner, for up to about three weeks. You won’t hear whether it’s been read. You’ll find it in your inbox too.'
/** Sent with the writer's own inbox included. */
export const DELIVERED_NOTE_REPLY = 'It waits for the inbox’s owner, for up to about three weeks. If they reply, it arrives in your inbox.'
export const DELIVERED_AGAIN = 'Write another'

// --- "How is this different from a messaging app?" (a dialog, opened from a link) ---------
// Never name an app. Rows compare most messaging apps with a Slynk inbox, for
// whoever opened it: the owner (creating an inbox) or a sender.

export const COMPARE_TITLE = 'How is this different from a messaging app?'
export const COMPARE_THEM = 'Most messaging apps'
export const COMPARE_US = `A ${SITE_NAME} inbox`
export const COMPARE_CLOSE = 'Close'
export const COMPARE_MORE = 'More on the About page'
export const COMPARE_OWNER: [string, string, string][] = [
  ['Being reachable', 'Your phone number or account name', 'A link or QR code, with no personal number'],
  ['People who write', 'Need an account, and you see who they are', 'Need nothing, and stay anonymous unless they say'],
  ['In the middle', 'A company can see who contacts you, and when', 'No company in the middle: the mixnet is designed to make it hard to tell who wrote to whom'],
  ['Replies', 'You can reply', 'You can reply, if they have an inbox and let you'],
  ['How long', 'Until deleted', 'Up to about three weeks on the xx network, or kept on your device'],
]
export const COMPARE_SENDER: [string, string, string][] = [
  ['What you need', 'A phone number or an account', 'Nothing'],
  ['What they see', 'Your number or name, often your photo', 'Only what you write'],
  ['In the middle', 'A company can see who you contact, and when', 'No company in the middle: the mixnet is designed to make it hard to tell who wrote to whom'],
  ['Your message', 'Encrypted end to end in the best ones', 'Encrypted end to end: sealed in your browser, opened only in the owner’s'],
  ['Replies', 'They can reply', 'They can reply, if you have an inbox and let them'],
  ['On your device', 'Your chats, until you delete them', `Nothing kept by ${SITE_NAME}, but your browser’s history keeps the inbox’s link unless you use a private window`],
]
/** The same, for a message that goes quantum-safe (to a quantum-safe address, or sealed with reply keys). */
export const COMPARE_SENDER_QS: [string, string, string][] = COMPARE_SENDER.map(([what, them, us]) =>
  what === 'Your message' ? [what, them, 'Encrypted end to end with quantum-safe cryptography: sealed in your browser, opened only in the owner’s'] : [what, them, us],
)

// --- A web link in a message (ui/linkWarn.ts) -----------------------------------------------
// A tap on a link someone put in a message (in an inbox, or in a message that came by link)
// first says where it goes, and every one opens in a new tab. A new tab is a fresh page: a
// Slynk link opened from an inbox gets a new identity on the network of its own, never the
// one that checks the inbox. What sites and senders can tell is on the About page.

export const LINK_SLYNK_TITLE = `Open this ${SITE_NAME} link?`
export const LINK_OTHER_TITLE = 'Open this link?'
/** A Slynk link or an inbox's address, from an inbox's message. */
export const LINK_SLYNK_INBOX = 'It opens in a new tab, with a new identity on the network, separate from your inbox.'
/** The same, from a message that came by link. */
export const LINK_SLYNK_TAB = 'It opens in a new tab, with a new identity on the network, separate from this one.'
/**
 * Under it, from an inbox: opened from the inbox's own internet address,
 * the sender's upload could be tied to the inbox, and so to them. Framed as looking after whoever sent
 * it, not as what it holds. The network, not the device: another device on the same Wi-Fi shares it.
 */
export const LINK_CAREFUL = 'To better protect whoever sent it, copy it and open it on another network, or with a VPN, so it can’t easily be tied to your inbox.'
/** One of Slynk's own pages, with no link in it (the About page, say). */
export const LINK_PAGE = 'It opens in a new tab.'
export const LINK_OTHER = `It goes to another website, not ${SITE_NAME}, in a new tab. Whoever runs that site will see your internet address, so only open it if you trust who sent it.`
/**
 * Slynk's own links that leave slynk.me (the About page's write-ups, the xx network's site): the same popup
 * first, so it's plain that a tap leaves Slynk. The page sends no referrer, so the
 * site isn't told where the visitor came from; that's left unsaid to keep it short.
 */
export const LINK_LEAVE_TITLE = `Leave ${SITE_NAME}?`
export const LINK_LEAVE = 'It opens another website in a new tab. Like any website, it will see your internet address, and who you are if you’re signed in to it.'
/** A link that opened in the inbox's own tab anyway (a browser that keeps to one tab), or was pasted there: a toast. */
export const LINK_NOT_HERE = 'Your inbox is open in this tab. Open the link in a new tab, or lock your inbox first.'
export const LINK_GO = 'Open in a new tab'
/** The icon inside the address box's right edge: its label and tooltip, then what it says once done. */
export const LINK_COPY = 'Copy the link'
export const LINK_COPIED = 'Copied'
export const LINK_CANCEL = 'Cancel'
