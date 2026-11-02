// An open inbox as its owner manages it: messages read or
// unread, filed in folders, given titles of the owner's own, or removed, plus
// the owner's label for the inbox and their address book of inboxes they
// write to. Plain state with no screen or storage in it, so it can be tested:
// owner.ts draws it, and kept.ts keeps it on the device when the owner asks.
// Without keeping, it lasts until Lock, like everything else in the tab.
//
// Replies: a sender may include their own inbox. Senders are told apart by
// that inbox, never by a name: each gets a number in the order this inbox
// first heard from them ("Sender 1"), and the names they give are remembered
// with when each was first used, so the owner can be warned when one changes,
// or when two inboxes use names that look the same.
//
// Conversations: everything from one sender's inbox, and every message the
// owner sent it with theirs included, is one conversation: one row in the
// list, read as a chat. A conversation moves between folders as a whole, and
// a new message from them brings it back to Inbox. The owner's own messages
// are kept with the rest when the inbox is kept on the device: for files or a
// longer message, its text and the files' names and sizes, never the files
// themselves.
//
// The owner's messages without their inbox: one they send to another inbox
// with "Let them reply" off belongs to no conversation, so it's an item of
// its own (mine), in Inbox like any message, so they can check later what
// went where. Kept with the rest the same way.
//
// Two addresses: every inbox has a compact address and a quantum-safe one,
// and anyone may write to either. Inboxes are told apart by their compact
// address (inboxKey), whichever was used. Messages that came to the
// quantum-safe address are marked (qs). The owner sees one list with every
// message in it (rather than a tab for each address), each with a marker for
// how it came or went: a padlock, or an atom for quantum-safe. A
// conversation's row is marked as its other side's newest message; with
// nothing from them yet, as the owner's newest went (threadQs).
//
// Reply keys: a quantum-safe message including its sender's inbox
// gives the owner that inbox's reply keys for them, and the owner's replies
// sealed with them are quantum-safe too, in one message, to the sender's
// compact address. So such a reply is marked qs like any quantum-safe
// message, and the owner's own quantum-safe messages carry this inbox's
// keys: a conversation that began quantum-safe stays so, both sides. The
// keys each sender gave are held here, by their inbox, and kept with the
// rest when the inbox is kept; removing a conversation drops them, and
// that's remembered as a removal is, so another record of the inbox can't
// bring them back.
import { fromBase64url, toBase64url } from '../linkv2.ts'
import { MAX_FILES } from '../payload.ts'
import { INBOX_ADDRESS_LENGTH, INBOX_ADDRESS_VERSION, REPLY_KEYS_LENGTH, compactAddress, isInboxAddress, isQuantumSafe } from './address.ts'
import { NOTICE_FILE, NOTICE_TEXT, readFileNotice, uploadKey } from './drop.ts'
import { cleanGivenName, looksSame, nameKeys } from './names.ts'

export const INBOX = 'inbox'
export const ARCHIVE = 'archive'
/**
 * The welcome message's ID (a notice's is 32 hex digits, so never this): the site's own message about
 * the inbox, at the bottom of it until the owner removes it. Nobody sent it,
 * and it's never sent anywhere; its words are the page's own (inboxCopy.ts WELCOME_BODY), never kept.
 */
export const WELCOME = 'welcome'

/** The most messages held at once. A flood past it is counted, not shown or kept. */
export const MAX_HELD = 5000
/** The most folders an owner can make, and the longest name or title. */
export const MAX_FOLDERS = 50
export const MAX_NAME = 40
export const MAX_TITLE = 80
export const MAX_BOOK = 500
/**
 * The most senders remembered, and names remembered for each (the oldest go
 * first). Enough for every message held and every name in the address book,
 * so only senders whose messages have all been removed are ever forgotten.
 */
export const MAX_SENDERS = 10_000
export const MAX_SENDER_NAMES = 20
/** The most messages the owner sent that are held for conversations; past it, the oldest go. */
export const MAX_SENT = 5000
/**
 * Of what a blocked sender sends after being blocked, the newest kept out of
 * sight, in case they're unblocked; older ones go, so a blocked sender can't
 * fill the inbox.
 */
export const MAX_SET_ASIDE = 100

/**
 * How long a removed message is remembered, so the look-back doesn't bring
 * it back: the network keeps messages for about 500 hours, so a little
 * longer. After that nothing could bring it back anyway.
 */
export const REMEMBER_REMOVED_MS = 600 * 3600_000

/**
 * A kept inbox looks back only to a day before its last finished look-back:
 * what came before is already kept. The day is a safety margin,
 * and xxDK looks back at least about a day anyway.
 */
export const LOOKBACK_MARGIN_MS = 24 * 3600_000

export interface Folder {
  id: string
  name: string
}

/** Files or a longer message, announced by a notice (INBOX_FILES, site.ts). */
export interface Upload {
  key: string // its pickup address (uploadKey): tells a notice sent twice
  v1?: Uint8Array // its link, and with it its key; dropped once the network has let it go
  size: number
  sent: number
  expires: number
  collected?: number // when it was first collected
}

/** Who a message is from, when its sender included their own inbox so the owner can reply. */
export interface FromInbox {
  address: Uint8Array // the sender's inbox, proved by the core
  key: string // the same, in hex (inboxKey): what tells senders apart
  name: string // the name they gave with this message, cleaned ('' for none)
}

/** Someone who writes from their own inbox: told apart by it, never by a name. */
export interface Sender {
  key: string // the inbox's compact address, in hex (inboxKey)
  address: Uint8Array
  n: number // "Sender 1", "Sender 2"… in the order this inbox first heard from them
  names: { name: string; first: number; last: number }[] // names they've given: when each was first and last used
}

/** A sender the owner blocked (on), or unblocked since: kept so another copy of the inbox follows whichever came last. */
interface Block {
  address: Uint8Array // their compact address
  at: number
  on: boolean
}

/**
 * What the owner should know about who a message is from: the name it
 * carried isn't the one this sender used before (was), it looks like a name
 * the owner gave someone else (yours), or like one another inbox used first
 * (theirs), or another inbox has since started using this sender's name
 * (copied: that name).
 */
export interface NameFlags {
  was?: string
  yours?: string
  theirs?: string
  copied?: string
}

export interface MailItem {
  id: string // the notice's, the same whenever a look-back finds it again
  kind: number
  body: Uint8Array // a message's text, or what a newer version sent; empty for an upload
  sent: number // when it was sent: its round's time (in a record kept by an older version, the sender's sealed minute)
  at: number // when its round ran (0 if unknown)
  qs?: boolean // it came quantum-safe: to the quantum-safe address, or as a reply sealed with reply keys; the owner's own (mine), to a quantum-safe address
  folder: string
  read: boolean
  title: string
  upload?: Upload // only where this site collects uploads
  off?: string // an upload this site doesn't collect: its pickup address, its link already gone
  from?: FromInbox // the sender's own inbox, if they included it
  mine?: Mine // the owner's own message, sent without their inbox included
}

/**
 * A message the owner sent to another inbox with "Let them reply" off: who it
 * went to and when it reached the network. For files or a longer message, its
 * text and the files' names and sizes, never the files.
 */
export interface Mine {
  address: Uint8Array // the inbox it went to
  upload?: number // sent as an upload: its size
  files?: FileNote[]
}

export interface Contact {
  address: Uint8Array // either of its addresses: the one the owner saved, the quantum-safe one if they ever used it
  name: string
}

/** A file the owner sent, as their own message keeps it: its name and size, never the file. */
export interface FileNote {
  name: string
  size: number
}

/** The longest file name a kept record may hold (the envelope fits names to 255 bytes, so this is plenty). */
const MAX_FILE_NAME = 255

/** A message the owner sent to another inbox with theirs included: their side of a conversation. */
export interface SentItem {
  id: string // made here, never sent anywhere
  to: string // the inbox it went to (inboxKey)
  address: Uint8Array // the address it went to, of either kind
  body: Uint8Array // its text, also for files or a longer message (empty in a record kept by an older version)
  at: number // when Send was pressed: where it stays in the conversation, however long it waits to go
  round?: number // when its round ran, once it reached the network
  name: string // the name shown to them with it ('' for none)
  folder: string // its conversation's folder
  state: 'sending' | 'sent' | 'failed'
  qs?: boolean // it went quantum-safe, with this inbox's reply keys in it, so their replies will too; see sentQs
  upload?: number // files or a longer message, sent as an upload: its size
  files?: FileNote[] // the files that went with it, by name and size
}

/**
 * Whether one of the owner's messages went quantum-safe (its atom):
 * sealed with the reply keys they gave, or to their quantum-safe address,
 * which always seals so. A message kept from before reply keys has no flag, but
 * one that went to a quantum-safe address went that way too.
 */
export const sentQs = (x: SentItem): boolean => !!x.qs || isQuantumSafe(x.address)

/** A row in the list: a message on its own (from an anonymous sender), or a conversation with one inbox, marked as threadQs says (qs). */
export type ListRow =
  | { kind: 'message'; item: MailItem; at: number }
  | { kind: 'thread'; key: string; address: Uint8Array; at: number; unread: number; count: number; failed: number; latest?: MailItem; qs: boolean }

/** One message in a conversation: from them (in) or from the owner (out). */
export type ThreadEntry = { kind: 'in'; item: MailItem; at: number } | { kind: 'out'; sent: SentItem; at: number }

/** A message as the core finds it (core/protocol.ts FoundNotice). */
export interface Found {
  id: string
  kind: number
  body: Uint8Array
  at: number
  quantumSafe: boolean
  from?: Uint8Array
  fromName?: string
  replyKeys?: Uint8Array
}

export type Added = 'added' | 'known' | 'removed' | 'full'

/** When a message went: its round's time, or when it was sent if that's unknown (a record kept by an older version may hold the sender's sealed minute). Newest first. */
export const when = (i: { sent: number; at: number }) => (i.at > 0 ? i.at : Math.max(i.sent, 0))

/** Oldest first, then by ID, so the order is always the same. */
const older = (a: MailItem, b: MailItem) => when(a) - when(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** One of the owner's messages comes after another in a conversation: by when it was written, then by ID, as Mailbox.thread orders them. */
const later = (a: SentItem, b: SentItem) => a.at > b.at || (a.at === b.at && a.id > b.id)

/** A conversation's mark: as their newest message came, or, with nothing from them, as the owner's newest went. */
const marked = (heard: MailItem | undefined, x: SentItem | undefined) => (heard ? !!heard.qs : !!x && sentQs(x))

/** Where a message goes in a list sorted by `older`. */
function place(list: MailItem[], i: MailItem): number {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (older(list[mid], i) < 0) lo = mid + 1
    else hi = mid
  }
  return lo
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k)
  if (list) list.push(v)
  else m.set(k, [v])
}

/**
 * A name, label or title the owner typed, made safe to show and keep: no
 * control, format or direction characters (they could scramble the screen),
 * spaces collapsed, and at most max characters.
 */
export function cleanName(text: string, max = MAX_NAME): string {
  const plain = text
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return [...plain].slice(0, max).join('').trim()
}

/** Names compare without case or extra spaces. */
const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

const fromHex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Whether these bytes are an inbox's compact address: what a sender includes so they can be answered. */
const isCompact = (b: unknown): b is Uint8Array => b instanceof Uint8Array && b.length === INBOX_ADDRESS_LENGTH && b[0] === INBOX_ADDRESS_VERSION

/** What tells inboxes apart, whichever of an inbox's addresses someone used: its compact address, in hex. */
export const inboxKey = (address: Uint8Array): string => hex(compactAddress(address))

/** Files' names and sizes from a kept record, anything malformed skipped. */
function fileNotes(v: unknown): FileNote[] {
  return (Array.isArray(v) ? (v as unknown[]) : [])
    .slice(0, MAX_FILES)
    .filter((f): f is FileNote => !!f && typeof f === 'object' && typeof (f as FileNote).name === 'string' && Number.isSafeInteger((f as FileNote).size) && (f as FileNote).size >= 0)
    .map((f) => ({ name: f.name.slice(0, MAX_FILE_NAME), size: f.size }))
}

const copyMine = (m: Mine): Mine => ({ ...m, address: m.address.slice(), ...(m.files ? { files: m.files.map((f) => ({ ...f })) } : {}) })

export class Mailbox {
  label = ''
  /**
   * The address the owner shared last is the quantum-safe one:
   * Share opens on it. First, the one chosen as the inbox was made.
   */
  sharesQs = false
  /**
   * Everything the network handed over up to this time (ms since 1970) is
   * here: set when a look-back finishes with nothing left missing. 0: unknown,
   * so the next look-back goes back as far as the network keeps messages.
   */
  covered = 0
  /**
   * Days a look-back cut short went through (ms since 1970): everything
   * delivered from `from` to `to` is here too, so the next look-back skips
   * them. Past days are looked through newest first, so it's one stretch,
   * ending at the time it was noted.
   */
  done: { from: number; to: number } | undefined
  private items = new Map<string, MailItem>()
  private uploads = new Set<string>() // pickup addresses announced, so a notice sent twice shows once
  private removed = new Map<string, number>() // id (or "u:" + pickup address) → when it was sent
  private folderList: Folder[] = []
  private contacts: Contact[] = []
  private senderMap = new Map<string, Sender>() // by the sender's inbox, in hex
  private nextSender = 1
  private shown = new Map<string, string>() // the name the owner last showed each inbox they wrote to, by its address in hex
  private sentMap = new Map<string, SentItem>() // messages the owner sent with their inbox included, by ID
  private sentTo = new Map<string, SentItem[]>() // the same, by the inbox they went to (hex)
  private replyKeyMap = new Map<string, { keys: Uint8Array; at: number }>() // reply keys each sender gave, by their inbox (hex), and when
  private blockMap = new Map<string, Block>() // senders the owner blocked, or unblocked since, by their inbox (hex)
  /** Messages past MAX_HELD, counted but not shown. */
  overflow = 0
  /** The owner removed the welcome message: kept on this device, it stays gone; otherwise it's back next time. */
  welcomeGone = false

  /**
   * Adds a message the core found, unless it's already here or was removed.
   * Whatever isn't added is wiped, so the caller needn't.
   */
  add(n: Found, filesOn: boolean): Added {
    const keys = n.replyKeys
    if (keys) n.replyKeys = undefined
    try {
      return this.adding(n, keys, filesOn)
    } finally {
      keys?.fill(0) // held, if at all, as their own copy
    }
  }

  private adding(n: Found, replyKeys: Uint8Array | undefined, filesOn: boolean): Added {
    if (this.items.has(n.id) || this.removed.has(n.id)) {
      n.body.fill(0) // what's held is its own copy
      return this.items.has(n.id) ? 'known' : 'removed'
    }
    // Its own copy: the same notice handed over twice must never wipe what's held (the duplicate
    // check above wipes what it's given).
    const body = n.body.slice()
    n.body.fill(0)
    // Sent when its round ran: a copy sent again in another round never gets here. A
    // round of unknown time: when it arrived, so it still sorts.
    const item: MailItem = { id: n.id, kind: n.kind, body, sent: n.at > 0 ? n.at : Date.now(), at: n.at, folder: INBOX, read: false, title: '', ...(n.quantumSafe ? { qs: true } : {}) }
    if (n.kind === NOTICE_FILE) {
      const file = readFileNotice(body)
      const key = uploadKey(body)
      if (file && key) {
        body.fill(0) // the upload keeps its own copy of the link
        item.body = new Uint8Array(0)
        // An upload announced twice (a notice sent again) shows once, whatever INBOX_FILES says.
        if (this.uploads.has(key) || this.removed.has(`u:${key}`)) {
          file.v1.fill(0)
          return 'known'
        }
        if (filesOn) item.upload = { key, v1: file.v1, size: file.size, sent: file.sent.getTime(), expires: file.expires.getTime() }
        else {
          // This site doesn't collect uploads, so the link (its key) goes now.
          file.v1.fill(0)
          item.off = key
        }
      }
    }
    const blocked = isCompact(n.from) && this.isBlockedKey(inboxKey(n.from))
    if (this.items.size >= MAX_HELD) {
      this.wipe(item)
      // A blocked sender's isn't counted anywhere, not even as one that didn't fit.
      if (blocked) return 'removed'
      this.overflow++
      return 'full'
    }
    if (isCompact(n.from)) item.from = { address: n.from.slice(), key: inboxKey(n.from), name: cleanGivenName(n.fromName ?? '') }
    const key = item.upload?.key ?? item.off
    if (key) this.uploads.add(key)
    this.items.set(item.id, item)
    if (item.from) {
      this.indexItem(item)
      // When a name was first used is the round's time, which the network's clock gives, not the sender's.
      this.noteSender(item.from, item.at > 0 ? item.at : Date.now())
      // Something new from them brings the whole conversation back to Inbox, unless they're blocked.
      if (!blocked) this.bringBack(item.from.key)
      // The core passes on reply keys only from a quantum-safe message whose sender proved out;
      // the page holds to that too.
      if (replyKeys && n.quantumSafe) this.noteReplyKeys(item.from.key, replyKeys, when(item))
      // One older than all they've sent since may go at once (rounds don't arrive in order).
      if (blocked) {
        this.trimSetAside(item.from.key)
        if (!this.items.has(item.id)) return 'removed'
      }
    }
    return 'added'
  }

  // --- Blocked senders --------------------------------------------------------------------
  // Only a sender who included their inbox can be blocked: an anonymous message has nothing to tell
  // its sender by. Their messages still arrive (nobody on the network can tell who sent one), and
  // are set aside here: out of the list, the counts and the alerts, kept in case they're unblocked.

  private isBlockedKey(key: string): boolean {
    return this.blockMap.get(key)?.on === true
  }

  /** Whether the owner blocked this inbox. */
  isBlocked(address: Uint8Array): boolean {
    return this.isBlockedKey(inboxKey(address))
  }

  /** Whether a message is set aside: its sender is blocked. */
  setAside(i: MailItem): boolean {
    return !!i.from && this.isBlockedKey(i.from.key)
  }

  /** Blocks a sender, or unblocks them. False if nothing changed. */
  block(address: Uint8Array, on: boolean, at = Date.now()): boolean {
    const key = inboxKey(address)
    if (this.isBlockedKey(key) === on) return false
    this.blockMap.set(key, { address: compactAddress(address).slice(), at, on })
    // The oldest go first; an unblocking is only worth remembering while another copy may still block them.
    while (this.blockMap.size > MAX_SENDERS) {
      const [oldest] = [...this.blockMap].reduce((a, b) => (b[1].on < a[1].on || (b[1].on === a[1].on && b[1].at < a[1].at) ? b : a))
      this.blockMap.delete(oldest)
    }
    return true
  }

  /** The blocked senders, latest first, with how many of their messages are set aside. */
  blocked(): { address: Uint8Array; at: number; count: number }[] {
    const count = new Map<string, number>()
    for (const i of this.items.values()) if (i.from && this.isBlockedKey(i.from.key)) count.set(i.from.key, (count.get(i.from.key) ?? 0) + 1)
    return [...this.blockMap]
      .filter(([, b]) => b.on)
      .map(([key, b]) => ({ address: b.address, at: b.at, count: count.get(key) ?? 0 }))
      .sort((a, b) => b.at - a.at)
  }

  /**
   * Of what a blocked sender sent since they were blocked, only the newest MAX_SET_ASIDE stay. The rest
   * go without being remembered as removed, which would grow with a flood: one that comes again (a
   * fuller look-back) only goes again.
   */
  private trimSetAside(key: string) {
    const since = this.blockMap.get(key)?.at ?? 0
    const theirs = [...this.items.values()].filter((i) => i.from?.key === key && when(i) > since).sort((a, b) => when(b) - when(a))
    for (const i of theirs.slice(MAX_SET_ASIDE)) {
      this.items.delete(i.id)
      if (this.index) {
        const list = this.index.bySender.get(key)
        list?.splice(list.indexOf(i), 1)
      }
      const upload = i.upload?.key ?? i.off
      if (upload) this.uploads.delete(upload)
      this.wipe(i)
    }
  }

  /** Whether there's more to back up than the words and label: messages, replies, folders, names or blocks. */
  holdsMore(): boolean {
    return this.size > 0 || this.sentMap.size > 0 || this.contacts.length > 0 || this.folderList.length > 0 || this.senderMap.size > 0 || this.blocked().length > 0
  }

  /**
   * Holds the reply keys a sender gave in a message sent at `at`.
   * An inbox gives another the same keys every time, so ones that differ can
   * only be forged (by someone who could break X25519 as it happened) or a
   * fault: the earliest message's keys are the ones kept. None from a
   * conversation the owner removed, unless the message came after.
   */
  private noteReplyKeys(key: string, keys: Uint8Array, at: number) {
    if (!(keys instanceof Uint8Array) || keys.length !== REPLY_KEYS_LENGTH) return
    const removed = this.removed.get(`k:${key}`)
    if (removed !== undefined) {
      if (at <= removed) return
      this.removed.delete(`k:${key}`)
    }
    const held = this.replyKeyMap.get(key)
    if (held && keys.every((b, i) => b === held.keys[i])) {
      held.at = Math.min(held.at, at)
      return
    }
    if (held && held.at <= at) return
    held?.keys.fill(0)
    this.replyKeyMap.set(key, { keys: keys.slice(), at })
    while (this.replyKeyMap.size > MAX_SENDERS) {
      const [oldest] = [...this.replyKeyMap].reduce((a, b) => (b[1].at < a[1].at ? b : a))
      this.replyKeyMap.get(oldest)!.keys.fill(0)
      this.replyKeyMap.delete(oldest)
    }
  }

  /**
   * The reply keys this inbox gave the owner, if any: with them, a
   * reply to it is quantum-safe, in one message. A copy, for the caller to
   * wipe once it has gone: what's held may be wiped while a send waits.
   */
  replyKeysFor(address: Uint8Array): Uint8Array | undefined {
    return this.replyKeyMap.get(inboxKey(address))?.keys.slice()
  }

  /** Whether this inbox gave the owner reply keys. */
  hasReplyKeys(address: Uint8Array): boolean {
    return this.replyKeyMap.has(inboxKey(address))
  }

  get(id: string): MailItem | undefined {
    return this.items.get(id)
  }

  get size(): number {
    return this.items.size - (this.items.has(WELCOME) ? 1 : 0)
  }

  /** How many messages arrived: all but the owner's own (mine), the welcome, which nobody sent, and those set aside. */
  get received(): number {
    let n = 0
    for (const i of this.items.values()) if (!i.mine && i.id !== WELCOME && !this.setAside(i)) n++
    return n
  }

  /**
   * The welcome message, at the bottom of the inbox (it has no time) and unread, unless the owner
   * removed it. True if it was added.
   */
  addWelcome(): boolean {
    if (this.welcomeGone || this.items.has(WELCOME)) return false
    this.items.set(WELCOME, { id: WELCOME, kind: NOTICE_TEXT, body: new Uint8Array(0), sent: 0, at: 0, folder: INBOX, read: false, title: '' })
    return true
  }

  /**
   * How a conversation with this inbox is marked, on its row and
   * at the top of the chat: as its other side's newest message came; with
   * nothing from them yet, as the owner's newest message went (one on its
   * way, or that failed, only while nothing has gone).
   */
  threadQs(address: Uint8Array): boolean {
    let heard: MailItem | undefined
    let said: SentItem | undefined
    let saying: SentItem | undefined
    // Oldest first, as the rows reckon it: the last of each is the newest.
    for (const e of this.thread(address)) {
      if (e.kind === 'in') heard = e.item
      else {
        saying = e.sent
        if (e.sent.state === 'sent') said = e.sent
      }
    }
    return marked(heard, said ?? saying)
  }

  all(): MailItem[] {
    return [...this.items.values()].sort((a, b) => when(b) - when(a))
  }

  /** A folder's messages, newest first. */
  inFolder(folder: string): MailItem[] {
    return this.all().filter((i) => i.folder === folder)
  }

  /** How many messages are unread, in every folder: never the welcome, which isn't news, nor those set aside. */
  unread(): number {
    let n = 0
    for (const i of this.items.values()) if (!i.read && i.id !== WELCOME && !this.setAside(i)) n++
    return n
  }

  /** How many messages, and how many unread, each folder holds (those set aside aren't in any). */
  counts(): Map<string, { total: number; unread: number }> {
    const counts = new Map(this.folders().map((f) => [f.id, { total: 0, unread: 0 }]))
    for (const i of this.items.values()) {
      if (this.setAside(i)) continue
      const c = counts.get(i.folder) ?? counts.get(INBOX)!
      c.total++
      if (!i.read) c.unread++
    }
    return counts
  }

  setRead(id: string, read: boolean): boolean {
    const i = this.items.get(id)
    if (!i || i.read === read) return false
    i.read = read
    return true
  }

  move(id: string, folder: string): boolean {
    const i = this.items.get(id)
    if (!i || i.folder === folder || !this.folder(folder)) return false
    i.folder = folder
    return true
  }

  setTitle(id: string, title: string): boolean {
    const i = this.items.get(id)
    const t = cleanName(title, MAX_TITLE)
    if (!i || i.title === t) return false
    i.title = t
    return true
  }

  /** Gone for good: wiped, and remembered so the look-back doesn't bring it back. */
  remove(id: string): boolean {
    if (id === WELCOME) {
      if (!this.items.delete(WELCOME)) return false
      this.welcomeGone = true
      return true
    }
    const i = this.items.get(id)
    if (!i) return false
    this.items.delete(id)
    if (i.from && this.index) {
      const list = this.index.bySender.get(i.from.key)
      list?.splice(list.indexOf(i), 1)
    }
    // Remembered from when it was sent; from now, if that's unknown.
    const at = when(i) || Date.now()
    this.removed.set(id, at)
    const key = i.upload?.key ?? i.off
    if (key) this.removed.set(`u:${key}`, at)
    this.wipe(i)
    return true
  }

  /** The upload's link goes once the network has let it go: it can't be collected any more. */
  dropExpiredLinks(now = Date.now()): boolean {
    let changed = false
    for (const i of this.items.values()) {
      if (i.upload?.v1 && now >= i.upload.expires) {
        i.upload.v1.fill(0)
        delete i.upload.v1
        changed = true
      }
    }
    return changed
  }

  /**
   * Notes a message the owner sent without their inbox included, once it
   * reached the network in a round at `round` (0: unknown, so now): read, in
   * Inbox, marked as it went: quantum-safe if it went to a
   * quantum-safe address, as without their inbox it can't go as a reply.
   * Undefined if the inbox is full.
   */
  addMine(address: Uint8Array, body: Uint8Array, round: number, upload?: number, files?: FileNote[], at = Date.now()): MailItem | undefined {
    if (this.items.size >= MAX_HELD) return undefined
    let id: string
    do id = hex(crypto.getRandomValues(new Uint8Array(16)))
    while (this.items.has(id) || this.removed.has(id))
    const mine: Mine = { address: address.slice() }
    if (upload !== undefined) mine.upload = upload
    if (upload !== undefined && files?.length) mine.files = files.slice(0, MAX_FILES).map((f) => ({ name: f.name.slice(0, MAX_FILE_NAME), size: f.size }))
    const item: MailItem = { id, kind: NOTICE_TEXT, body: body.slice(), sent: at, at: round > 0 ? round : Date.now(), folder: INBOX, read: true, title: '', mine, ...(isQuantumSafe(address) ? { qs: true } : {}) }
    this.items.set(id, item)
    return item
  }

  markCollected(id: string, at = Date.now()): boolean {
    const u = this.items.get(id)?.upload
    if (!u || u.collected) return false
    u.collected = at
    return true
  }

  // --- Folders --------------------------------------------------------------------

  folders(): Folder[] {
    return [{ id: INBOX, name: '' }, { id: ARCHIVE, name: '' }, ...this.folderList]
  }

  folder(id: string): Folder | undefined {
    return this.folders().find((f) => f.id === id)
  }

  /** Only the owner's own folders: Inbox and Archive are always there. */
  ownFolders(): Folder[] {
    return [...this.folderList]
  }

  addFolder(name: string, builtIn: string[] = []): Folder | 'empty' | 'taken' | 'full' {
    const n = cleanName(name)
    if (!n) return 'empty'
    if (this.taken(n, builtIn)) return 'taken'
    if (this.folderList.length >= MAX_FOLDERS) return 'full'
    let id: string
    do id = `f${hex(crypto.getRandomValues(new Uint8Array(6)))}`
    while (this.folder(id))
    const f = { id, name: n }
    this.folderList.push(f)
    return f
  }

  renameFolder(id: string, name: string, builtIn: string[] = []): 'ok' | 'empty' | 'taken' | 'missing' {
    const f = this.folderList.find((f) => f.id === id)
    if (!f) return 'missing'
    const n = cleanName(name)
    if (!n) return 'empty'
    if (!same(n, f.name) && this.taken(n, builtIn)) return 'taken'
    f.name = n
    return 'ok'
  }

  /** Its messages go back to Inbox. */
  deleteFolder(id: string): boolean {
    const at = this.folderList.findIndex((f) => f.id === id)
    if (at < 0) return false
    this.folderList.splice(at, 1)
    for (const i of this.items.values()) if (i.folder === id) i.folder = INBOX
    for (const x of this.sentMap.values()) if (x.folder === id) x.folder = INBOX
    return true
  }

  private taken(name: string, builtIn: string[]): boolean {
    return builtIn.some((b) => same(b, name)) || this.folderList.some((f) => same(f.name, name))
  }

  // --- The address book: inboxes the owner writes to, under names they give --------

  book(): Contact[] {
    return [...this.contacts].sort((a, b) => a.name.localeCompare(b.name))
  }

  contactFor(address: Uint8Array): Contact | undefined {
    this.byKey ??= new Map(this.contacts.map((c) => [inboxKey(c.address), c]))
    return this.byKey.get(inboxKey(address))
  }
  private byKey?: Map<string, Contact>

  contactNamed(name: string): Contact | undefined {
    const n = cleanName(name)
    return n ? this.contacts.find((c) => same(c.name, n)) : undefined
  }

  /** Saves an inbox under a name, or renames it if it's already in the book. */
  saveContact(address: Uint8Array, name: string): Contact | 'empty' | 'taken' | 'full' {
    this.own = undefined
    this.clashes.clear()
    const n = cleanName(name)
    if (!n) return 'empty'
    const existing = this.contactFor(address)
    const other = this.contactNamed(n)
    if (other && other !== existing) return 'taken'
    if (existing) {
      existing.name = n
      // Saved by the quantum-safe address, it's written to that way from now on.
      if (isQuantumSafe(address)) existing.address = address.slice()
      return existing
    }
    if (this.contacts.length >= MAX_BOOK) return 'full'
    const c = { address: address.slice(), name: n }
    this.contacts.push(c)
    this.byKey = undefined
    return c
  }

  removeContact(address: Uint8Array): boolean {
    this.own = undefined
    this.clashes.clear()
    const c = this.contactFor(address)
    if (!c) return false
    this.contacts.splice(this.contacts.indexOf(c), 1)
    this.byKey = undefined
    return true
  }

  /**
   * Adds what another mailbox for the same inbox holds that this one
   * doesn't: its messages (unless removed here), its removals (which
   * remove them here too), its folders, address book and label (if this one
   * has none). Where both hold a message, this one's state wins.
   */
  merge(other: Mailbox) {
    this.reindex()
    if (other.welcomeGone) this.remove(WELCOME)
    for (const [id, at] of other.removed) {
      if (!this.removed.has(id) || this.removed.get(id)! < at) this.removed.set(id, at)
      if (this.items.has(id)) this.remove(id)
      if (id.startsWith('s:')) this.removeSent(id.slice(2))
      // A conversation removed there: its reply keys go here too, unless a later message gave them.
      const held = id.startsWith('k:') ? this.replyKeyMap.get(id.slice(2)) : undefined
      if (held && held.at <= at) {
        held.keys.fill(0)
        this.replyKeyMap.delete(id.slice(2))
      }
    }
    for (const f of other.folderList) {
      if (!this.folder(f.id) && this.folderList.length < MAX_FOLDERS) this.folderList.push({ ...f })
    }
    for (const c of other.contacts) if (!this.contactFor(c.address)) this.saveContact(c.address, c.name)
    // Their senders keep their names; numbers this one doesn't know yet follow on from its own.
    for (const o of [...other.senderMap.values()].sort((a, b) => a.n - b.n)) {
      for (const x of o.names) {
        this.noteSender({ address: o.address, name: x.name }, x.first)
        this.noteSender({ address: o.address, name: x.name }, x.last)
      }
      if (!o.names.length) this.noteSender({ address: o.address, name: '' }, 0)
    }
    for (const [k, v] of other.shown) if (!this.shown.has(k)) this.shown.set(k, v)
    for (const [k, v] of other.replyKeyMap) this.noteReplyKeys(k, v.keys, v.at)
    // Blocked or unblocked: whichever was done last.
    for (const [k, b] of other.blockMap) {
      const held = this.blockMap.get(k)
      if (!held || held.at < b.at) this.blockMap.set(k, { ...b, address: b.address.slice() })
    }
    if (!this.label) this.label = other.label
    // Together they hold everything either did.
    this.covered = Math.max(this.covered, other.covered)
    if (other.done) this.noteDone(other.done.from, other.done.to)
    for (const x of other.sentMap.values()) {
      // Removed here (or there) stays removed.
      if (this.sentMap.has(x.id) || x.state !== 'sent' || this.removed.has(`s:${x.id}`)) continue
      this.putSent({
        ...x,
        address: x.address.slice(),
        body: x.body.slice(),
        folder: this.folder(x.folder) ? x.folder : INBOX,
        ...(x.files ? { files: x.files.map((f) => ({ ...f })) } : {}),
      })
    }
    this.pruneSent()
    for (const i of other.items.values()) {
      if (this.items.has(i.id) || this.removed.has(i.id) || this.items.size >= MAX_HELD || (i.id === WELCOME && this.welcomeGone)) continue
      const key = i.upload?.key ?? i.off
      if (key && (this.uploads.has(key) || this.removed.has(`u:${key}`))) continue
      if (key) this.uploads.add(key)
      this.items.set(i.id, {
        ...i,
        body: i.body.slice(),
        folder: this.folder(i.folder) ? i.folder : INBOX,
        ...(i.upload ? { upload: { ...i.upload, ...(i.upload.v1 ? { v1: i.upload.v1.slice() } : {}) } } : {}),
        ...(i.from ? { from: { ...i.from, address: i.from.address.slice() } } : {}),
        ...(i.mine ? { mine: copyMine(i.mine) } : {}),
      })
    }
    this.reindex()
    // What either copy set aside, together, may be more than a blocked sender keeps.
    for (const [k, b] of this.blockMap) if (b.on) this.trimSetAside(k)
    this.gatherThreads()
  }

  // --- Conversations ----------------------------------------------------------------------

  /**
   * A folder's rows, newest first: anonymous messages and the owner's own
   * one-way ones one by one, and a row for each conversation whose newest
   * message is in the folder.
   */
  rows(folder: string): ListRow[] {
    const rows: ListRow[] = []
    for (const t of this.threads().values()) {
      if (t.folder === folder && !this.isBlockedKey(t.row.key)) rows.push({ ...t.row, address: this.bestAddress(t.row.address) })
    }
    for (const i of this.items.values()) {
      if (!i.from && i.folder === folder) rows.push({ kind: 'message', item: i, at: when(i) })
    }
    const id = (r: ListRow) => (r.kind === 'message' ? r.item.id : r.key)
    return rows.sort((a, b) => b.at - a.at || (id(a) < id(b) ? 1 : -1))
  }

  /** Every conversation, by inboxKey: its row (marked as threadQs says), and its folder (its newest message's). */
  private threads() {
    const threads = new Map<string, { row: Extract<ListRow, { kind: 'thread' }>; folder: string; said?: SentItem; saying?: SentItem }>()
    const thread = (key: string, address: Uint8Array) => {
      let t = threads.get(key)
      if (!t) threads.set(key, (t = { row: { kind: 'thread', key, address, at: -1, unread: 0, count: 0, failed: 0, qs: false }, folder: INBOX }))
      return t
    }
    for (const i of this.items.values()) {
      if (!i.from) continue
      const t = thread(i.from.key, i.from.address)
      t.row.count++
      if (!i.read) t.row.unread++
      if (!t.row.latest || older(t.row.latest, i) < 0) t.row.latest = i
      if (when(i) >= t.row.at) {
        t.row.at = when(i)
        t.folder = i.folder
      }
    }
    for (const x of this.sentMap.values()) {
      const t = thread(x.to, x.address)
      t.row.count++
      if (x.state === 'failed') t.row.failed++
      if (x.at > t.row.at) {
        t.row.at = x.at
        t.folder = x.folder
      }
      if (x.state === 'sent' && (!t.said || later(x, t.said))) t.said = x
      if (!t.saying || later(x, t.saying)) t.saying = x
    }
    for (const t of threads.values()) t.row.qs = marked(t.row.latest, t.said ?? t.saying)
    return threads
  }

  /**
   * The address to write to an inbox at: its quantum-safe one when the owner
   * has used or saved that, otherwise the one given. (What a sender includes
   * for replies is always their compact address.)
   */
  bestAddress(address: Uint8Array): Uint8Array {
    if (isQuantumSafe(address)) return address
    const c = this.contactFor(address)
    if (c && isQuantumSafe(c.address)) return c.address
    for (const x of this.sentTo.get(inboxKey(address)) ?? []) if (isQuantumSafe(x.address)) return x.address
    return address
  }

  /** Everything to and from one inbox, oldest first. */
  thread(address: Uint8Array): ThreadEntry[] {
    const key = inboxKey(address)
    const entries: ThreadEntry[] = (this.indexed().bySender.get(key) ?? []).map((item) => ({ kind: 'in', item, at: when(item) }))
    for (const x of this.sentTo.get(key) ?? []) entries.push({ kind: 'out', sent: x, at: x.at })
    const id = (e: ThreadEntry) => (e.kind === 'in' ? e.item.id : e.sent.id)
    return entries.sort((a, b) => a.at - b.at || (id(a) < id(b) ? -1 : 1))
  }

  /** The folder a conversation is in: its newest message's. */
  threadFolder(address: Uint8Array): string {
    const t = this.thread(address)
    const last = t[t.length - 1]
    return !last ? INBOX : last.kind === 'in' ? last.item.folder : last.sent.folder
  }

  /** Moves a whole conversation. False if nothing changed. */
  moveThread(address: Uint8Array, folder: string): boolean {
    if (!this.folder(folder)) return false
    let changed = false
    for (const e of this.thread(address)) {
      const x = e.kind === 'in' ? e.item : e.sent
      if (x.folder !== folder) {
        x.folder = folder
        changed = true
      }
    }
    return changed
  }

  /** A conversation back in Inbox: cheap, as it runs for every message that arrives. */
  private bringBack(key: string) {
    for (const i of this.indexed().bySender.get(key) ?? []) if (i.folder !== INBOX) i.folder = INBOX
    for (const x of this.sentTo.get(key) ?? []) if (x.folder !== INBOX) x.folder = INBOX
  }

  /** Marks everything from them read (opening the conversation), or the newest unread again. */
  readThread(address: Uint8Array, read = true): boolean {
    const ins = this.thread(address).filter((e): e is Extract<ThreadEntry, { kind: 'in' }> => e.kind === 'in')
    if (!read) {
      const last = ins[ins.length - 1]?.item
      return !!last && this.setRead(last.id, false)
    }
    let changed = false
    for (const { item } of ins) if (this.setRead(item.id, true)) changed = true
    return changed
  }

  /** Removes a whole conversation: their messages for good (remembered, as remove), the owner's own, and the reply keys they gave. */
  removeThread(address: Uint8Array): boolean {
    const t = this.thread(address)
    for (const e of t) {
      if (e.kind === 'in') this.remove(e.item.id)
      else this.removeSent(e.sent.id)
    }
    const key = inboxKey(address)
    this.replyKeyMap.get(key)?.keys.fill(0)
    const had = this.replyKeyMap.delete(key)
    // Remembered, as a removal is, so another record of this inbox doesn't bring the keys back.
    if (t.length > 0 || had) this.removed.set(`k:${key}`, Date.now())
    return t.length > 0 || had
  }

  /** Notes a message the owner is sending to another inbox with theirs included. files: with an upload, what went in it. */
  addSent(address: Uint8Array, body: Uint8Array, name: string, upload?: number, at = Date.now(), files?: FileNote[]): SentItem {
    const to = inboxKey(address)
    let id: string
    do id = hex(crypto.getRandomValues(new Uint8Array(16)))
    while (this.sentMap.has(id))
    const x: SentItem = { id, to, address: address.slice(), body: body.slice(), at, name: cleanGivenName(name), folder: this.threadFolder(address), state: 'sending' }
    if (upload !== undefined) x.upload = upload
    if (upload !== undefined && files?.length) x.files = files.slice(0, MAX_FILES).map((f) => ({ name: f.name.slice(0, MAX_FILE_NAME), size: f.size }))
    this.putSent(x)
    this.pruneSent()
    return x
  }

  private putSent(x: SentItem) {
    this.sentMap.set(x.id, x)
    push(this.sentTo, x.to, x)
  }

  getSent(id: string): SentItem | undefined {
    return this.sentMap.get(id)
  }

  /**
   * It reached the network, in a round at `round` (0: unknown, so now), and
   * went quantum-safe (qs: to their quantum-safe address, or with the reply
   * keys they gave), carrying this inbox's reply keys, or not. It stays where
   * it was written: one that took longer to go mustn't jump below messages
   * written after it.
   */
  sentDone(id: string, round: number, qs = false): boolean {
    const x = this.sentMap.get(id)
    if (!x || x.state === 'sent') return false
    x.state = 'sent'
    x.round = round > 0 ? round : Date.now()
    if (qs) x.qs = true
    else delete x.qs
    return true
  }

  sentFailed(id: string): boolean {
    const x = this.sentMap.get(id)
    if (!x || x.state !== 'sending') return false
    x.state = 'failed'
    return true
  }

  /** Trying again: sending once more. */
  sentRetry(id: string): boolean {
    const x = this.sentMap.get(id)
    if (!x || x.state !== 'failed') return false
    x.state = 'sending'
    return true
  }

  /** Gone for good: wiped, and remembered so another tab's record doesn't bring it back. */
  removeSent(id: string, remember = true): boolean {
    const x = this.sentMap.get(id)
    if (!x) return false
    x.body.fill(0)
    this.sentMap.delete(id)
    const list = this.sentTo.get(x.to)
    list?.splice(list.indexOf(x), 1)
    if (list && !list.length) this.sentTo.delete(x.to)
    if (remember && x.state === 'sent') this.removed.set(`s:${id}`, x.at || Date.now())
    return true
  }

  /** Past MAX_SENT, the oldest that reached the network go. */
  private pruneSent() {
    if (this.sentMap.size <= MAX_SENT) return
    const done = [...this.sentMap.values()].filter((x) => x.state === 'sent').sort((a, b) => a.at - b.at)
    for (const x of done) {
      if (this.sentMap.size <= MAX_SENT) break
      this.removeSent(x.id, false)
    }
  }

  /** Each conversation in one folder: its newest message's (a record kept before conversations may have them spread). */
  private gatherThreads() {
    // Each conversation's newest message, in one pass over everything.
    const newest = new Map<string, { at: number; folder: string }>()
    const note = (key: string, at: number, folder: string) => {
      const n = newest.get(key)
      if (!n || at >= n.at) newest.set(key, { at, folder })
    }
    for (const i of [...this.items.values()].sort(older)) if (i.from) note(i.from.key, when(i), i.folder)
    for (const x of this.sentMap.values()) note(x.to, x.at, x.folder)
    for (const i of this.items.values()) if (i.from) i.folder = newest.get(i.from.key)!.folder
    for (const x of this.sentMap.values()) x.folder = newest.get(x.to)!.folder
  }

  // --- Senders who included their own inbox -----------------------------------------------

  /** Notes a message from a sender's inbox, sent at `at`: a number if they're new, and the name they gave. */
  private noteSender(from: { address: Uint8Array; name: string }, at: number) {
    const key = inboxKey(from.address)
    let s = this.senderMap.get(key)
    if (!s) {
      s = { key, address: from.address.slice(), n: this.nextSender++, names: [] }
      this.senderMap.set(key, s)
      this.pruneSenders(key)
    }
    if (!from.name) return
    const known = s.names.find((x) => x.name === from.name)
    if (known) {
      if (at < known.first) {
        known.first = at
        this.clashes.clear()
      }
      known.last = Math.max(known.last, at)
      return
    }
    const x = { name: from.name, first: at, last: at }
    s.names.push(x)
    this.clashes.clear()
    if (this.index) for (const k of nameKeys(x.name)) push(this.index.byFold, k, { s, x })
    if (s.names.length > MAX_SENDER_NAMES) {
      s.names.sort((a, b) => a.last - b.last)
      s.names.splice(0, s.names.length - MAX_SENDER_NAMES)
      this.index = undefined
    }
  }

  /**
   * Past MAX_SENDERS, senders with no message held and no name in the
   * address book are forgotten, oldest first, those who never gave a name
   * before those who did (their names still matter for the warnings). Never
   * keep: the sender just noted.
   */
  private pruneSenders(keep: string) {
    if (this.senderMap.size <= MAX_SENDERS) return
    const held = new Set<string>()
    for (const i of this.items.values()) if (i.from) held.add(i.from.key)
    const gone = [...this.senderMap.values()]
      .filter((s) => s.key !== keep && !held.has(s.key) && !this.contactFor(s.address))
      .sort((a, b) => Number(a.names.length > 0) - Number(b.names.length > 0) || a.n - b.n)
    for (const s of gone) {
      if (this.senderMap.size <= MAX_SENDERS) break
      this.senderMap.delete(s.key)
    }
    this.index = undefined
    this.clashes.clear()
  }

  sender(address: Uint8Array): Sender | undefined {
    return this.senderMap.get(inboxKey(address))
  }

  /** The newest name a sender has given, or '' if they never gave one. */
  givenName(address: Uint8Array): string {
    const names = this.sender(address)?.names ?? []
    return names.reduce((a, b) => (b.last > a.last ? b : a), { name: '', first: 0, last: -1 }).name
  }

  /**
   * What the owner should know about who a message is from (NameFlags): the
   * name it carried against the one this sender used before, and both that
   * name and the sender's newest (the one the list shows) against the owner's
   * address book and what other inboxes have used. Across visits when the
   * inbox is kept.
   */
  nameFlags(i: MailItem): NameFlags {
    const flags: NameFlags = {}
    if (!i.from) return flags
    if (i.from.name) {
      // The latest earlier message from them that gave a name.
      const list = this.indexed().bySender.get(i.from.key) ?? []
      for (let j = place(list, i) - 1; j >= 0; j--) {
        const was = list[j].from!.name
        if (!was) continue
        if (!looksSame(was, i.from.name)) flags.was = was
        break
      }
    }
    for (const name of new Set([i.from.name, this.givenName(i.from.address)])) {
      if (!name) continue
      const c = this.nameClash(i.from.address, name)
      if (c.yours !== undefined) flags.yours ??= c.yours
      if (c.theirs !== undefined) flags.theirs ??= c.theirs
      if (c.copied !== undefined) flags.copied ??= c.copied
    }
    return flags
  }

  /**
   * How a name looks next to everyone else's, for this sender: like one the
   * owner gave someone else (yours), like one another inbox used first
   * (theirs), or taken up by another inbox since this sender first used it
   * (copied).
   */
  nameClash(address: Uint8Array, name: string): Pick<NameFlags, 'yours' | 'theirs' | 'copied'> {
    const key = inboxKey(address)
    const cached = this.clashes.get(`${key} ${name}`)
    if (cached) return cached
    const ix = this.indexed()
    const keys = nameKeys(name)
    const like = <T>(m: Map<string, T[]>) => [...new Set(keys.flatMap((k) => m.get(k) ?? []))]
    const c: Pick<NameFlags, 'yours' | 'theirs' | 'copied'> = {}
    const yours = like(this.ownByFold()).find((x) => x.key !== key)
    if (yours) c.yours = yours.c.name
    // Who used a name that looks like this one first: this sender, or another?
    const uses = like(ix.byFold)
    const me = this.senderMap.get(key)
    const mine = Math.min(Infinity, ...uses.filter((u) => u.s === me).map((u) => u.x.first))
    for (const u of uses) {
      if (u.s === me) continue
      if (u.x.first < mine || (u.x.first === mine && u.s.n < (me?.n ?? Infinity))) c.theirs ??= u.x.name
      else c.copied = name
    }
    this.clashes.set(`${key} ${name}`, c)
    return c
  }

  // What nameFlags looks things up in: made when first needed, then kept up
  // to date as messages and names arrive, so a flood stays quick.
  private index?: {
    bySender: Map<string, MailItem[]> // oldest first
    byFold: Map<string, { s: Sender; x: Sender['names'][number] }[]> // every name given, by how it looks
  }
  private own?: Map<string, { c: Contact; key: string }[]> // the address book's names, by how they look
  private clashes = new Map<string, Pick<NameFlags, 'yours' | 'theirs' | 'copied'>>()

  private indexed() {
    if (this.index) return this.index
    const bySender = new Map<string, MailItem[]>()
    for (const i of this.items.values()) if (i.from) push(bySender, i.from.key, i)
    for (const list of bySender.values()) list.sort(older)
    const byFold = new Map<string, { s: Sender; x: Sender['names'][number] }[]>()
    for (const s of this.senderMap.values()) for (const x of s.names) for (const k of nameKeys(x.name)) push(byFold, k, { s, x })
    this.index = { bySender, byFold }
    return this.index
  }

  private indexItem(i: MailItem) {
    const list = this.index?.bySender.get(i.from!.key)
    if (!this.index) return
    if (!list) this.index.bySender.set(i.from!.key, [i])
    else list.splice(place(list, i), 0, i)
  }

  private ownByFold() {
    if (this.own) return this.own
    this.own = new Map()
    for (const c of this.contacts) for (const k of nameKeys(c.name)) push(this.own, k, { c, key: inboxKey(c.address) })
    return this.own
  }

  /** Something the warnings depend on changed wholesale: work them out afresh. */
  private reindex() {
    this.index = undefined
    this.own = this.byKey = undefined
    this.clashes.clear()
  }

  /** The name the owner last showed an inbox when writing to it with theirs included, or ''. */
  shownTo(address: Uint8Array): string {
    return this.shown.get(inboxKey(address)) ?? ''
  }

  /** Remembers the name shown to an inbox, so the next message to it can show the same. False if nothing changed. */
  setShownTo(address: Uint8Array, name: string): boolean {
    const key = inboxKey(address)
    const n = cleanGivenName(name)
    if ((this.shown.get(key) ?? '') === n) return false
    if (n) this.shown.set(key, n)
    else this.shown.delete(key)
    while (this.shown.size > MAX_BOOK) this.shown.delete(this.shown.keys().next().value!)
    return true
  }

  // --- Wiping --------------------------------------------------------------------

  private wipe(i: MailItem) {
    i.body.fill(0)
    i.upload?.v1?.fill(0)
  }

  /** Overwrites every message and link held: Lock, or the end of the page. */
  wipeAll() {
    this.reindex()
    for (const i of this.items.values()) this.wipe(i)
    this.items.clear()
    this.uploads.clear()
    this.removed.clear()
    this.contacts = []
    this.folderList = []
    this.senderMap.clear()
    this.nextSender = 1
    this.shown.clear()
    this.blockMap.clear()
    for (const x of this.sentMap.values()) x.body.fill(0)
    this.sentMap.clear()
    this.sentTo.clear()
    for (const r of this.replyKeyMap.values()) r.keys.fill(0)
    this.replyKeyMap.clear()
    this.label = ''
    this.covered = 0
    this.done = undefined
    this.overflow = 0
    this.welcomeGone = false
  }

  /** Where the next look-back can start from, or undefined for as far as the network keeps. */
  lookbackFrom(): number | undefined {
    return this.covered > 0 ? this.covered - LOOKBACK_MARGIN_MS : undefined
  }

  /**
   * The next look-back: from where (lookbackFrom), and the days it can skip
   * because a look-back cut short went through them (all but the last day
   * of that stretch, which is checked again to be safe).
   */
  lookbackPlan(): { since?: number; skipFrom?: number; skipTo?: number } {
    const plan: { since?: number; skipFrom?: number; skipTo?: number } = {}
    const since = this.lookbackFrom()
    if (since !== undefined) plan.since = since
    if (this.done && this.done.to - LOOKBACK_MARGIN_MS > this.done.from) {
      plan.skipFrom = this.done.from
      plan.skipTo = this.done.to - LOOKBACK_MARGIN_MS
    }
    return plan
  }

  /** A whole look-back finished with nothing missing: everything up to now is here. */
  coveredUpTo(now: number) {
    this.covered = Math.max(this.covered, now)
    this.done = undefined
  }

  /**
   * A look-back still running has collected everything delivered from `from`
   * to `to`. Joined to what's known already where they meet; a separate
   * stretch replaces the one noted only if it's longer (both are true, but
   * one is kept). False if nothing changed.
   */
  noteDone(from: number, to: number): boolean {
    if (!(from > 0) || !(to > from)) return false
    if (this.covered > 0 && from <= this.covered) {
      if (to <= this.covered) return false
      this.covered = to
      this.done = undefined
      return true
    }
    const d = this.done
    if (!d) this.done = { from, to }
    else if (from <= d.to && to >= d.from) {
      const joined = { from: Math.min(from, d.from), to: Math.max(to, d.to) }
      if (joined.from === d.from && joined.to === d.to) return false
      this.done = joined
    } else if (to - from > d.to - d.from) this.done = { from, to }
    else return false
    // Reaching back to what was covered, it all is.
    if (this.covered > 0 && this.done.from <= this.covered) {
      this.covered = Math.max(this.covered, this.done.to)
      this.done = undefined
    }
    return true
  }

  // --- Keeping on the device (kept.ts seals this) ------------------------------------

  /** The welcome message as kept: whether it's gone, or where it is and whether it's read (its words never are). */
  private keptWelcome(): Pick<KeptMailbox, 'welcome'> {
    if (this.welcomeGone) return { welcome: 'gone' }
    const w = this.items.get(WELCOME)
    return w ? { welcome: { read: w.read, folder: w.folder, title: w.title } } : {}
  }

  /** Everything worth keeping, as plain data. Removed messages are remembered for as long as they matter. */
  toKept(now = Date.now()): KeptMailbox {
    const removed: [string, number][] = []
    for (const [id, at] of this.removed) if (now - at < REMEMBER_REMOVED_MS) removed.push([id, at])
    return {
      v: 1,
      label: this.label,
      ...(this.sharesQs ? { prefer: 'qs' as const } : {}),
      covered: this.covered,
      ...(this.done ? { done: { ...this.done } } : {}),
      folders: this.folderList.map((f) => ({ ...f })),
      book: this.contacts.map((c) => ({ address: toBase64url(c.address), name: c.name })),
      senders: [...this.senderMap.values()].map((x) => ({ address: toBase64url(x.address), n: x.n, names: x.names.map((y) => [y.name, y.first, y.last] as [string, number, number]) })),
      next: this.nextSender,
      shown: [...this.shown].map(([k, v]) => [toBase64url(fromHex(k)), v] as [string, string]),
      keys: [...this.replyKeyMap].map(([k, v]) => [toBase64url(fromHex(k)), toBase64url(v.keys), v.at] as [string, string, number]),
      ...(this.blockMap.size ? { blocks: [...this.blockMap.values()].map((b) => [toBase64url(b.address), b.at, b.on ? 1 : 0] as [string, number, 0 | 1]) } : {}),
      ...this.keptWelcome(),
      items: this.all()
        .filter((i) => i.id !== WELCOME)
        .map((i) => ({
          id: i.id,
          kind: i.kind,
          body: toBase64url(i.body),
          sent: i.sent,
          at: i.at,
          ...(i.qs ? { qs: true } : {}),
          folder: i.folder,
          read: i.read,
          title: i.title,
          ...(i.upload
            ? {
                upload: {
                  key: i.upload.key,
                  // Never a link the network has already let go: it can't be collected.
                  ...(i.upload.v1 && now < i.upload.expires ? { v1: toBase64url(i.upload.v1) } : {}),
                  size: i.upload.size,
                  sent: i.upload.sent,
                  expires: i.upload.expires,
                  ...(i.upload.collected ? { collected: i.upload.collected } : {}),
                },
              }
            : {}),
          ...(i.off ? { off: i.off } : {}),
          ...(i.from ? { from: { address: toBase64url(i.from.address), name: i.from.name } } : {}),
          // The files' names and sizes only: the files themselves are never kept.
          ...(i.mine ? { mine: { to: toBase64url(i.mine.address), ...(i.mine.upload !== undefined ? { upload: i.mine.upload } : {}), ...(i.mine.files?.length ? { files: i.mine.files.map((f) => ({ ...f })) } : {}) } } : {}),
        })),
      // Only what reached the network: a message still sending, or that failed, isn't kept.
      sent: [...this.sentMap.values()]
        .filter((x) => x.state === 'sent')
        .map((x) => ({
          id: x.id,
          to: toBase64url(x.address),
          body: toBase64url(x.body),
          at: x.at,
          ...(x.round ? { round: x.round } : {}),
          name: x.name,
          folder: x.folder,
          ...(x.qs ? { qs: true } : {}),
          ...(x.upload !== undefined ? { upload: x.upload } : {}),
          // The files' names and sizes only: the files themselves are never kept.
          ...(x.files?.length ? { files: x.files.map((f) => ({ name: f.name, size: f.size })) } : {}),
        })),
      removed,
    }
  }

  /**
   * A mailbox from what the device kept. Anything malformed is skipped
   * rather than trusted: the record is sealed, but a newer or damaged one
   * mustn't break opening the inbox.
   */
  static fromKept(data: unknown, filesOn: boolean): Mailbox {
    const box = new Mailbox()
    const d = (data ?? {}) as Partial<KeptMailbox>
    if (typeof d.label === 'string') box.label = cleanName(d.label)
    box.sharesQs = d.prefer === 'qs'
    // Never a time in the future: that would skip what arrives until then.
    if (typeof d.covered === 'number' && d.covered > 0 && d.covered <= Date.now()) box.covered = d.covered
    const done = d.done as { from?: unknown; to?: unknown } | undefined
    if (typeof done?.from === 'number' && typeof done.to === 'number' && done.to <= Date.now()) box.noteDone(done.from, done.to)
    for (const f of Array.isArray(d.folders) ? d.folders : []) {
      if (typeof f?.id === 'string' && /^f[0-9a-f]{12}$/.test(f.id) && typeof f.name === 'string' && cleanName(f.name) && !box.folder(f.id) && box.folderList.length < MAX_FOLDERS)
        box.folderList.push({ id: f.id, name: cleanName(f.name) })
    }
    for (const c of Array.isArray(d.book) ? d.book : []) {
      try {
        const address = fromBase64url(String(c?.address))
        if (isInboxAddress(address) && typeof c.name === 'string') box.saveContact(address, c.name)
      } catch {
        // skip it
      }
    }
    for (const r of Array.isArray(d.removed) ? d.removed : []) {
      if (Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'number') box.removed.set(r[0], r[1])
    }
    // A sender's inbox is always its compact address; one the owner wrote to may be either.
    const address = (v: unknown, either = false): Uint8Array | undefined => {
      try {
        const b = fromBase64url(String(v))
        return isCompact(b) || (either && isInboxAddress(b)) ? b : undefined
      } catch {
        return undefined
      }
    }
    // Senders in their numbers' order; a number that's missing or taken gets the next free one.
    const senders: { s: Sender; n: number }[] = []
    const seen = new Set<string>()
    for (const x of Array.isArray(d.senders) ? d.senders : []) {
      const a = x && typeof x === 'object' ? address(x.address) : undefined
      const key = a ? inboxKey(a) : ''
      if (!a || seen.has(key) || senders.length >= MAX_SENDERS) continue
      seen.add(key)
      const s: Sender = { key, address: a, n: 0, names: [] }
      for (const y of Array.isArray(x.names) ? x.names : []) {
        if (!Array.isArray(y) || typeof y[1] !== 'number' || typeof y[2] !== 'number') continue
        const name = cleanGivenName(String(y[0] ?? ''))
        if (name && !s.names.some((z) => z.name === name) && s.names.length < MAX_SENDER_NAMES) s.names.push({ name, first: y[1], last: y[2] })
      }
      senders.push({ s, n: Number.isSafeInteger(x.n) && x.n > 0 ? x.n : Infinity })
    }
    senders.sort((a, b) => a.n - b.n)
    const later: Sender[] = []
    const taken = new Set<number>()
    for (const { s, n } of senders) {
      if (n === Infinity || taken.has(n)) later.push(s)
      else {
        taken.add(n)
        box.senderMap.set(s.key, { ...s, n })
      }
    }
    box.nextSender = Math.max(1, Number.isSafeInteger(d.next) ? (d.next as number) : 1, ...[...box.senderMap.values()].map((y) => y.n + 1))
    for (const s of later) box.senderMap.set(s.key, { ...s, n: box.nextSender++ })
    for (const r of Array.isArray(d.shown) ? d.shown : []) {
      const a = Array.isArray(r) ? address(r[0]) : undefined
      const name = a && typeof r[1] === 'string' ? cleanGivenName(r[1]) : ''
      if (a && name && box.shown.size < MAX_BOOK) box.shown.set(inboxKey(a), name)
    }
    for (const r of Array.isArray(d.keys) ? d.keys : []) {
      const a = Array.isArray(r) ? address(r[0]) : undefined
      if (!a || typeof r[2] !== 'number') continue
      try {
        box.noteReplyKeys(inboxKey(a), fromBase64url(String(r[1])), r[2])
      } catch {
        // skip it
      }
    }
    for (const r of Array.isArray(d.blocks) ? d.blocks : []) {
      const a = Array.isArray(r) ? address(r[0]) : undefined
      // Never a time in the future: it would win every merge, and keep everything they sent.
      if (a && typeof r[1] === 'number' && !box.blockMap.has(inboxKey(a)) && box.blockMap.size < MAX_SENDERS) box.blockMap.set(inboxKey(a), { address: a, at: Math.min(r[1], Date.now()), on: r[2] === 1 })
    }
    for (const k of Array.isArray(d.items) ? d.items : []) {
      if (box.items.size >= MAX_HELD) break
      try {
        if (typeof k?.id !== 'string' || !/^[0-9a-f]{32}$/.test(k.id) || box.items.has(k.id) || box.removed.has(k.id)) continue
        const item: MailItem = {
          id: k.id,
          kind: Number(k.kind) | 0,
          body: fromBase64url(String(k.body ?? '')),
          sent: Number(k.sent) || 0,
          at: Number(k.at) || 0,
          ...(k.qs === true ? { qs: true } : {}),
          folder: typeof k.folder === 'string' && box.folder(k.folder) ? k.folder : INBOX,
          read: k.read === true,
          title: typeof k.title === 'string' ? cleanName(k.title, MAX_TITLE) : '',
        }
        const u = k.upload
        if (u && typeof u.key === 'string' && /^[0-9a-f]{66}$/.test(u.key)) {
          const v1 = typeof u.v1 === 'string' ? fromBase64url(u.v1) : undefined
          if (filesOn) {
            item.upload = { key: u.key, size: Number(u.size) || 0, sent: Number(u.sent) || 0, expires: Number(u.expires) || 0 }
            if (v1?.length === 148 && v1[0] === 1) item.upload.v1 = v1
            if (typeof u.collected === 'number') item.upload.collected = u.collected
          } else {
            // Kept by a copy that collects uploads; this one doesn't.
            v1?.fill(0)
            item.off = u.key
          }
        } else if (typeof k.off === 'string' && /^[0-9a-f]{66}$/.test(k.off)) item.off = k.off
        const to = k.mine && typeof k.mine === 'object' ? address(k.mine.to, true) : undefined
        // The owner's own, but who it went to is unreadable: skipped, never shown as if it had arrived.
        if (k.mine !== undefined && !to) continue
        if (to) {
          const mine: Mine = { address: to }
          if (Number.isSafeInteger(k.mine!.upload) && (k.mine!.upload as number) >= 0) mine.upload = k.mine!.upload
          const files = mine.upload !== undefined ? fileNotes(k.mine!.files) : []
          if (files.length) mine.files = files
          item.mine = mine
          item.read = true
          // Marked as it went, by the address it went to: an older record marked it by the tab shown.
          if (isQuantumSafe(to)) item.qs = true
          else delete item.qs
        }
        const from = to ? undefined : k.from ? address(k.from.address) : undefined
        if (from) {
          item.from = { address: from, key: inboxKey(from), name: typeof k.from!.name === 'string' ? cleanGivenName(k.from!.name) : '' }
          // A sender the record somehow lacks still gets a number, and the name this message gave.
          box.noteSender(item.from, when(item))
        }
        const key = item.upload?.key ?? item.off
        if (key && box.uploads.has(key)) continue
        if (key) box.uploads.add(key)
        box.items.set(item.id, item)
      } catch {
        // skip it
      }
    }
    for (const k of Array.isArray(d.sent) ? d.sent : []) {
      if (box.sentMap.size >= MAX_SENT) break
      try {
        const to = k && typeof k === 'object' ? address(k.to, true) : undefined
        if (!to || typeof k.id !== 'string' || !/^[0-9a-f]{32}$/.test(k.id) || box.sentMap.has(k.id) || box.removed.has(`s:${k.id}`)) continue
        const x: SentItem = {
          id: k.id,
          to: inboxKey(to),
          address: to,
          body: fromBase64url(String(k.body ?? '')),
          at: Number(k.at) || 0,
          name: typeof k.name === 'string' ? cleanGivenName(k.name) : '',
          folder: typeof k.folder === 'string' && box.folder(k.folder) ? k.folder : INBOX,
          state: 'sent',
        }
        if (k.qs === true) x.qs = true
        if (Number.isSafeInteger(k.upload) && (k.upload as number) >= 0) x.upload = k.upload
        if (x.upload !== undefined) {
          const files = fileNotes(k.files)
          if (files.length) x.files = files
        }
        if (typeof k.round === 'number' && k.round > 0) x.round = k.round
        box.putSent(x)
      } catch {
        // skip it
      }
    }
    if (d.welcome === 'gone') box.welcomeGone = true
    else if (typeof d.welcome === 'object' && d.welcome && box.addWelcome()) {
      const w = box.items.get(WELCOME)!
      w.read = d.welcome.read === true
      if (typeof d.welcome.folder === 'string' && box.folder(d.welcome.folder)) w.folder = d.welcome.folder
      if (typeof d.welcome.title === 'string') w.title = cleanName(d.welcome.title, MAX_TITLE)
    }
    box.gatherThreads()
    return box
  }
}

/** What's kept, before sealing (kept.ts). */
export interface KeptMailbox {
  v: 1
  label: string
  prefer?: 'qs' // the address the owner shared last, when it's the quantum-safe one (it once meant the owner's main address)
  covered: number
  done?: { from: number; to: number }
  folders: Folder[]
  book: { address: string; name: string }[]
  senders?: { address: string; n: number; names: [string, number, number][] }[]
  next?: number
  shown?: [string, string][]
  keys?: [string, string, number][] // reply keys each sender gave: their inbox, the keys, when
  blocks?: [string, number, 0 | 1][] // senders blocked (1) or unblocked since (0), and when
  items: {
    id: string
    kind: number
    body: string
    sent: number
    at: number
    qs?: boolean
    folder: string
    read: boolean
    title: string
    upload?: { key: string; v1?: string; size: number; sent: number; expires: number; collected?: number }
    off?: string
    from?: { address: string; name: string }
    mine?: { to: string; upload?: number; files?: FileNote[] }
  }[]
  sent?: { id: string; to: string; body: string; at: number; round?: number; name: string; folder: string; qs?: boolean; upload?: number; files?: FileNote[] }[]
  removed: [string, number][]
  /** The welcome message (WELCOME): removed, or where it is. None: it's added, unread, when the inbox opens. */
  welcome?: 'gone' | { read: boolean; folder: string; title: string }
}
