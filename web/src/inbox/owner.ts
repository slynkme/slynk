// The owner's side of an anonymous inbox: opening it with its 12 words or saved
// passphrase, then a card above the usual composer that works like a simple
// mail client: folders (Inbox, Archive and the owner's own), rows with an
// unread dot and no preview of the text (a screen in a shared office), a
// message opened in place in the list to read it, Archive, Move, a title of the
// owner's own, Mark as unread, and Remove. What the look-back finds and
// anything that arrives while it's open join the list (inbox/mailbox.ts).
//
// Without keeping, all of it is held in this tab's memory only. With "Keep
// this inbox on this device" (off by default), it's also kept, encrypted with
// a key from the inbox's words (inbox/kept.ts), and shown at once next time;
// "Forget this device" deletes that. Lock ends the core's worker, which is
// the only way to be sure the inbox's key is gone from Go's memory; the page
// then carries on with a fresh one.
//
// Replies: a message whose sender included their own inbox says who it's from
// (the owner's name for them, the name they gave, or "Sender 2"), with Reply,
// naming them in the address book (only when kept), all their messages
// together, and warnings when a name changes or looks like someone else's
// (mailbox.ts, nameFlags). Senders are told apart by their inbox, never by a
// name.
//
// With files to inboxes on (INBOX_FILES, site.ts), a notice can announce an
// upload: files or a longer message. It offers Collect (in the conversation's
// own bubble, or opened on its own if it came anonymously), which fetches it
// with this tab's identity, one at a time and only on the owner's click,
// straight from the notice and never through a URL. What's collected stays in
// memory until Forget or Lock, is saved only when asked, and is never kept on
// the device: only the entry is, with what's needed to collect it while the
// network holds it. The owner attaches files in the chat too, with the
// composer's own tray (tray.ts): the package uploads from this tab's
// identity, as a link's would, and a notice from the second identity tells
// them a few minutes later. Their message keeps its text and the files' names
// and sizes, never the files.
//
// Two addresses: whichever address a message came to, it's in the one list,
// with a marker (marker.ts): a padlock, or an atom for quantum-safe. The
// addresses are tabs only in Share, which opens on the one shared last.
import type { Core, CoreEvent, FoundNotice, InboxInfo, LookbackState, OnProgress } from '../core/client'
import { errorCode } from '../core/client'
import { EnvelopeError, decode, encode, fileNames, squeeze, store, type Item } from '../payload'
import { qualityFor } from '../squeeze/index.ts'
import { INBOX_FILES } from '../site'
import { createTray, type Compose, type Text, type Tray } from '../tray'
import { Eta, ago, capitalize, countLabel, piecesText, size } from '../ui/format'
import { fileRow, markSaved, messageRow as itemMessageRow, saveFile, setHidden } from '../ui/items'
import { linkedText } from '../ui/linkWarn'
import { zipButtons, type ZipButtons } from '../ui/zipButtons'
import { saveBlob } from '../ui/save'
import { safeName } from '../zip'
import { LINK_ORIGIN } from '../home'
import { addressFromInput, compactAddress, inboxLink, inboxQrText, isQuantumSafe, textBytes, textRoom } from './address'
import { $, clone, copyText, fillParts, isolate, part, plainParts, selectTab, wireTabs } from './dom'
import { attachMenu, closeMenus, type MenuItem } from './menu'
import { DROP_LIMIT, NOTICE_TEXT, needsUpload } from './drop'
import * as copy from './inboxCopy'
import type { Part } from './inboxCopy'
import {
  KeptError,
  deleteKept,
  forgetWords,
  holdKept,
  keptKey,
  readKept,
  readWords,
  relabelWords,
  rememberWords,
  rememberedInboxes,
  seal,
  unseal,
  wordsRemembered,
  writeKept,
  type KeptKey,
  type Remembered,
} from './kept'
import { KeyFileError, MAX_BACKUP_FILE, normalizeWords, openSealedWords, parseKeyFile, readKeyFile, sealWords, type ParsedKeyFile } from './keyfile'
import { ARCHIVE, INBOX, MAX_NAME, MAX_TITLE, Mailbox, WELCOME, cleanName, inboxKey, sentQs, type Contact, type FileNote, type Folder, type ListRow, type MailItem, type SentItem, type ThreadEntry } from './mailbox'
import { closeMarks, closeMarksIn, markIcon, marker, setMarker } from './marker'
import { MAX_GIVEN_NAME } from './names'
import { drawQr, qrSvgFile } from './qr'
import { closeScan, openScan } from './scan'
import { rememberPassword, resetRememberPassword, wireEye, wireRememberPasswords } from './rememberPw'
import { keyFileBox } from './keyFileBox'
import { coolKdf, warmKdf } from '../kdf'
import { closeShowWords, openShowWords } from './showWords'
import { fill as fillRoom, fits } from './pack'
import { meter } from '../ui/meter'
import { onSettings, settings } from '../ui/settings'

export interface OwnerDeps {
  core(): Core
  toast(text: string): void
  /** Starts joining the mixnet if the page hasn't. */
  ensureConnected(): void
  /** Runs fn once the page is connected (now, if it is). */
  whenReady(fn: () => void): void
  /** How the page's connection is going: 'idle' | 'connecting' | 'ready' | 'error', how far, and why it failed. */
  net(): { state: string; pct?: number; error?: string }
  /** Tries connecting again after a failure. */
  retryConnect(): void
  /** A send or a collect is under way, which Lock would cut short. */
  busy(): boolean
  /** Ends the core's worker and starts a fresh one. */
  replaceCore(): void
  /** Readies the core for checking an inbox (one that has sent to inboxes is replaced first). */
  claim(): void
  /** The inbox has opened (with its address) or been locked (undefined). */
  changed(info: InboxInfo | undefined): void
  /** The address book changed, or became available or not. */
  bookChanged(): void
  /**
   * Collects an upload with the page's identity, or gives undefined while
   * another download (a link being collected, say) is under way: the core
   * runs one at a time.
   */
  download(v1: Uint8Array, onProgress: OnProgress): Promise<Uint8Array> | undefined
  /** Stops the download under way. */
  stopDownload(): void
  /**
   * Sends a reply from the chat: one message to an inbox, with
   * this one included and the name shown, from the tab's second identity,
   * sealed with the reply keys that inbox gave, if any. onStage
   * hears how it's getting on. Resolves with its round's time.
   */
  sendReply(address: Uint8Array, text: string, name: string, replyKeys: Uint8Array | undefined, onStage: (stage: string) => void): Promise<number>
  /**
   * Uploads files, or a reply too long for one message, from the chat: an
   * ordinary upload from the tab's main identity, as a link's would
   * go. Resolves with its v1 link.
   */
  uploadReply(bytes: Uint8Array, onProgress: OnProgress): Promise<Uint8Array>
  /**
   * Tells an inbox about an upload made for it: a notice carrying its link,
   * with this inbox included and the name shown, from the tab's second
   * identity, a random 1-3 minutes after since, sealed with the reply keys
   * that inbox gave, if any. Resolves with its round's time.
   */
  noticeReply(address: Uint8Array, v1: Uint8Array, since: number, name: string, replyKeys: Uint8Array | undefined): Promise<number>
  /** Stops the reply's upload under way: uploadReply rejects. */
  stopUpload(): void
  /** Stops the reply's notice while it waits for its moment: noticeReply rejects. Resolves with whether it was in time. */
  stopNotice(): Promise<boolean>
  /** Why a reply can't go now (a link being sent or collected), or ''. upload: an upload, which waits for any collecting too. */
  canSend(upload?: boolean): string
  /** The owner has started writing a reply: the second identity, which it goes from, connects now. */
  warm(): void
  /** How many messages are unread, or how opening is going, changed: the front page's inbox bar. */
  unreadChanged(): void
  /** A new message arrived after the look-back: the tab's dot, if it's in the background. */
  arrived(): void
  /** Whether the inbox's own screen is showing. */
  onScreen(): boolean
  /**
   * New message, to an inbox with no conversation here yet: the usual
   * composer, addressed to it ("Let them reply" off unless switched on).
   */
  writeTo(address: Uint8Array): void
  /** A conversation opened (its inbox, in hex), or closed: a step in the browser's history, so Back closes it. */
  chatOpened(key: string): void
  chatClosed(): void
  /** A notice announcing an upload still has to go, which Lock would lose. */
  pending(): boolean
  /** Whether this inbox can be included with a message changed: it has opened in the core, or locked. */
  includeChanged(): void
  /** Opens Settings at one switch (a link under a chat's files names "Make photos smaller to fit"). */
  openSetting(id: string): void
}

/** An upload being or having been collected, and its part of the message opened (or of its conversation's bubble). */
interface Drop {
  item: MailItem
  el: HTMLElement
  state: 'ready' | 'collecting' | 'failed' | 'damaged' | 'expired' | 'collected'
  error: string
  stalledAt: number // pieces received when the stall notice last showed
  stopping: boolean
  bytes?: Uint8Array
  items?: Item[]
  drawn?: Item[] // the items its list was last drawn from: drawn again only when they change
  gone: boolean // wiped (Lock, or removed): late results are discarded
  zip: ZipButtons // Save all and Share all, once collected (shared with the received screen)
}

/** Files, or a reply too long for one message, on their way from the chat: in memory only. */
interface Outgoing {
  bytes?: Uint8Array // the package, until it has uploaded
  v1?: Uint8Array // its link, once uploaded: Try again then sends only the notice
  since: number // when the upload finished
  done: number // pieces uploaded so far, of total
  total: number
}

/** A conversation's files for its next reply: the tray, its list and its offer of smaller copies. */
interface ChatTray {
  tray: Tray
  list: HTMLElement
  fit: HTMLElement
}

/** A file, in the owner's own message. */
const FILE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>'

/** An anonymous sender's picture: a figure with no face. */
const ANONYMOUS_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="9" r="3.6" /><path d="M5.2 19.6a6.8 6.8 0 0 1 13.6 0" /></svg>'

/** The welcome message's picture: the site's own coil, in the text's colour (no gradient, so no ID to clash with the header's). */
const SITE_SVG =
  '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" aria-hidden="true"><ellipse cx="17" cy="32" rx="6" ry="18" transform="rotate(-18 17 32)" /><ellipse cx="27" cy="32" rx="6" ry="18" transform="rotate(-18 27 32)" /><ellipse cx="37" cy="32" rx="6" ry="18" transform="rotate(-18 37 32)" /><ellipse cx="47" cy="32" rx="6" ry="18" transform="rotate(-18 47 32)" /></svg>'

/** An inbox the owner has no name or number for: the inbox's own tray, as in "To an anonymous inbox". */
const INBOX_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 13.5 6 6.6A2 2 0 0 1 7.9 5.3h8.2A2 2 0 0 1 18 6.6l2.5 6.9" /><path d="M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5H16l-1.5 2.3h-5L8 13.5z" /></svg>'

/**
 * What kind of row it is, small on its second line (to tell conversations
 * from one-way messages, and which way those went): two
 * speech bubbles, or an arrow coming in or going out.
 */
const KIND_SVG = {
  thread:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" /><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" /></svg>',
  in: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 7 7 17" /><path d="M17 17H7V7" /></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7" /><path d="M7 7h10v10" /></svg>',
}

/** An inbox's address from its hex. */
const fromHexKey = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))

/** A cross: remove. */
const CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>'

/** Three dots: a menu of what's done less often. */
const MORE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="18.5" cy="12" r="1.7" /></svg>'

/** A name's first letter, as the eye sees it (a whole emoji or accented letter), in capitals. */
function firstLetter(name: string): string {
  const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)[Symbol.iterator]().next().value?.segment : undefined
  return (seg ?? [...name][0] ?? '').toLocaleUpperCase()
}

/** Messages beyond this many make the flood note show. */
const FLOOD_AT = 200
/** Changes are kept a moment after the last one, so a burst is one write. */
const SAVE_AFTER_MS = 300

export function setupOwner(deps: OwnerDeps) {
  let info: InboxInfo | undefined
  let opening: string | undefined // the words, until the core has them
  let lookback: LookbackState | undefined
  let failed = ''
  let box = new Mailbox()
  let folder = INBOX // the folder shown
  let openId: string | undefined // the one-way message open in the list, in place
  let selecting = false // ticking rows to act on several at once
  const selected = new Set<string>() // the rows ticked, by rowKey
  let chatWith: Uint8Array | undefined // the conversation open, by the other inbox's address (its quantum-safe one, if known)
  const rows = new Map<string, HTMLElement>()
  const drops = new Map<string, Drop>()
  let collecting: Drop | undefined // the one upload being collected

  // Keeping on this device (kept.ts)
  let key: KeptKey | undefined // from the words: held while the inbox is open, kept or not
  let keeping = false // this tab saves what's kept
  let elsewhere = false // kept, but another tab with this inbox open saves it
  let blocked = false // something kept couldn't be read: left as it is, never overwritten
  let offerDismissed = false // "Not now" on the offer to keep it, for this visit
  let resuming = false // this visit carries on from a look-back cut short
  let release: (() => void) | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<void> = Promise.resolve()
  /** A save failed while the page was out of sight: it's made again when the page is back. */
  let saveOnShow = false
  let releasing: Promise<void> = Promise.resolve() // Lock's last write, after which its hold on the record ends
  let opened = 0 // bumps on every open and lock, so a late step of an earlier one stops

  const card = $('inbox-card')
  // This inbox's words are remembered on this device ("Remember my passphrase"): as they are, or
  // encrypted with the owner's password.
  let remembered: false | 'plain' | 'password' = false

  // The warnings before remembering the words, wherever it's offered, and the optional password under them.
  wireRememberPasswords()
  const kept = () => keeping || elsewhere

  // --- Status -----------------------------------------------------------------------

  function status() {
    const el = $('ib-status')
    const net = deps.net()
    $('ib-retry').hidden = !failed && !(opening && net.state === 'error')
    let text: string
    if (failed) text = copy.OWNER_FAILED(failed)
    else if (opening && net.state === 'error') text = copy.OWNER_FAILED(net.error ?? '')
    else if (opening && net.state === 'connecting') text = net.pct === undefined ? copy.OWNER_CONNECTING : copy.OWNER_JOINING(net.pct)
    else if (opening) text = copy.OWNER_CONNECTING
    else if (!lookback) text = copy.OWNER_LOOKING(0, 0)
    else if (lookback.finished) text = lookback.missing ? copy.OWNER_FINISHED_MISSING : copy.OWNER_FINISHED
    else if (lookback.collecting > 0 && lookback.daysLeft === 0) text = copy.OWNER_COLLECTING
    else text = resuming ? copy.OWNER_RESUMING(lookback.daysLeft, lookback.daysTotal) : copy.OWNER_LOOKING(lookback.daysLeft, lookback.daysTotal)
    const count = box.received + box.overflow
    // "No messages waiting" would be premature while some haven't been handed over.
    if (lookback?.finished && !failed && (count || !lookback.missing)) text = `${count ? copy.OWNER_COUNT(count) + '.' : copy.OWNER_NONE} ${text}`
    el.textContent = text
    // The card's icon: a spinner while it works, a tick once it has looked back, "!" if it couldn't open.
    $('ib-status-card').dataset.state = failed || (opening && net.state === 'error') ? 'failed' : lookback?.finished ? 'done' : 'busy'
    // Screen readers hear when the stage changes, not every day counted.
    const stage = failed || net.state === 'error' ? 'failed' : opening ? 'connecting' : lookback?.finished ? 'finished' : 'looking'
    if (stage !== announced) {
      announced = stage
      $('ib-announce').textContent = text
    }
    // The front page's bar says how opening is going too.
    deps.unreadChanged()
  }
  let announced = ''

  function onEvent(e: CoreEvent) {
    if (!info) return
    if (e.event === 'lookback') {
      lookback = e.lookback
      markCovered()
      status()
      renderOffer()
    } else {
      addMessage(e.notice)
    }
  }

  // --- How far the look-back has got, so a kept inbox needn't look back again --------

  /**
   * Once a look-back has finished with nothing the network failed to hand
   * over, everything up to now is here: the next look-back of a kept inbox
   * starts from a day before this (Mailbox.lookbackFrom). A look-back cut
   * short, or rounds still missing, leave the mark where it was, or those
   * messages would be skipped for good.
   */
  function markCovered() {
    if (!lookback) return
    if (lookback.finished && !lookback.missing && !lookback.collecting) {
      box.coveredUpTo(Date.now())
      changed()
    } else if (!lookback.finished && lookback.doneFrom > 0 && !lookback.collecting) {
      // Cut short now, it carries on from here next time.
      if (box.noteDone(lookback.doneFrom, Date.now())) changed()
    }
  }

  // --- Keeping on this device -----------------------------------------------------------

  function renderKeep() {
    const text = $('ib-keep-text')
    if (blocked) text.textContent = copy.KEEP_UNREADABLE
    else if (elsewhere) text.textContent = `${copy.KEEP_ON}. ${copy.KEEP_ELSEWHERE}`
    else text.textContent = keeping ? (remembered ? copy.KEEP_ON_REMEMBERED : copy.KEEP_ON) : remembered ? copy.KEEP_OFF_REMEMBERED : copy.KEEP_OFF
    renderOffer()
    deps.bookChanged()
  }

  /**
   * The offer to keep it, while an inbox that isn't kept looks back through
   * everything the network holds (the wait is felt then), and after, until
   * the owner answers it.
   */
  const offerShown = () => !!info && !!key && !kept() && !blocked && !offerDismissed && !!lookback

  function renderOffer() {
    $('ib-keep-offer').hidden = !offerShown()
  }

  $('ib-offer-yes').addEventListener('click', async () => {
    if (await startKeeping(true)) {
      deps.toast(copy.KEEP_STARTED)
      $('ib-status').focus()
    }
  })
  $('ib-offer-no').addEventListener('click', () => {
    offerDismissed = true
    renderKeep()
    $('ib-status').focus()
  })

  /**
   * Starts saving this inbox's record. fresh: the owner has just asked, so
   * what's already kept (another tab may have kept it) is read and merged
   * first, never overwritten, and the result written now. False if another
   * tab holds it, or it can't be read or written.
   */
  async function startKeeping(fresh: boolean): Promise<boolean> {
    if (!key || keeping || blocked) return false
    const run = opened
    const k = key
    await releasing // this tab's last Lock, still writing
    const rel = await holdKept(k.name)
    if (run !== opened) {
      rel?.()
      return false
    }
    if (!rel) {
      elsewhere = true
      renderKeep()
      return false
    }
    release = rel
    if (fresh) {
      // Not keeping yet: a Lock meanwhile mustn't write before what's kept is merged in.
      try {
        const rec = await readKept(k.name)
        if (run !== opened) {
          rel()
          return false
        }
        if (rec !== undefined) {
          // What's on screen stays as it is; what was kept joins it.
          const stored = Mailbox.fromKept(await unseal(k, rec), INBOX_FILES)
          box.merge(stored)
          stored.wipeAll()
          for (const [id, d] of drops) {
            if (box.get(id)) continue
            wipeDrop(d) // removed in what was kept
            drops.delete(id)
          }
          render()
        }
        await writeKept(k.name, await seal(k, box.toKept()))
      } catch (e) {
        release = undefined
        rel()
        if (e instanceof KeptError && e.code === 'unreadable') blocked = true
        renderKeep()
        deps.toast(blocked ? copy.KEEP_UNREADABLE : copy.KEEP_FAILED)
        return false
      }
      if (run !== opened) {
        rel()
        return false
      }
    }
    keeping = true
    elsewhere = false
    renderKeep()
    return true
  }

  function stopKeeping() {
    keeping = false
    saveOnShow = false
    clearTimeout(saveTimer)
    release?.()
    release = undefined
  }

  function changed() {
    if (!keeping) return
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => void save(), SAVE_AFTER_MS)
  }

  /** Writes what's kept now, after any write still going. */
  function save(): Promise<void> {
    clearTimeout(saveTimer)
    if (!keeping || !key) return saving
    const k = key
    const data = box.toKept()
    saving = saving.then(async () => {
      try {
        await writeKept(k.name, await seal(k, data))
      } catch {
        if (!keeping || key !== k) return
        // Out of sight, a phone may have put the page to sleep partway through: it's saved again
        // once the page is back, rather than giving up on keeping it.
        if (document.visibilityState === 'hidden') {
          saveOnShow = true
          return
        }
        stopKeeping()
        renderKeep()
        deps.toast(copy.KEEP_FAILED)
      }
    })
    return saving
  }

  // A change made just before the tab closes or goes to the background is written at once, and a
  // save that failed meanwhile is made again once it's back.
  // Back in sight, a conversation left open has been seen.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && keeping) void save()
    if (document.visibilityState === 'visible' && saveOnShow) {
      saveOnShow = false
      if (keeping) void save()
    }
    if (document.visibilityState === 'visible' && info && chatWith && deps.onScreen()) render()
  })

  /** The inbox's own menu (⋯ in the card's head): renaming it, and keeping it on this device or forgetting it. */
  attachMenu($<HTMLButtonElement>('ib-more-go'), $('ib-more-menu'), () => {
    const items: MenuItem[] = [{ label: copy.OWNER_RENAME, run: openRename }]
    // Something kept that can't be read can still be forgotten, so keeping can start afresh.
    // A second tab with the inbox open can't keep it.
    if (key && !elsewhere) {
      // Remembering the words goes with keeping the inbox here. Remembered words can always be
      // forgotten, even if keeping stopped (a save the browser refused).
      // With a password, the words can be shown again, once it's typed.
      if (remembered === 'password') items.push({ label: copy.SHOW_WORDS, run: () => key && openShowWords(key.name) })
      if (remembered) items.push({ label: copy.REMEMBER_FORGET, run: askForgetWords })
      else if (keeping) items.push({ label: copy.REMEMBER_START, run: askRemember })
      items.push(keeping || blocked || remembered ? { label: copy.KEEP_FORGET, danger: true, run: askForget } : { label: copy.KEEP_START, run: () => void keepNow() })
    }
    // A file of the passphrase, for unlocking it elsewhere: whether or not it's kept or remembered here.
    items.splice(1, 0, { label: copy.SAVEFILE_START, run: askSaveFile })
    // Whoever's blocked, while anyone is.
    const blockedCount = box.blocked().length
    if (blockedCount) items.splice(2, 0, { label: copy.BLOCKED_MENU(blockedCount), run: openBlocked })
    return items
  })
  $('ib-more-go').setAttribute('aria-label', copy.OWNER_MENU)

  async function keepNow() {
    if (info && (await startKeeping(true))) deps.toast(copy.KEEP_STARTED)
  }
  // Forget this device deletes what's kept here and locks the inbox, back to the front page (a
  // red "Forget" that left everything open didn't feel done). So it waits for what
  // Lock waits for, and keeps the inbox open if the deleting fails.
  function forgetWait(): string {
    const wait = lockWait()
    return wait === copy.OWNER_LOCK_BUSY ? copy.FORGET_BUSY : wait
  }
  function askForget() {
    if (!info) return
    const wait = forgetWait()
    if (wait) return deps.toast(wait)
    $('ib-forget-text').textContent = remembered ? `${copy.FORGET_ASK} ${copy.FORGET_ASK_WORDS}` : copy.FORGET_ASK
    $('ib-forget-ask').hidden = false
    $('ib-forget-no').focus()
  }
  $('ib-forget-no').addEventListener('click', () => {
    $('ib-forget-ask').hidden = true
    $('ib-more-go').focus()
  })
  $('ib-forget-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('ib-forget-no').click()
  })
  $('ib-forget-yes').addEventListener('click', async () => {
    $('ib-forget-ask').hidden = true
    const k = key
    if (!k || !(keeping || blocked || remembered)) return
    const wait = forgetWait()
    if (wait) return deps.toast(wait)
    stopKeeping()
    try {
      await saving
      await deleteKept(k.name) // its remembered words too
    } catch {
      deps.toast(copy.KEEP_FAILED)
      renderKeep()
      render()
      return $('ib-more-go').focus()
    }
    blocked = false
    remembered = false
    if (key !== k) return // locked meanwhile
    lock()
    deps.toast(copy.FORGOTTEN)
  })

  // --- Remembering the words on this device (off unless the owner asks) ---------------------
  // From the inbox's menu the page no longer has the words (the core does), so they're typed once
  // more, which also shows it's the owner. The warnings come first, every time.

  const rememberField = $<HTMLInputElement>('ib-remember-words')
  // Its eye, as the other passphrase boxes have: hidden as it's typed until pressed.
  const rememberEye = wireEye($<HTMLButtonElement>('ib-remember-words-eye'), rememberField, copy.OPEN_SHOW, copy.OPEN_HIDE)
  function hideRememberWords() {
    rememberField.value = ''
    rememberField.type = 'password'
    rememberEye()
  }

  function askRemember() {
    if (!info || !keeping) return
    closeHeadPanels()
    hideRememberWords()
    resetRememberPassword('ib-remember-pw')
    $('ib-remember-error').hidden = true
    $('ib-remember-ask').hidden = false
    // The warnings first. On a touch screen, focusing the words box would scroll past them and bring
    // up the keyboard (seen on an iPhone): the warnings come into sight and take the focus, so
    // screen readers start there too, and the owner taps the box when they've read them.
    if (matchMedia('(pointer: fine)').matches) return rememberField.focus()
    const warn = $('ib-remember-warn')
    warn.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    warn.focus({ preventScroll: true })
  }

  // "Back up your passphrase…": the passphrase typed once more, and checked as this inbox's, then
  // saved as the inbox's last step saves it. Closing the panel, or locking, empties it. Now "Back up
  // your inbox…": with its messages too, unless that's switched off, everything it would keep
  // on a device, so restoring it elsewhere brings them back.
  const saveFileField = $<HTMLInputElement>('ib-savefile-words')
  const saveFileAll = $<HTMLInputElement>('ib-savefile-all')
  const saveFileEye = wireEye($<HTMLButtonElement>('ib-savefile-words-eye'), saveFileField, copy.OPEN_SHOW, copy.OPEN_HIDE)
  const passphraseFile = keyFileBox('ib-kf', async () => {
    const at = info?.address
    const words = normalizeWords(saveFileField.value)
    if (!at || !words) {
      saveFileField.focus()
      return undefined
    }
    try {
      const checked = await deps.core().inboxCheckWords(words)
      checked.store?.fill(0)
      if (checked.address.length !== at.length || !checked.address.every((b, i) => b === at[i])) return copy.REMEMBER_WRONG
    } catch {
      return copy.REMEMBER_WRONG
    }
    if (!info || info.address !== at) return undefined
    return { words, label: box.label, ...(saveFileAll.checked && !$('ib-savefile-all-row').hidden ? { inbox: box.toKept() } : {}) }
  })

  function askSaveFile() {
    if (!info) return
    closeHeadPanels()
    saveFileField.value = ''
    saveFileField.type = 'password'
    saveFileEye()
    passphraseFile.reset()
    // Its messages go too, unless switched off; with nothing but the words, it's the passphrase alone.
    $('ib-savefile-all-row').hidden = !box.holdsMore()
    saveFileAll.checked = true
    $('ib-savefile-all-help').textContent = copy.SAVEFILE_ALL_HELP(box.size)
    $('ib-savefile-ask').hidden = false
    warmKdf()
    // As for remembering it: not focused on a touch screen, where the keyboard would cover the note.
    if (matchMedia('(pointer: fine)').matches) saveFileField.focus()
  }

  function closeSaveFile(refocus = true) {
    if ($('ib-savefile-ask').hidden) return
    $('ib-savefile-ask').hidden = true
    saveFileField.value = ''
    saveFileField.type = 'password'
    saveFileEye()
    passphraseFile.empty()
    coolKdf()
    if (refocus) $('ib-more-go').focus()
  }

  $('ib-savefile-close').addEventListener('click', () => closeSaveFile())

  // "Blocked senders (2)…": each blocked sender, how many of their messages are set
  // aside, Show (their conversation, where they can be unblocked too) and Unblock.
  function openBlocked() {
    if (!info) return
    closeHeadPanels()
    renderBlocked()
    $('ib-blocked').hidden = false
    $('ib-blocked-list').querySelector('button')?.focus()
  }

  function renderBlocked() {
    const list = $('ib-blocked-list')
    list.replaceChildren(
      ...box.blocked().map((b) => {
        const li = document.createElement('li')
        const avatar = document.createElement('span')
        avatar.className = 'avatar'
        avatar.setAttribute('aria-hidden', 'true')
        paintAvatar(avatar, b.address)
        const who = document.createElement('span')
        who.className = 'blocked-who'
        const name = document.createElement('strong')
        fillParts(name, whoIs(b.address))
        const count = document.createElement('span')
        count.textContent = copy.BLOCKED_COUNT(b.count)
        who.append(name, count)
        const show = document.createElement('button')
        show.type = 'button'
        show.className = 'btn mini ghost'
        show.textContent = copy.BLOCKED_SHOW
        show.addEventListener('click', () => openChat(b.address))
        const unblock = document.createElement('button')
        unblock.type = 'button'
        unblock.className = 'btn mini'
        unblock.textContent = copy.UNBLOCK
        unblock.addEventListener('click', () => {
          unblockSender(b.address)
          if (!box.blocked().length) return closeBlocked()
          renderBlocked()
          $('ib-blocked-list').querySelector('button')?.focus()
        })
        // Their conversation removed, there's nothing to show; the block still holds.
        show.hidden = !b.count
        li.append(avatar, who, show, unblock)
        return li
      }),
    )
  }

  function closeBlocked(refocus = true) {
    if ($('ib-blocked').hidden) return
    $('ib-blocked').hidden = true
    $('ib-blocked-list').replaceChildren()
    if (refocus) $('ib-more-go').focus()
  }
  $('ib-blocked-close').addEventListener('click', () => closeBlocked())

  function unblockSender(address: Uint8Array) {
    if (!box.block(address, false)) return
    changed()
    render()
    deps.unreadChanged()
    deps.toast(copy.UNBLOCKED(isolate(plain(whoIs(address)))))
  }

  function closeRemember(refocus = true) {
    $('ib-remember-ask').hidden = true
    hideRememberWords()
    resetRememberPassword('ib-remember-pw')
    if (refocus) $('ib-more-go').focus()
  }

  $('ib-remember-no').addEventListener('click', () => closeRemember())
  $('ib-remember-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeRemember()
    }
    if (e.key === 'Enter' && [rememberField, $('ib-remember-pw'), $('ib-remember-pw2')].includes(e.target as HTMLInputElement)) $('ib-remember-yes').click()
  })
  $('ib-remember-yes').addEventListener('click', async () => {
    const yes = $<HTMLButtonElement>('ib-remember-yes')
    const at = info?.address
    const words = normalizeWords(rememberField.value)
    if (yes.disabled) return
    if (!at || !key || !keeping || !words) return rememberField.focus()
    const password = rememberPassword('ib-remember-pw')
    if (password === undefined) return
    const error = $('ib-remember-error')
    let checked: InboxInfo
    yes.disabled = true
    try {
      checked = await deps.core().inboxCheckWords(words)
    } catch {
      error.textContent = copy.REMEMBER_WRONG
      error.hidden = false
      return rememberField.focus()
    } finally {
      yes.disabled = false
    }
    checked.store?.fill(0)
    if (checked.address.length !== at.length || !checked.address.every((b, i) => b === at[i])) {
      error.textContent = copy.REMEMBER_WRONG
      error.hidden = false
      return rememberField.focus()
    }
    yes.disabled = true
    try {
      if (await storeWords(words, password)) {
        closeRemember()
        deps.toast(copy.REMEMBERED(!!password))
      }
    } finally {
      yes.disabled = false
    }
  })

  /** Remembers the words beside the kept inbox: encrypted with the owner's password, if they gave one. */
  async function storeWords(words: string, password = ''): Promise<boolean> {
    const k = key
    if (!k || !keeping) return false
    try {
      await rememberWords(k.name, password ? await sealWords(words, password) : words.trim(), box.label)
    } catch {
      deps.toast(copy.REMEMBER_FAILED)
      return false
    }
    // Locked, or forgotten, while it was being written: the words never outlive what asked for them.
    if (key !== k || !keeping) {
      await forgetWords(k.name).catch(() => {})
      return false
    }
    remembered = password ? 'password' : 'plain'
    renderKeep()
    return true
  }

  function askForgetWords() {
    if (!info || !remembered) return
    closeHeadPanels()
    $('ib-words-ask').hidden = false
    $('ib-words-no').focus()
  }
  $('ib-words-no').addEventListener('click', () => {
    $('ib-words-ask').hidden = true
    $('ib-more-go').focus()
  })
  $('ib-words-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-words-no').click()
    }
  })
  $('ib-words-yes').addEventListener('click', async () => {
    $('ib-words-ask').hidden = true
    await forgetWordsNow()
    $('ib-more-go').focus()
  })

  async function forgetWordsNow() {
    const k = key
    if (!k) return
    try {
      await forgetWords(k.name)
    } catch {
      return deps.toast(copy.KEEP_FAILED)
    }
    if (key !== k) return
    remembered = false
    renderKeep()
    deps.toast(copy.WORDS_FORGOTTEN)
  }

  // --- The label: a name for the owner's own screens ----------------------------------------

  function renderLabel() {
    $('ib-name').textContent = box.label || copy.OWNER_LABEL
  }

  const renameBox = $('ib-rename-box')
  const renameField = $<HTMLInputElement>('ib-rename-field')
  renameField.maxLength = MAX_NAME * 2
  function openRename() {
    renameField.value = box.label
    renameBox.hidden = false
    renameField.focus()
  }
  function closeRename() {
    renameBox.hidden = true
    $('ib-more-go').focus()
  }
  $('ib-rename-cancel').addEventListener('click', closeRename)
  $('ib-rename-save').addEventListener('click', () => {
    box.label = cleanName(renameField.value)
    renderLabel()
    changed()
    // The open screen names a remembered inbox by its label.
    if (remembered && key) void relabelWords(key.name, box.label).catch(() => {})
    closeRename()
  })
  renameField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ib-rename-save').click()
    if (e.key === 'Escape') closeRename()
  })

  // --- Share: the two addresses as tabs -----------------------------------------------------
  // The inbox's messages are all in one list, each with its marker, and its two
  // addresses are tabs only where one is shared. Share opens on the one shared
  // last (Mailbox.sharesQs, kept with the inbox when it's kept), at first the
  // one chosen as it was made.

  for (const tab of $('ib-tabs').querySelectorAll<HTMLElement>('[role="tab"]')) tab.prepend(markIcon(tab.dataset.qs === 'true'))

  function renderShareTabs() {
    const tab = $(box.sharesQs ? 'ib-tab-qs' : 'ib-tab-secure')
    selectTab($('ib-tabs'), tab)
    $('ib-share-panel').setAttribute('aria-labelledby', tab.id)
  }

  wireTabs($('ib-tabs'), (tab) => {
    const qs = tab.dataset.qs === 'true'
    if (qs === box.sharesQs) return
    box.sharesQs = qs
    changed()
    renderShareTabs()
    void fillShare()
  })

  // --- Folders ------------------------------------------------------------------------------

  const builtIn = () => [copy.FOLDER_INBOX, copy.FOLDER_ARCHIVE]
  const folderName = (id: string) => (id === INBOX ? copy.FOLDER_INBOX : id === ARCHIVE ? copy.FOLDER_ARCHIVE : (box.folder(id)?.name ?? copy.FOLDER_INBOX))

  /** A folder's button, wherever it is (on the first line, or under "Your folders"): by default the folder shown's. */
  const folderButton = (id = folder) => {
    const at = `[data-folder="${CSS.escape(id)}"]`
    return $('ib-folders').querySelector<HTMLElement>(at) ?? $('ib-own-folders-list').querySelector<HTMLElement>(at)
  }

  function folderChip(f: Folder, counts: Map<string, { unread: number }>): HTMLElement {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'folder'
    b.dataset.folder = f.id
    b.setAttribute('aria-pressed', String(f.id === folder))
    const name = document.createElement('span')
    name.className = 'folder-name'
    name.textContent = folderName(f.id)
    b.append(name)
    const unread = counts.get(f.id)?.unread ?? 0
    if (unread) {
      const n = document.createElement('span')
      n.className = 'folder-count'
      n.textContent = String(unread)
      n.setAttribute('aria-hidden', 'true')
      const sr = document.createElement('span')
      sr.className = 'sr-only'
      sr.textContent = `, ${copy.FOLDER_UNREAD(unread)}`
      b.append(n, sr)
    }
    b.addEventListener('click', () => showFolder(f.id))
    return b
  }

  /**
   * Inbox, Archive and New folder on the first line (with the tick box for selecting), and the
   * owner's own folders on a line of their own under a small "Your folders".
   */
  function renderFolders() {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.folder
    const counts = box.counts()
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'folder folder-add'
    add.dataset.folder = '+'
    add.textContent = copy.FOLDER_NEW
    add.addEventListener('click', () => openFolderForm('new'))
    $('ib-folders').replaceChildren(...[INBOX, ARCHIVE].map((id) => folderChip({ id, name: '' }, counts)), add)
    const mine = box.ownFolders()
    $('ib-own-folders-list').replaceChildren(...mine.map((f) => folderChip(f, counts)))
    $('ib-own-folders').hidden = !mine.length
    if (focused) folderButton(focused)?.focus()
    const own = !!box.folder(folder) && folder !== INBOX && folder !== ARCHIVE
    $('ib-folder-tools').hidden = !own
  }

  function showFolder(id: string) {
    folder = box.folder(id) ? id : INBOX
    openId = undefined
    closeOpenForms()
    // What's ticked belongs to the folder it's in.
    selecting = false
    selected.clear()
    saveDraft()
    chatWith = undefined
    closeFolderForm(false)
    $('ib-folder-ask').hidden = true
    render()
  }

  let formMode: 'new' | 'rename' = 'new'
  const folderField = $<HTMLInputElement>('ib-folder-field')
  folderField.maxLength = MAX_NAME * 2

  function openFolderForm(mode: 'new' | 'rename') {
    closeNew(false)
    formMode = mode
    folderField.value = mode === 'rename' ? folderName(folder) : ''
    $('ib-folder-save').textContent = mode === 'rename' ? copy.FOLDER_SAVE : copy.FOLDER_CREATE
    $('ib-folder-error').hidden = true
    $('ib-folder-ask').hidden = true
    $('ib-folder-form').hidden = false
    folderField.focus()
  }

  function closeFolderForm(refocus = true) {
    if ($('ib-folder-form').hidden) return
    $('ib-folder-form').hidden = true
    if (refocus) folderButton(formMode === 'new' ? '+' : folder)?.focus()
  }

  function folderError(text: string) {
    $('ib-folder-error').textContent = text
    $('ib-folder-error').hidden = false
  }

  $('ib-folder-save').addEventListener('click', () => {
    if (formMode === 'new') {
      const f = box.addFolder(folderField.value, builtIn())
      if (f === 'empty') return folderField.focus()
      if (f === 'taken') return folderError(copy.FOLDER_TAKEN)
      if (f === 'full') return folderError(copy.FOLDER_FULL)
      changed()
      formMode = 'rename' // so the focus goes to the new folder
      folder = f.id
      closeFolderForm(false)
      showFolder(f.id)
      folderButton(f.id)?.focus()
      return
    }
    const r = box.renameFolder(folder, folderField.value, builtIn())
    if (r === 'empty') return folderField.focus()
    if (r === 'taken') return folderError(copy.FOLDER_TAKEN)
    changed()
    closeFolderForm()
    render()
  })
  $('ib-folder-cancel').addEventListener('click', () => closeFolderForm())
  folderField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ib-folder-save').click()
    if (e.key === 'Escape') closeFolderForm()
  })
  $('ib-folder-rename').addEventListener('click', () => openFolderForm('rename'))
  $('ib-folder-delete').addEventListener('click', () => {
    closeFolderForm(false)
    $('ib-folder-ask-text').textContent = copy.FOLDER_DELETE_ASK(folderName(folder))
    $('ib-folder-ask').hidden = false
    $('ib-folder-no').focus()
  })
  $('ib-folder-no').addEventListener('click', () => {
    $('ib-folder-ask').hidden = true
    $('ib-folder-delete').focus()
  })
  $('ib-folder-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('ib-folder-no').click()
  })
  $('ib-folder-yes').addEventListener('click', () => {
    box.deleteFolder(folder)
    changed()
    showFolder(INBOX)
    folderButton(INBOX)?.focus()
  })

  // --- New message: write to another inbox ---------------------------------------------------
  // Beside the folders: paste an inbox's address, scan its QR code (scan.ts),
  // or pick a name from the address book (only while the inbox is kept). A
  // conversation already under way with that inbox opens; otherwise the usual
  // composer, addressed to it, where "Let them reply" is off unless switched
  // on.

  const newBox = $('ib-new')
  const newField = $<HTMLInputElement>('ib-new-field')

  function openNew() {
    renderNew()
    $('ib-new-error').hidden = true
    newBox.hidden = false
    $('ib-new-go-open').setAttribute('aria-expanded', 'true')
    newField.focus()
  }

  function closeNew(refocus = true) {
    if (newBox.hidden) return
    newBox.hidden = true
    newField.value = ''
    renderNewKind()
    $('ib-new-go-open').setAttribute('aria-expanded', 'false')
    if (refocus) $('ib-new-go-open').focus()
  }

  /** The step's label, the names to pick from, and the address book with a way to remove each. */
  function renderNew() {
    const book = withBook() ? box.book() : []
    $('ib-new-label').textContent = copy.SEND_TO_LABEL(book.length > 0)
    $('ib-new-names').replaceChildren(...book.map((c) => Object.assign(document.createElement('option'), { value: c.name })))
    $('book').hidden = !book.length
    $('book-list').replaceChildren(
      ...book.map((c) => {
        const li = document.createElement('li')
        li.className = 'book-entry'
        const write = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn book-name', textContent: c.name })
        write.setAttribute('aria-label', copy.BOOK_WRITE(c.name))
        write.addEventListener('click', () => writeTo(c.address))
        const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn small' })
        remove.setAttribute('aria-label', copy.BOOK_REMOVE(c.name))
        remove.innerHTML = CLOSE_SVG // fixed markup
        remove.addEventListener('click', () => {
          if (box.removeContact(c.address)) changed()
          deps.bookChanged()
          deps.toast(copy.BOOK_REMOVED(isolate(c.name)))
          renderNew()
          newField.focus()
        })
        li.append(write, remove)
        return li
      }),
    )
  }

  /**
   * Writes to an inbox: its conversation here, if there is one, or the composer addressed to it.
   * A quantum-safe address opens a conversation only once the core has checked the inbox's
   * signature on it: until then anyone's key could sit beside a known inbox's. One
   * that fails goes to the composer, which checks every address and says it doesn't work.
   */
  async function writeTo(address: Uint8Array) {
    closeNew(false)
    const run = opened
    if (box.thread(address).length && (!isQuantumSafe(address) || (await addressWorks(address)))) {
      if (run === opened) openChat(address)
      return
    }
    if (run === opened) deps.writeTo(address.slice())
  }
  const addressWorks = (address: Uint8Array) =>
    deps
      .core()
      .inboxAddress(address)
      .then(
        () => true,
        () => false,
      )

  /**
   * The composer stays as it is, taking either kind: once the box holds
   * an inbox's address, or a name from the address book, a line says which kind it is.
   */
  function renderNewKind() {
    const el = $('ib-new-kind')
    const address = addressFromInput(newField.value) ?? (withBook() ? box.contactNamed(newField.value)?.address : undefined)
    el.hidden = !address
    if (!address) return el.replaceChildren()
    const qs = isQuantumSafe(address)
    if (el.dataset.qs !== String(qs) || !el.firstChild) {
      el.dataset.qs = String(qs)
      el.replaceChildren(markIcon(qs), qs ? copy.KIND_QS : copy.KIND_SECURE)
    }
  }
  newField.addEventListener('input', renderNewKind)

  $('ib-new-go-open').addEventListener('click', () => (newBox.hidden ? openNew() : closeNew()))
  const scanGo = $('ib-new-scan')
  scanGo.setAttribute('aria-label', copy.SCAN_LABEL)
  scanGo.title = copy.SCAN_LABEL
  // A code read goes straight on, as "Write to it" does with a pasted address.
  scanGo.addEventListener('click', () => openScan((address) => writeTo(address)))
  $('ib-new-cancel').addEventListener('click', () => closeNew())
  $('ib-new-go').addEventListener('click', () => {
    const address = addressFromInput(newField.value) ?? (withBook() ? box.contactNamed(newField.value)?.address : undefined)
    const error = $('ib-new-error')
    error.hidden = !!address
    error.textContent = address ? '' : copy.SEND_TO_BAD(withBook() && box.book().length > 0)
    if (!address) return newField.focus()
    writeTo(address)
  })
  newField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ib-new-go').click()
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeNew()
    }
  })

  // --- The list -------------------------------------------------------------------------------

  const fill = fillParts
  const plain = plainParts

  /**
   * Who a sender's inbox is: the owner's name for them, the name they gave
   * (said to be theirs under it, in the conversation), their number, or, for
   * a conversation the owner started, an inbox they wrote to.
   */
  function whoIs(address: Uint8Array): Part[] {
    const mine = box.contactFor(address)
    if (mine) return [{ name: mine.name }]
    const given = box.givenName(address)
    if (given) return [{ name: given }]
    const n = box.sender(address)?.n
    return [n ? copy.FROM_NUMBER(n) : copy.THREAD_TO]
  }

  /** Who a message is from: anonymous, or its sender's inbox; for the owner's own, who it went to ("To Sam"). */
  const who = (i: MailItem): Part[] => (i.from ? whoIs(i.from.address) : i.mine ? toWhom(i.mine.address, copy.ROW_TO) : i.id === WELCOME ? [copy.WELCOME_FROM] : [copy.ROW_FROM])

  /** Who the owner's own message went to: their name for that inbox, the name it gave, its sender number, or just "an inbox". */
  function toWhom(address: Uint8Array, prefix: string): Part[] {
    const named = box.contactFor(address)?.name || box.givenName(address)
    if (named) return [prefix, { name: named }]
    const n = box.sender(address)?.n
    return [prefix + (n ? copy.FROM_NUMBER(n) : copy.TO_AN_INBOX)]
  }

  /**
   * The round picture beside a message or conversation: a figure for an
   * anonymous sender, the first letter of a name (the owner's for them, or
   * the one they gave), or a sender's number. Never anything worked out from
   * their key.
   */
  function paintAvatar(el: HTMLElement, address: Uint8Array | undefined) {
    const name = address ? (box.contactFor(address)?.name ?? box.givenName(address)) : ''
    el.dataset.kind = !address ? 'anonymous' : name ? 'named' : 'number'
    if (!address) {
      el.innerHTML = ANONYMOUS_SVG // fixed markup, nothing from the sender
      return
    }
    const n = box.sender(address)?.n
    if (!name && !n) {
      el.dataset.kind = 'inbox'
      el.innerHTML = INBOX_SVG // fixed markup, nothing from the inbox's address
      return
    }
    el.textContent = name ? firstLetter(name) : String(n)
  }

  /** Whether this message's sender may be someone other than they seem. */
  const careful = (i: MailItem | undefined) => {
    const f = i ? box.nameFlags(i) : {}
    return !!(f.theirs || f.yours)
  }

  /** A short time for a row: "2 hours ago" this week, a date before that. */
  function rowTime(t: number): string {
    const d = new Date(t)
    if (Date.now() - t < 7 * 86400_000) return ago(d)
    const thisYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) })
  }

  /** What a message is called: the owner's title, or what kind it is. */
  const titleOf = (i: MailItem) => i.title || (i.id === WELCOME ? copy.WELCOME_TITLE : i.mine ? copy.ROW_MINE : i.upload || i.off ? copy.DROP_LABEL : copy.ROW_MESSAGE)

  /** The welcome message's picture: the site's coil, so it's never taken for a sender's. */
  function paintSite(el: HTMLElement) {
    el.dataset.kind = 'site'
    el.innerHTML = SITE_SVG // fixed markup
  }

  /** What a row is known by: a message's ID, or "t:" and the conversation's inbox. */
  const rowKey = (r: ListRow) => (r.kind === 'message' ? r.item.id : `t:${r.key}`)

  /** A row, made once and kept while it's in the list: drawn again in place, so a message open in it, and the focus, stay put. */
  function makeRow(r: ListRow): HTMLElement {
    const li = clone('tpl-mail-row')
    const key = rowKey(r)
    li.querySelector('button')!.addEventListener('click', () => tapRow(key))
    fillRow(li, r)
    return li
  }

  /** A row tapped: a one-way message opens in place (or folds), a conversation opens as a chat; while selecting, it's ticked. */
  function tapRow(key: string) {
    if (selecting) return tick(key)
    const r = shownRows.get(key)
    if (r?.kind === 'message') toggleMessage(r.item.id)
    else if (r) openChat(r.address.slice())
  }

  function fillRow(li: HTMLElement, r: ListRow) {
    const unread = r.kind === 'message' ? !r.item.read : r.unread > 0
    li.toggleAttribute('data-unread', unread)
    // A one-way message says whether it's open, as a disclosure does; a conversation opens a screen of its own.
    // While selecting, every row is a tick box.
    const button = li.querySelector('button')!
    const open = r.kind === 'message' && r.item.id === openId
    const ticked = selecting && selected.has(rowKey(r))
    li.toggleAttribute('data-open', open)
    li.toggleAttribute('data-selected', ticked)
    if (selecting) {
      button.setAttribute('role', 'checkbox')
      button.setAttribute('aria-checked', String(ticked))
      button.removeAttribute('aria-expanded')
    } else {
      button.removeAttribute('role')
      button.removeAttribute('aria-checked')
      if (r.kind === 'message') button.setAttribute('aria-expanded', String(open))
    }
    if (open) button.setAttribute('aria-controls', 'ib-open')
    else button.removeAttribute('aria-controls')
    const kind = r.kind === 'thread' ? 'thread' : r.item.mine ? 'out' : 'in'
    const icon = part(li, 'kind')
    icon.innerHTML = KIND_SVG[kind] // fixed markup
    icon.dataset.kind = kind
    icon.title = copy.ROW_KIND[kind]
    icon.append(Object.assign(document.createElement('span'), { className: 'sr-only', textContent: `${copy.ROW_KIND[kind]}: ` }))
    part(li, 'unread').hidden = !unread
    part(li, 'unread').textContent = `${copy.ROW_UNREAD}: `
    const welcome = r.kind === 'message' && r.item.id === WELCOME
    if (r.kind === 'message') {
      part(li, 'title').textContent = titleOf(r.item)
      fill(part(li, 'from'), who(r.item))
      if (welcome) paintSite(part(li, 'avatar'))
      else paintAvatar(part(li, 'avatar'), r.item.mine?.address)
    } else {
      part(li, 'title').textContent = r.unread ? `${copy.THREAD_COUNT(r.count)} · ${copy.BAR_NEW(r.unread)}` : copy.THREAD_COUNT(r.count)
      fill(part(li, 'from'), whoIs(r.address))
      paintAvatar(part(li, 'avatar'), r.address)
    }
    // The welcome has no time: nobody sent it.
    const t = part(li, 'when')
    t.textContent = welcome ? '' : rowTime(r.at)
    t.title = welcome ? '' : new Date(r.at).toLocaleString()
    const bytes = r.kind === 'message' ? (r.item.upload?.size ?? r.item.mine?.upload) : undefined
    part(li, 'size').textContent = bytes !== undefined ? size(bytes) : ''
    part(li, 'size').hidden = bytes === undefined
    // Someone who may not be who they seem; or a reply of the owner's that didn't send.
    const flag = part(li, 'flag')
    const warn = careful(r.kind === 'thread' ? r.latest : undefined) ? copy.ROW_CAREFUL : r.kind === 'thread' && r.failed ? copy.ROW_FAILED : ''
    flag.hidden = !warn
    flag.textContent = warn
    // How it came or went: a padlock, or an atom for quantum-safe; a conversation as their latest message came.
    // The welcome came no way at all.
    if (welcome) part(li, 'mark').replaceChildren()
    else setMarker(part(li, 'mark'), r.kind === 'thread' ? r.qs : !!r.item.qs, 'inbox')
  }

  /** Redraws what's shown: the folder (with a message open in it, if one is) or the open conversation, and the folder bar. */
  function render() {
    renderFolders()
    if (chatWith && !box.thread(chatWith).length) {
      // Emptied (another tab removed it, say): its files go with it.
      closeTray(chatWith)
      chatWith = undefined
    }
    const chatting = !!chatWith
    $('ib-mail').hidden = chatting
    $('ib-chat').hidden = !chatting
    card.dataset.view = chatting ? 'chat' : 'list'
    if (chatting) renderChat()
    else renderList()
    renderNotes()
    // How many messages are held, said in the status line: removing some changes it too.
    status()
  }

  let renderTimer: ReturnType<typeof setTimeout> | undefined
  let renderDue = 0 // when a steady stream of arrivals is drawn anyway
  /** Redraws once a burst of arrivals has settled (or every second during a long one), so a flood stays quick. */
  function renderSoon() {
    clearTimeout(renderTimer)
    if (!renderDue) renderDue = Date.now() + 1000
    renderTimer = setTimeout(
      () => {
        renderDue = 0
        if (info) render()
      },
      Math.max(0, Math.min(120, renderDue - Date.now())),
    )
  }

  /** Rows that arrived since the list was last drawn: they fade in. */
  const fresh = new Set<string>()

  /** Whether an element is on the screen at all (the inbox's screen may not be showing). */
  function onScreen(el: HTMLElement): boolean {
    const r = el.getBoundingClientRect()
    return r.height > 0 && r.bottom > 0 && r.top < (window.visualViewport?.height ?? window.innerHeight)
  }

  /** What each row in the list was last drawn from, by rowKey: what a tap opens. */
  const shownRows = new Map<string, ListRow>()

  function renderList() {
    const items = box.rows(folder)
    // A message stays open only while it's in the folder shown (another tab may have moved it).
    if (openId && !items.some((r) => r.kind === 'message' && r.item.id === openId)) openId = undefined
    // Selecting goes on while there's something to select; what's gone from the folder is unticked.
    if (!items.length) selecting = false
    const keys = new Set(items.map(rowKey))
    for (const k of selected) if (!selecting || !keys.has(k)) selected.delete(k)
    const list = $('ib-list')
    const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement) : undefined
    // The message being read stays where it is on the screen as messages arrive above it.
    const reading = openId ? rows.get(openId) : undefined
    const readingAt = reading && onScreen(reading) ? reading.getBoundingClientRect().top : undefined
    // Rows still here are drawn again where they are; new ones are made, and those gone go (a
    // marker's note open on one goes with it).
    const had = new Map(rows)
    rows.clear()
    shownRows.clear()
    const want = items.map((r) => {
      const key = rowKey(r)
      let li = had.get(key)
      if (li) {
        had.delete(key)
        li.toggleAttribute('data-new', false)
        fillRow(li, r)
      } else {
        li = makeRow(r)
        if (fresh.has(key)) li.toggleAttribute('data-new', true)
      }
      rows.set(key, li)
      shownRows.set(key, r)
      return li
    })
    for (const li of had.values()) {
      closeMarksIn(li)
      li.remove()
    }
    // In order, moving only rows that must move: a row left where it is keeps the focus, and the
    // message open in it whatever is typed there.
    let at = list.firstElementChild
    for (const li of want) {
      if (li === at) at = li.nextElementSibling
      else list.insertBefore(li, at)
    }
    fresh.clear()
    placeOpen()
    if (reading?.isConnected && readingAt !== undefined) {
      const moved = reading.getBoundingClientRect().top - readingAt
      if (moved) window.scrollBy({ top: moved, behavior: 'instant' })
    }
    // A row that had to move takes the focus back with it.
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true })
    list.hidden = !items.length
    list.setAttribute('aria-label', folderName(folder))
    $('ib-select').hidden = !items.length
    renderSelecting()
    // An empty folder says so, rather than leaving a blank where the list goes:
    // Inbox too, from the start, since the status card above says it's still looking back.
    $('ib-empty').hidden = !!items.length
    $('ib-empty').textContent = copy.FOLDER_EMPTY
  }

  function renderNotes() {
    $('ib-more').hidden = !box.overflow
    $('ib-more').textContent = copy.OWNER_MORE(box.overflow)
    $('ib-flood').hidden = box.received + box.overflow < FLOOD_AT
    $('ib-care').hidden = !box.all().some((i) => i.upload)
  }

  function addMessage(n: FoundNotice) {
    const result = box.add(n, INBOX_FILES)
    const i = result === 'added' ? box.get(n.id) : undefined
    if (i) {
      fresh.add(i.from ? `t:${i.from.key}` : i.id)
      // In the conversation on screen, it's seen at once.
      if (i.from && chatWith && i.from.key === inboxKey(chatWith) && deps.onScreen() && document.visibilityState === 'visible') box.setRead(i.id, true)
      renderSoon()
      changed()
      // Only what arrives once the look-back is done is news: before that, it's catching up. A blocked
      // sender's never is.
      if (lookback?.finished && !box.setAside(i)) arrived(i)
    }
    if (result === 'full' || (i && !box.setAside(i))) {
      status()
      // Tells screen readers about a message that arrived after the look-back.
      if (lookback?.finished) $('ib-announce').textContent = copy.OWNER_COUNT(box.received + box.overflow)
    }
  }

  /** A new message: the tab's dot, and a quiet note where it doesn't show. */
  function arrived(i: MailItem) {
    deps.unreadChanged()
    if (i.read) return
    deps.arrived()
    // The list shows it, even with a message open in it; a conversation shows only its own.
    const elsewhere = !!chatWith && i.from?.key !== inboxKey(chatWith)
    if (deps.onScreen() && elsewhere) deps.toast(i.from ? copy.NEW_FROM(isolate(plain(whoIs(i.from.address)))) : copy.NEW_MESSAGE)
  }

  // --- A one-way message, opened in place ------------------------------------------------------
  // An anonymous sender's message or files, the owner's own sent without their inbox, or the
  // welcome: a tap on its row opens it right there, its box grown to hold it and what can be done
  // to it; a tap on the row again, or Escape, folds it. One at a time. Share, Lock, New message and
  // the folders stay in view above it. (A conversation's messages open in its chat.)

  const openBox = $('ib-open')
  const openHome = openBox.parentElement! // where it waits, hidden, while no message is open
  let openShown: string | undefined // the message its text was last drawn for: drawn again only for another

  /** Opens a message in its row, or folds it if it's the one open; the row tapped stays where it is on the screen. */
  function toggleMessage(id: string) {
    if (!box.get(id)) return
    const row = rows.get(id)?.querySelector('button')
    const top = row?.getBoundingClientRect().top
    closeMarks()
    dropGhosts()
    const opening = openId !== id
    const closing = !opening ? shrinking() : undefined
    openId = opening ? id : undefined
    if (opening && box.setRead(id, true)) changed()
    closeOpenForms()
    render()
    if (row && top !== undefined) keepInPlace(row, top, opening)
    if (opening) grow()
    else closing?.()
  }

  // A little motion: the box grows open with its words fading
  // in, and shrinks away as it folds, the row tapped staying put; none for a device that asks for less.
  const OPEN_MS = 220
  const OPEN_EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
  const lessMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  /** Any copy still shrinking away goes at once: a row tapped again mid-fold opens cleanly. */
  function dropGhosts() {
    for (const ghost of $('ib-list').querySelectorAll('.mail-open:not(#ib-open)')) ghost.remove()
    for (const li of $('ib-list').querySelectorAll('.mail-item.closing')) li.classList.remove('closing')
  }

  /** The open message's box grows into place (it has its full height now, which the scrolling went by). */
  function grow() {
    if (lessMotion() || openBox.hidden) return
    const height = openBox.getBoundingClientRect().height
    openBox.classList.add('moving')
    openBox
      .animate([{ height: '0px', opacity: 0 }, { height: `${height}px`, opacity: 1 }], { duration: OPEN_MS, easing: OPEN_EASE })
      .finished.catch(() => {})
      .finally(() => openBox.classList.remove('moving'))
  }

  /**
   * Before the open message folds: a copy of its box, to shrink away in its row once the real one
   * has gone home (it's the one box, moved from row to row). Call what it gives after drawing.
   */
  function shrinking(): (() => void) | undefined {
    const li = openId ? rows.get(openId) : undefined
    if (lessMotion() || !li || openBox.hidden) return undefined
    const height = openBox.getBoundingClientRect().height
    const ghost = openBox.cloneNode(true) as HTMLElement
    for (const el of [ghost, ...ghost.querySelectorAll('[id]')]) el.removeAttribute('id')
    ghost.inert = true
    ghost.setAttribute('aria-hidden', 'true')
    ghost.classList.add('moving')
    return () => {
      if (!li.isConnected) return
      li.append(ghost)
      li.classList.add('closing')
      ghost
        .animate([{ height: `${height}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: OPEN_MS, easing: OPEN_EASE })
        .finished.catch(() => {})
        .finally(() => {
          ghost.remove()
          li.classList.remove('closing')
        })
    }
  }

  /** How much of a message opened past the bottom of the screen is brought into sight: its start. */
  const START_SHOWN = 160

  /**
   * No jumping about on a phone: the row tapped stays where it was on the screen,
   * whatever folded above it, and a message opened past the bottom of the screen comes up only
   * enough to show its start, never taking its row off the top.
   */
  function keepInPlace(row: HTMLElement, top: number, opened: boolean) {
    const moved = row.getBoundingClientRect().top - top
    if (moved) window.scrollBy({ top: moved, behavior: 'instant' })
    if (!opened) return
    const screen = window.visualViewport?.height ?? window.innerHeight
    const shown = openBox.getBoundingClientRect()
    const up = Math.min(shown.top + Math.min(shown.height, START_SHOWN) + 12 - screen, row.getBoundingClientRect().top - 8)
    if (up > 0) window.scrollBy({ top: up, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }

  /** Folds the open message, with the focus on its row, which stays where it is. toast: what was done to it. */
  function fold(toast?: string) {
    const id = openId
    if (!id) return
    const row = rows.get(id)?.querySelector('button')
    const top = row?.getBoundingClientRect().top
    dropGhosts()
    const closing = shrinking()
    openId = undefined
    closeOpenForms()
    render()
    if (row && top !== undefined) keepInPlace(row, top, false)
    closing?.()
    if (toast) deps.toast(toast)
    row?.focus({ preventScroll: true })
  }

  /**
   * The open message has left the folder (archived, moved or removed): the focus goes to the row
   * that takes its place, or to the one before it if it was the last, or else to the folder's button.
   */
  function gone(id: string, toast: string) {
    const keys = [...rows.keys()]
    const at = keys.indexOf(id)
    openId = undefined
    closeOpenForms()
    render()
    deps.toast(toast)
    const next = keys.slice(at + 1).find((k) => rows.has(k)) ?? keys.slice(0, Math.max(at, 0)).reverse().find((k) => rows.has(k))
    ;(next ? rows.get(next)!.querySelector('button') : folderButton())?.focus({ preventScroll: true })
  }

  function closeOpenForms() {
    $('ib-r-title-box').hidden = true
    $('ib-r-remove-ask').hidden = true
    showSentTo(false)
  }

  /** The inbox the owner's own message went to, in full, as the composer shows it ("Show its full address"). */
  function showSentTo(show: boolean) {
    $('ib-r-address').hidden = !show
    $('ib-r-address-go').setAttribute('aria-expanded', String(show))
  }
  $('ib-r-address-go').addEventListener('click', () => showSentTo($('ib-r-address').hidden === true))

  /** The open message's box, in its row (drawn afresh for another message), or home, hidden, while none is open. */
  function placeOpen() {
    const li = openId ? rows.get(openId) : undefined
    if (!li) {
      if (openBox.parentElement !== openHome) openHome.append(openBox)
      openBox.hidden = true
      openShown = undefined
      return
    }
    if (openBox.parentElement !== li) li.append(openBox)
    openBox.hidden = false
    renderOpen()
  }

  function renderOpen() {
    const i = box.get(openId!)!
    const welcome = i.id === WELCOME
    const body = $('ib-r-body')
    // Who it's from, when, and how it came are on its row, just above.
    if (openShown !== i.id) {
      openShown = i.id
      closeMenus()
      if (welcome) {
        const text = Object.assign(document.createElement('div'), { className: 'mail-text welcome-text' })
        text.append(...copy.WELCOME_BODY.map(welcomeLine))
        body.replaceChildren(text)
      } else if (i.mine) {
        // The owner's own: what they wrote and the files' names, then that it didn't say who it was
        // from, with a way to write to them again (their conversation, if there
        // is one, or the composer addressed to them, as New message does).
        const parts: HTMLElement[] = []
        if (i.body.length || i.mine.upload === undefined) {
          const pre = document.createElement('pre')
          pre.className = 'mail-text'
          pre.append(linkedText(shownText(i.body), 'inbox'))
          parts.push(pre)
        }
        if (i.mine.files?.length) parts.push(sentFiles(i.mine.files))
        const note = Object.assign(document.createElement('p'), { className: 'note mine-note', textContent: `${copy.MINE_NOTE} ` })
        const again = Object.assign(document.createElement('button'), { type: 'button', className: 'soft-link', textContent: copy.MINE_WRITE_AGAIN })
        const to = i.mine.address
        again.addEventListener('click', () => void writeTo(to))
        note.append(again)
        parts.push(note)
        body.replaceChildren(...parts)
      } else if (i.upload) {
        body.replaceChildren(dropFor(i).el)
      } else if (i.off) {
        body.replaceChildren(offNote())
      } else {
        const pre = document.createElement('pre')
        pre.className = 'mail-text'
        pre.append(isText(i) ? linkedText(shownText(i.body), 'inbox') : copy.MESSAGE_UNREADABLE)
        body.replaceChildren(pre)
      }
    }
    if (i.upload) renderDrop(dropFor(i))
    $('ib-r-copy').hidden = welcome || !isText(i) || (!!i.mine && !i.body.length)
    // Nowhere to reply to: say why, in a popup. Not on the owner's own, which can
    // show the inbox it went to instead, to check later, nor on the welcome, which nobody sent.
    $('ib-r-why').hidden = welcome || !!i.from || !!i.mine
    $('ib-r-address-go').hidden = !i.mine
    $('ib-r-address').textContent = i.mine ? inboxLink(LINK_ORIGIN, i.mine.address) : ''
    if (!i.mine) showSentTo(false)
    $('ib-r-extra').hidden = $('ib-r-why').hidden && $('ib-r-address-go').hidden
    $('ib-r-archive').textContent = i.folder === ARCHIVE ? copy.READ_TO_INBOX : copy.READ_ARCHIVE
    // Only a tab that saves can promise a removal sticks.
    $('ib-r-remove-text').textContent = welcome ? copy.WELCOME_REMOVE_ASK(keeping) : i.mine ? copy.MINE_REMOVE_ASK(keeping) : copy.REMOVE_ASK(keeping)
  }

  /** A line of the welcome message, with the padlock and the atom it names shown after their names, as on the screens. */
  function welcomeLine(text: string): HTMLElement {
    const p = document.createElement('p')
    for (const bit of text.split(/(a padlock|an atom)/)) {
      p.append(bit)
      if (bit === 'a padlock' || bit === 'an atom') p.append(' ', markIcon(bit === 'an atom'))
    }
    return p
  }

  /** An upload this site doesn't collect (INBOX_FILES off), and why. */
  function offNote(): HTMLElement {
    const note = Object.assign(document.createElement('p'), { className: 'note drop-off', textContent: `${copy.DROP_OFF} ` })
    const why = Object.assign(document.createElement('a'), { href: copy.MESSAGES_ONLY_HREF, target: '_blank', rel: 'noopener', textContent: copy.MESSAGES_ONLY_WHY })
    note.append(why)
    return note
  }

  const isText = (i: MailItem) => !i.upload && !i.off && i.kind === NOTICE_TEXT

  /** A message's text as shown, or that it's empty: nothing visible in it (spaces, or control characters) never shows as a blank. */
  function shownText(body: Uint8Array): string {
    const text = new TextDecoder().decode(body)
    // Blank-looking too: fillers (Hangul's, Braille's), variation selectors and other characters a
    // font draws as nothing, and marks with nothing to sit on.
    return /[^\s\p{Cc}\p{Cf}\p{M}\p{Default_Ignorable_Code_Point}\u2800\u3164\uFFA0]/u.test(text) ? text : copy.MESSAGE_EMPTY
  }

  // The message's own menu (More): what's done to a message less often.
  attachMenu($<HTMLButtonElement>('ib-r-more'), $('ib-r-more-menu'), () => {
    const i = openId ? box.get(openId) : undefined
    if (!i) return []
    const items: MenuItem[] = [...(i.mine ? [] : [{ label: copy.READ_UNREAD, run: markUnread }]), { label: i.title ? copy.READ_RETITLE : copy.READ_TITLE, run: openTitle }]
    // Folders it could go to, but for the one the Archive button already takes it to.
    const button = i.folder === ARCHIVE ? INBOX : ARCHIVE
    const to = box.folders().filter((f) => f.id !== i.folder && f.id !== button)
    if (to.length) items.push({ label: copy.READ_MOVE_HEADING, heading: true }, ...to.map((f) => ({ label: folderName(f.id), aria: copy.MOVED_TO_LABEL(folderName(f.id)), run: () => moveOpen(f.id) })))
    items.push({ label: copy.READ_REMOVE(keeping), danger: true, run: askRemove })
    return items
  })
  $('ib-r-more').setAttribute('aria-label', copy.READ_MORE)

  const why = $<HTMLDialogElement>('why-reply')
  $('ib-r-why').addEventListener('click', () => {
    why.showModal()
    // The title takes the focus, not the close button: Safari rings a button focused on opening.
    $('why-reply-title').focus()
  })
  why.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => why.close()))
  why.addEventListener('click', (e) => {
    if (e.target === why) why.close() // click on the backdrop
  })
  // Escape folds the open message, from its row or anything in it but a box being typed in, or a
  // marker's note (each closes on its own).
  $('ib-list').addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement
    if (e.key !== 'Escape' || !openId || t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t.closest('.mail-mark')) return
    if (rows.get(openId)?.contains(t)) fold()
  })
  function copyOpen() {
    const i = openId ? box.get(openId) : undefined
    if (i && isText(i)) void copyText(new TextDecoder().decode(i.body), 'Copied', deps.toast)
  }
  $('ib-r-copy').addEventListener('click', copyOpen)
  $('ib-r-close').addEventListener('click', () => fold())
  function markUnread() {
    if (!openId) return
    if (box.setRead(openId, false)) changed()
    fold(copy.MARKED_UNREAD)
  }
  $('ib-r-archive').addEventListener('click', () => {
    const i = openId ? box.get(openId) : undefined
    if (!i) return
    const to = i.folder === ARCHIVE ? INBOX : ARCHIVE
    if (box.move(i.id, to)) changed()
    gone(i.id, to === ARCHIVE ? copy.ARCHIVED : copy.MOVED(folderName(to)))
  })
  function moveOpen(to: string) {
    const id = openId
    if (!id) return
    if (box.move(id, to)) changed()
    gone(id, copy.MOVED(folderName(to)))
  }

  const titleField = $<HTMLInputElement>('ib-r-title-field')
  titleField.maxLength = MAX_TITLE * 2
  function openTitle() {
    const i = openId ? box.get(openId) : undefined
    if (!i) return
    closeOpenForms()
    titleField.value = i.title
    $('ib-r-title-box').hidden = false
    titleField.focus()
  }
  $('ib-r-title-save').addEventListener('click', () => {
    const id = openId
    if (!id) return
    if (box.setTitle(id, titleField.value)) changed()
    $('ib-r-title-box').hidden = true
    render()
    // Its row, which now says it.
    rows.get(id)?.querySelector('button')?.focus({ preventScroll: true })
  })
  titleField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ib-r-title-save').click()
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-r-title-box').hidden = true
      $('ib-r-more').focus()
    }
  })

  function askRemove() {
    closeOpenForms()
    $('ib-r-remove-ask').hidden = false
    $('ib-r-remove-no').focus()
  }
  $('ib-r-remove-no').addEventListener('click', () => {
    $('ib-r-remove-ask').hidden = true
    $('ib-r-more').focus()
  })
  $('ib-r-remove-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-r-remove-no').click()
    }
  })
  $('ib-r-remove-yes').addEventListener('click', () => {
    const id = openId
    if (!id) return
    if (!removeItem(id)) return
    changed()
    gone(id, copy.REMOVED)
  })

  /** Removes a message for good, and anything collected of it. False while it's being collected. */
  function removeItem(id: string): boolean {
    const d = drops.get(id)
    if (d) {
      if (collecting === d) {
        deps.toast(copy.DROP_ONE_AT_A_TIME)
        return false
      }
      wipeDrop(d)
      drops.delete(id)
    }
    box.remove(id)
    return true
  }

  // --- Selecting several at once ----------------------------------------------------------------
  // "Select", by the folders, puts a tick box on every row, conversations too, and a tap ticks a
  // row rather than opening it. A bar under the list, at the foot of the screen while the list
  // scrolls, archives, moves, marks or removes what's ticked, asking once before removing the lot.

  const selectGo = $<HTMLButtonElement>('ib-select')
  const selBar = $('ib-select-bar')

  /** Selecting starts (a message open folds), or stops, with the focus back on Select (or the folder's button, if the folder is now empty). */
  function setSelecting(on: boolean, refocus = true) {
    selecting = on
    selected.clear()
    if (on) {
      openId = undefined
      closeOpenForms()
    }
    $('ib-sel-remove-ask').hidden = true
    render()
    if (!on && refocus) (selectGo.hidden ? folderButton() : selectGo)?.focus({ preventScroll: true })
  }
  selectGo.addEventListener('click', () => setSelecting(!selecting))
  $('ib-sel-cancel').addEventListener('click', () => setSelecting(false))

  /** A row ticked, or unticked. */
  function tick(key: string) {
    const r = shownRows.get(key)
    if (!r) return
    if (!selected.delete(key)) selected.add(key)
    $('ib-sel-remove-ask').hidden = true
    fillRow(rows.get(key)!, r)
    renderSelecting()
  }

  $('ib-sel-all').addEventListener('click', () => {
    const all = selected.size === shownRows.size
    selected.clear()
    if (!all) for (const key of shownRows.keys()) selected.add(key)
    $('ib-sel-remove-ask').hidden = true
    render()
  })

  /** What's ticked, in the list's order. */
  const ticked = () => [...shownRows.values()].filter((r) => selected.has(rowKey(r)))
  /** How many messages and conversations, said plainly. */
  const counted = (picked: ListRow[]) => copy.COUNT_TICKED(picked.filter((r) => r.kind === 'message').length, picked.filter((r) => r.kind === 'thread').length)
  /** Read and unread are for what came in: not the owner's own one-way messages, nor a conversation with nothing from them. */
  const markable = (r: ListRow) => (r.kind === 'message' ? !r.item.mine : !!r.latest)
  const unreadRow = (r: ListRow) => (r.kind === 'message' ? !r.item.read : r.unread > 0)
  /** Folders what's ticked can go to: all but this one, and the one the Archive button takes it to. */
  const moveTargets = () => box.folders().filter((f) => f.id !== folder && f.id !== (folder === ARCHIVE ? INBOX : ARCHIVE))

  /** The tick boxes' look, Select's state, and the bar. */
  function renderSelecting() {
    selectGo.setAttribute('aria-pressed', String(selecting))
    $('ib-list').toggleAttribute('data-selecting', selecting)
    selBar.hidden = !selecting
    if (!selecting) return
    const picked = ticked()
    $('ib-sel-count').textContent = copy.SELECTED(picked.length)
    $('ib-sel-all').textContent = picked.length && picked.length === shownRows.size ? copy.SELECT_NONE : copy.SELECT_ALL
    const archive = $<HTMLButtonElement>('ib-sel-archive')
    archive.textContent = folder === ARCHIVE ? copy.READ_TO_INBOX : copy.READ_ARCHIVE
    const read = $<HTMLButtonElement>('ib-sel-read')
    read.textContent = picked.filter(markable).some(unreadRow) ? copy.SELECT_READ : copy.READ_UNREAD
    read.disabled = !picked.some(markable)
    for (const b of [archive, $<HTMLButtonElement>('ib-sel-move'), $<HTMLButtonElement>('ib-sel-remove')]) b.disabled = !picked.length
    $('ib-sel-move-wrap').hidden = !moveTargets().length
    if (!picked.length) $('ib-sel-remove-ask').hidden = true
  }

  /** Done with what was ticked: selecting stops, and the toast says what happened. */
  function doneSelecting(toast: string) {
    setSelecting(false)
    deps.toast(toast)
  }

  function moveTicked(to: string) {
    const picked = ticked()
    if (!picked.length) return
    let moved = false
    for (const r of picked) if (r.kind === 'message' ? box.move(r.item.id, to) : box.moveThread(r.address, to)) moved = true
    if (moved) changed()
    doneSelecting(to === ARCHIVE ? copy.MANY_ARCHIVED(counted(picked)) : copy.MANY_MOVED(counted(picked), folderName(to)))
  }
  $('ib-sel-archive').addEventListener('click', () => moveTicked(folder === ARCHIVE ? INBOX : ARCHIVE))
  attachMenu($<HTMLButtonElement>('ib-sel-move'), $('ib-sel-move-menu'), () =>
    moveTargets().map((f) => ({ label: folderName(f.id), aria: copy.MOVED_TO_LABEL(folderName(f.id)), run: () => moveTicked(f.id) })),
  )

  $('ib-sel-read').addEventListener('click', () => {
    const picked = ticked().filter(markable)
    if (!picked.length) return
    const read = picked.some(unreadRow)
    let marked = false
    for (const r of picked) if (r.kind === 'message' ? box.setRead(r.item.id, read) : box.readThread(r.address, read)) marked = true
    if (marked) changed()
    doneSelecting(copy.MANY_MARKED(counted(picked), read))
  })

  /** The question before removing what's ticked: one alone as it would be asked on its own, several at once as honestly. */
  function removeTickedAsk(picked: ListRow[]): string {
    if (picked.length === 1) {
      const r = picked[0]
      if (r.kind === 'thread') return copy.CHAT_REMOVE_ASK(keeping)
      return r.item.id === WELCOME ? copy.WELCOME_REMOVE_ASK(keeping) : r.item.mine ? copy.MINE_REMOVE_ASK(keeping) : copy.REMOVE_ASK(keeping)
    }
    return copy.REMOVE_MANY_ASK(counted(picked), {
      kept: keeping,
      received: picked.some((r) => (r.kind === 'thread' ? !!r.latest : !r.item.mine && r.item.id !== WELCOME)),
      own: picked.some((r) => (r.kind === 'thread' ? box.thread(r.address).some((e) => e.kind === 'out') : !!r.item.mine)),
      welcome: picked.some((r) => r.kind === 'message' && r.item.id === WELCOME),
    })
  }

  $('ib-sel-remove').addEventListener('click', () => {
    const picked = ticked()
    if (!picked.length) return
    const one = picked.length === 1
    $('ib-sel-remove-text').textContent = removeTickedAsk(picked)
    $('ib-sel-remove-yes').textContent = one ? copy.REMOVE_YES : copy.REMOVE_MANY_YES
    $('ib-sel-remove-no').textContent = one ? copy.REMOVE_NO : copy.REMOVE_MANY_NO
    $('ib-sel-remove-ask').hidden = false
    $('ib-sel-remove-no').focus()
  })
  $('ib-sel-remove-no').addEventListener('click', () => {
    $('ib-sel-remove-ask').hidden = true
    $('ib-sel-remove').focus()
  })
  $('ib-sel-remove-yes').addEventListener('click', () => {
    const picked = ticked()
    if (!picked.length) return
    // None of it goes while any of it is busy: something being collected, or a reply on its way.
    for (const r of picked) {
      const busy = r.kind === 'thread' ? threadBusy(r.address) : collecting && collecting === drops.get(r.item.id) ? copy.DROP_ONE_AT_A_TIME : ''
      if (busy) return deps.toast(busy)
    }
    for (const r of picked) {
      if (r.kind === 'message') removeItem(r.item.id)
      else removeThreadNow(r.address)
    }
    changed()
    doneSelecting(copy.MANY_REMOVED(counted(picked)))
  })

  // Escape: the question first, then selecting itself (from the list or the bar).
  selBar.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    if (!$('ib-sel-remove-ask').hidden) $('ib-sel-remove-no').click()
    else setSelecting(false)
  })
  $('ib-list').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && selecting && !(e.target as HTMLElement).closest('.mail-mark')) setSelecting(false)
  })

  // --- A conversation, as a chat ---------------------------------------------------------------
  // Everything from one sender's inbox and everything the owner sent it, oldest
  // first, with the reply box underneath: their messages on one side, the
  // owner's on the other, a time on each and the day between them.

  const log = $('ib-c-log')
  const chatText = $<HTMLTextAreaElement>('ib-c-text')
  chatText.placeholder = copy.CHAT_PLACEHOLDER
  const drafts = new Map<string, string>() // what the owner started writing to each, until Lock
  const stages = new Map<string, string>() // a message being sent: how far it has got
  const unconfirmed = new Set<string>() // sent, but the network didn't confirm it arrived
  const stopped = new Set<string>() // the owner stopped it on its way
  let stopping: string | undefined // the reply "Stop sending?" is asking about
  let stickToEnd = false // the next drawing shows the newest message
  let sendingNow = 0
  let queue: Promise<void> = Promise.resolve()
  let going: string | undefined // the reply going out now; the rest wait their turn
  const stateEls = new Map<string, HTMLElement>() // a message being sent: its state line, kept up to date in place
  // Files, or a reply too long for one message (INBOX_FILES).
  const outgoing = new Map<string, Outgoing>() // what's on its way, by the owner's message
  const trays = new Map<string, ChatTray>() // each conversation's files, until Lock
  let chatMsg: (Text & { text: string }) | undefined // the reply box's text, packed for an upload
  let packingUpload = false
  let honestDone = false // the honest line about uploads has been shown, until a first upload: once a visit

  function openChat(address: Uint8Array) {
    closeHeadPanels()
    saveDraft()
    // Written to at its quantum-safe address whenever the owner has that.
    chatWith = box.bestAddress(address).slice()
    openId = undefined
    closeOpenForms()
    if (box.readThread(address)) changed()
    closeChatForms()
    chatText.value = drafts.get(inboxKey(address)) ?? ''
    chatMsg = undefined
    if (uploadMode()) void packChatText()
    stickToEnd = true
    render()
    growText()
    deps.chatOpened(inboxKey(address))
    // The newest messages and the reply box come into sight (on a phone they were below the screen).
    $('ib-c-form').scrollIntoView({ block: 'end', behavior: 'auto' })
    $('ib-c-name').focus({ preventScroll: true })
  }

  function saveDraft() {
    if (!chatWith) return
    if (chatText.value) drafts.set(inboxKey(chatWith), chatText.value)
    else drafts.delete(inboxKey(chatWith))
  }

  function closeChatForms() {
    removing = undefined
    stopping = undefined
    $('ib-c-name-box').hidden = true
    $('ib-c-remove-ask').hidden = true
    $('ib-c-block-ask').hidden = true
    $('ib-c-stop-ask').hidden = true
    $('ib-c-as-box').hidden = true
    $('ib-c-as-go').setAttribute('aria-expanded', 'false')
  }

  /** Back to the folder, with the focus on the conversation's row. fromHistory: Back did it, so there's no step to take back. */
  function closeChat(toast?: string, fromHistory = false) {
    if (!chatWith) return
    saveDraft()
    const key = `t:${inboxKey(chatWith)}`
    chatWith = undefined
    closeChatForms()
    if (!fromHistory) deps.chatClosed()
    render()
    if (toast) deps.toast(toast)
    ;(rows.get(key)?.querySelector('button') ?? folderButton())?.focus()
  }
  $('ib-c-back').addEventListener('click', () => closeChat())
  $('ib-chat').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) closeChat()
  })

  const timeOf = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  /** "Today", "Yesterday", or the date. */
  function dayOf(t: number): string {
    const d = new Date(t)
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
    const days = Math.round((start(new Date()) - start(d)) / 86400_000)
    if (days === 0) return copy.CHAT_TODAY
    if (days === 1) return copy.CHAT_YESTERDAY
    const thisYear = d.getFullYear() === new Date().getFullYear()
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) })
  }

  /** What the open conversation's log was last drawn from: redrawn only when it changes, so menus and focus stay put. */
  let chatShown = ''

  function renderChat() {
    const address = chatWith!
    // Blocked: said at the top, and no replying until they're unblocked.
    const isBlocked = box.isBlocked(address)
    $('ib-c-blocked').hidden = !isBlocked
    $('ib-c-form').hidden = isBlocked
    // On screen, what's in it has been seen (it may have arrived while the owner was elsewhere).
    if (deps.onScreen() && document.visibilityState === 'visible' && box.readThread(address)) changed()
    const entries = box.thread(address)
    const ins = entries.filter((e): e is Extract<ThreadEntry, { kind: 'in' }> => e.kind === 'in')
    paintAvatar($('ib-c-avatar'), address)
    fill($('ib-c-name'), whoIs(address))
    // The conversation's marker, as its row has it: their latest message's.
    setMarker($('ib-c-mark'), box.threadQs(address), 'inbox')
    // The name they gave, said underneath (on a phone, "(the name they gave)" beside it broke the line).
    $('ib-c-sub').hidden = !!box.contactFor(address) || !box.givenName(address)
    $('ib-c-sub').textContent = copy.CHAT_GIVEN
    $('ib-c-back').setAttribute('aria-label', copy.CHAT_BACK(folderName(folder)))
    $('ib-c-more').setAttribute('aria-label', copy.CHAT_MORE)
    renderChatFlags(ins[ins.length - 1]?.item)
    log.setAttribute('aria-label', copy.CHAT_LOG(plain(whoIs(address))))
    // Showing the newest, it carries on showing the newest as messages arrive.
    const form = $('ib-c-form')
    const atEnd = stickToEnd || (!form.hidden && form.getBoundingClientRect().bottom <= window.innerHeight + 64)
    stickToEnd = false
    // Nothing in this conversation changed (a message arrived for someone else): leave it be.
    const shown = [
      inboxKey(address),
      plain(whoIs(address)),
      keeping,
      ...entries.map((e) => (e.kind === 'in' ? `${e.item.id}${e.item.from?.name}` : `${e.sent.id}${e.sent.state}${stages.get(e.sent.id) ?? ''}${unconfirmed.has(e.sent.id)}${going === e.sent.id}${!!outgoing.get(e.sent.id)?.v1}`)),
    ].join('|')
    if (shown === chatShown) {
      renderChatCompose()
      if (atEnd && deps.onScreen()) form.scrollIntoView({ block: 'end', behavior: 'auto' })
      return
    }
    chatShown = shown
    closeMenus()
    closeMarksIn(log)
    // The focus, if it was in the log, goes back to the same place in the same message.
    const was = document.activeElement instanceof HTMLElement && log.contains(document.activeElement) ? document.activeElement : undefined
    const wasKey = was?.closest<HTMLElement>('[data-key]')?.dataset.key
    const wasRole = was?.dataset.role
    const parts: HTMLElement[] = []
    stateEls.clear()
    // Replies stay on the device they went from: where there are none, say so (only where it matters).
    if (ins.length >= 2 && ins.length === entries.length) {
      const li = document.createElement('li')
      li.className = 'chat-note chat-elsewhere'
      li.textContent = copy.CHAT_ELSEWHERE
      parts.push(li)
    }
    let day = ''
    let cared = false
    for (const e of entries) {
      const d = dayOf(e.at)
      if (d !== day) {
        day = d
        const li = document.createElement('li')
        li.className = 'chat-day'
        li.textContent = d
        parts.push(li)
      }
      // A change of name, said where it happened.
      const was = e.kind === 'in' && e.item.from?.name ? box.nameFlags(e.item).was : undefined
      if (was && e.kind === 'in') {
        const li = document.createElement('li')
        li.className = 'chat-note'
        fill(li, copy.FLAG_WAS(e.item.from!.name, was))
        parts.push(li)
      }
      // Above the first files they sent: open them with care (once in the conversation).
      if (e.kind === 'in' && e.item.upload && !cared) {
        cared = true
        parts.push(Object.assign(document.createElement('li'), { className: 'chat-note', textContent: copy.DROP_CARE }))
      }
      parts.push(bubble(e))
    }
    log.replaceChildren(...parts)
    // Focus inside files being collected stays put: that part is the same one, moved into the new bubble.
    if (was?.isConnected) was.focus({ preventScroll: true })
    else if (wasKey) (log.querySelector<HTMLElement>(`[data-key="${CSS.escape(wasKey)}"] [data-role="${wasRole}"]`) ?? $('ib-c-name')).focus({ preventScroll: true })
    renderChatCompose()
    if (atEnd && deps.onScreen()) form.scrollIntoView({ block: 'end', behavior: 'auto' })
  }

  /** What to be careful of with this sender, above the conversation. */
  function renderChatFlags(latest: MailItem | undefined) {
    const flags = latest ? box.nameFlags(latest) : {}
    const notes: Part[][] = []
    if (flags.yours) notes.push(copy.FLAG_YOURS(flags.yours))
    else if (flags.theirs) notes.push(copy.FLAG_THEIRS(flags.theirs))
    if (flags.copied) notes.push(copy.FLAG_COPIED(flags.copied))
    const list = $('ib-c-flags')
    list.replaceChildren(
      ...notes.map((n, at) => {
        const li = document.createElement('li')
        // The warnings that someone may not be who they seem stand out.
        if ((flags.yours || flags.theirs) && at === 0) li.className = 'name-flag-careful'
        fill(li, n)
        return li
      }),
    )
    list.hidden = !notes.length
  }

  /** One message in the chat: theirs or the owner's, with its time and, for the owner's, how sending went. */
  function bubble(e: ThreadEntry): HTMLElement {
    const li = document.createElement('li')
    li.className = `bubble ${e.kind}`
    li.dataset.key = e.kind === 'in' ? e.item.id : e.sent.id
    const sr = Object.assign(document.createElement('span'), { className: 'sr-only', textContent: `${e.kind === 'out' ? copy.CHAT_FROM_YOU : plain(whoIs(chatWith!))}: ` })
    const body = document.createElement('div')
    body.className = 'bubble-text'
    const meta = document.createElement('div')
    meta.className = 'bubble-meta'
    const time = document.createElement('time')
    time.dateTime = new Date(e.at).toISOString()
    time.title = new Date(e.at).toLocaleString()
    time.textContent = timeOf(e.at)
    meta.append(time)
    // How it came, or how the owner's went, once it has.
    if (e.kind === 'in') meta.append(marker(!!e.item.qs, 'inbox'))
    else if (e.sent.state === 'sent') meta.append(marker(sentQs(e.sent), 'inbox'))
    let text = ''
    if (e.kind === 'in') {
      const i = e.item
      if (i.upload || i.off) {
        li.classList.add('bubble-drop')
        if (i.off) body.append(offNote())
        else {
          // Collected right here: Collect, then the message and the files, each with Save.
          const d = dropFor(i)
          renderDrop(d)
          body.append(d.el)
        }
      } else {
        text = isText(i) ? new TextDecoder().decode(i.body) : ''
        body.append(isText(i) ? linkedText(shownText(i.body), 'inbox') : copy.MESSAGE_UNREADABLE)
        if (!text) li.classList.add('bubble-unreadable')
      }
    } else {
      const x = e.sent
      text = new TextDecoder().decode(x.body)
      if (x.upload !== undefined) {
        // Files or a longer message: its text and the files' names and sizes (older records kept neither).
        li.classList.add('bubble-upload')
        if (text) {
          const msg = Object.assign(document.createElement('div'), { className: 'bubble-msg' })
          msg.append(linkedText(text, 'inbox'))
          body.append(msg)
        }
        if (x.files?.length) body.append(sentFiles(x.files))
        if (!text && !x.files?.length) body.textContent = copy.CHAT_SENT_DROP(size(x.upload))
      } else body.append(linkedText(shownText(x.body), 'inbox'))
      const state = document.createElement('span')
      state.className = 'bubble-state'
      state.dataset.state = x.state
      state.textContent = stateText(x)
      if (x.state === 'sending' && x.upload !== undefined && outgoing.has(x.id)) {
        // Files on their way: Cancel at the line's end, which stays put as the words change.
        const words = Object.assign(document.createElement('span'), { textContent: stateText(x) })
        const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: copy.CHAT_CANCEL })
        cancel.dataset.role = 'cancel'
        cancel.addEventListener('click', () => askStop(x.id))
        state.replaceChildren(words, ' · ', cancel)
        stateEls.set(x.id, words)
      } else if (x.state === 'sending') stateEls.set(x.id, state)
      else if (x.state === 'failed') {
        const retry = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: copy.CHAT_RETRY })
        retry.dataset.role = 'retry'
        retry.addEventListener('click', () => retrySent(x.id))
        const drop = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: copy.CHAT_DISCARD })
        drop.dataset.role = 'discard'
        drop.addEventListener('click', () => {
          box.removeSent(x.id)
          forgetOutgoing(x.id)
          unconfirmed.delete(x.id)
          stopped.delete(x.id)
          render()
          chatText.focus()
        })
        state.append(' ', retry, ' · ', drop)
      }
      meta.append(state)
    }
    li.append(sr, body, meta)
    // Copy and Remove, out of the way: a small menu on each message. The menu
    // opens from the message's inner edge, so it stays on a phone's screen.
    const wrap = document.createElement('span')
    wrap.className = 'bubble-more'
    const more = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-btn small' })
    more.innerHTML = MORE_SVG // fixed markup
    more.dataset.role = 'more'
    more.setAttribute('aria-label', copy.CHAT_MESSAGE_MORE(e.kind === 'out' ? copy.CHAT_FROM_YOU : plain(whoIs(chatWith!)), timeOf(e.at)))
    const panel = document.createElement('div')
    panel.className = 'menu'
    wrap.append(more)
    attachMenu(more, panel, () => {
      const items: MenuItem[] = []
      // Files they sent: the message in them, once collected.
      const words = text || (e.kind === 'in' ? collectedText(e.item.id) : '')
      if (words) items.push({ label: copy.CHAT_COPY, run: () => void copyText(words, 'Copied', deps.toast) })
      if (e.kind === 'in') items.push({ label: copy.READ_REMOVE(keeping), danger: true, run: () => askRemoveFromChat({ in: e.item.id }) })
      else if (e.sent.state !== 'sending') items.push({ label: copy.READ_REMOVE(keeping), danger: true, run: () => askRemoveFromChat({ out: e.sent.id }) })
      return items
    })
    li.append(wrap, panel)
    return li
  }

  // The conversation's menu: naming them, filing it, removing it.
  attachMenu($<HTMLButtonElement>('ib-c-more'), $('ib-c-more-menu'), () => {
    const address = chatWith
    if (!address) return []
    const items: MenuItem[] = []
    const mine = box.contactFor(address)
    const given = box.givenName(address)
    if (withBook()) {
      // Never a name that looks like someone else's: judged on the name it would save.
      const clash = given ? box.nameClash(address, given) : {}
      if (!mine && given && !clash.theirs && !clash.yours) items.push({ label: copy.READ_USE_NAME_AS(given), run: useName })
      items.push({ label: mine ? copy.READ_RENAME : copy.READ_NAME, run: openNameBox })
    }
    if (box.thread(address).some((e) => e.kind === 'in')) items.push({ label: copy.READ_UNREAD, run: () => markChatUnread() })
    const f = box.threadFolder(address)
    const button = f === ARCHIVE ? INBOX : ARCHIVE
    items.push({ label: f === ARCHIVE ? copy.READ_TO_INBOX : copy.READ_ARCHIVE, run: () => moveChat(button) })
    const to = box.folders().filter((x) => x.id !== f && x.id !== button)
    if (to.length) items.push({ label: copy.READ_MOVE_HEADING, heading: true }, ...to.map((x) => ({ label: folderName(x.id), aria: copy.MOVED_TO_LABEL(folderName(x.id)), run: () => moveChat(x.id) })))
    // Naming needs the address book, which needs keeping; a second tab can't keep, so it says nothing.
    if (!withBook() && !kept()) items.push({ label: copy.READ_NAME_KEEP, heading: true })
    // Blocking them needs keeping too, or it would be forgotten at Lock; unblocking never does.
    if (box.isBlocked(address)) items.push({ label: copy.UNBLOCK, run: () => unblockSender(address) })
    else if (withBook()) items.push({ label: copy.BLOCK_START, run: askBlock })
    items.push({ label: copy.CHAT_REMOVE(keeping), danger: true, run: askRemoveChat })
    return items
  })

  function askBlock() {
    if (!chatWith) return
    closeChatForms()
    $('ib-c-block-text').textContent = copy.BLOCK_ASK(isolate(plain(whoIs(chatWith))))
    $('ib-c-block-ask').hidden = false
    $('ib-c-block-no').focus()
  }
  $('ib-c-block-no').addEventListener('click', () => {
    $('ib-c-block-ask').hidden = true
    $('ib-c-more').focus()
  })
  $('ib-c-block-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-c-block-no').click()
    }
  })
  $('ib-c-block-yes').addEventListener('click', () => {
    const address = chatWith
    $('ib-c-block-ask').hidden = true
    if (!address || !withBook()) return
    const who = isolate(plain(whoIs(address)))
    if (box.block(address, true)) changed()
    deps.unreadChanged()
    closeChat(copy.BLOCKED(who))
  })
  $('ib-c-unblock').addEventListener('click', () => {
    if (!chatWith) return
    unblockSender(chatWith)
    $('ib-c-name').focus()
  })

  function moveChat(to: string) {
    if (!chatWith) return
    if (box.moveThread(chatWith, to)) changed()
    closeChat(to === ARCHIVE ? copy.ARCHIVED : copy.MOVED(folderName(to)))
  }

  function markChatUnread() {
    if (!chatWith) return
    if (box.readThread(chatWith, false)) changed()
    closeChat(copy.MARKED_UNREAD)
  }

  /** What the confirm under the heading would remove: the whole conversation, or one message in it. */
  let removing: { thread: true } | { in: string } | { out: string } | undefined

  function askRemoveChat() {
    askRemoveFromChat({ thread: true })
  }

  function askRemoveFromChat(what: NonNullable<typeof removing>) {
    closeChatForms()
    removing = what
    $('ib-c-remove-text').textContent = 'thread' in what ? copy.CHAT_REMOVE_ASK(keeping) : 'in' in what ? copy.REMOVE_ASK(keeping) : copy.SENT_REMOVE_ASK
    $('ib-c-remove-ask').hidden = false
    $('ib-c-remove-no').focus()
  }
  $('ib-c-remove-no').addEventListener('click', () => {
    $('ib-c-remove-ask').hidden = true
    removing = undefined
    $('ib-c-more').focus()
  })
  $('ib-c-remove-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-c-remove-no').click()
    }
  })
  $('ib-c-remove-yes').addEventListener('click', () => {
    const address = chatWith
    const what = removing
    if (!address || !what) return
    $('ib-c-remove-ask').hidden = true
    removing = undefined
    if ('in' in what) {
      if (removeItem(what.in)) changed()
    } else if ('out' in what) {
      if (box.getSent(what.out)?.state !== 'sending' && box.removeSent(what.out)) {
        forgetOutgoing(what.out)
        changed()
      }
    } else {
      const busy = threadBusy(address)
      if (busy) return deps.toast(busy)
      // Its draft goes too: emptied first, or closing the conversation would save it again.
      chatText.value = ''
      chatMsg = undefined
      removeThreadNow(address)
      changed()
      return closeChat(copy.CHAT_REMOVED)
    }
    render()
    deps.toast(copy.REMOVED)
    $('ib-c-name').focus()
  })

  /**
   * Why a conversation can't be removed just now, or '': something of theirs is being collected,
   * or a message of the owner's is still on its way (it would go anyway: wait for it).
   */
  function threadBusy(address: Uint8Array): string {
    const entries = box.thread(address)
    if (entries.some((e) => e.kind === 'in' && !!collecting && collecting === drops.get(e.item.id))) return copy.DROP_ONE_AT_A_TIME
    if (entries.some((e) => e.kind === 'out' && e.sent.state === 'sending')) return copy.CHAT_REMOVE_BUSY
    return ''
  }

  /** Removes a whole conversation: their messages for good and anything collected of them, the owner's own, its draft and its files. */
  function removeThreadNow(address: Uint8Array) {
    for (const e of box.thread(address)) {
      if (e.kind === 'in') removeItem(e.item.id)
      else forgetOutgoing(e.sent.id)
    }
    box.removeThread(address)
    drafts.delete(inboxKey(address))
    closeTray(address)
  }

  /** Saves a name for the open conversation's sender in the address book. */
  function nameSender(name: string): boolean {
    const address = chatWith
    if (!address || !withBook()) return false
    const c = box.saveContact(address, name)
    const error = $('ib-c-name-error')
    if (c === 'empty') {
      $('ib-c-name-field').focus()
      return false
    }
    error.hidden = typeof c !== 'string'
    if (c === 'taken') error.textContent = copy.BOOK_TAKEN
    else if (c === 'full') error.textContent = copy.BOOK_FULL
    if (typeof c === 'string') {
      $('ib-c-name-box').hidden = false
      $('ib-c-name-field').focus()
      return false
    }
    changed()
    deps.bookChanged()
    deps.toast(copy.BOOK_SAVED(isolate(c.name)))
    return true
  }

  const nameField = $<HTMLInputElement>('ib-c-name-field')
  nameField.maxLength = MAX_NAME * 2
  function openNameBox() {
    if (!chatWith) return
    closeChatForms()
    $('ib-c-name-error').hidden = true
    nameField.value = box.contactFor(chatWith)?.name ?? ''
    $('ib-c-name-box').hidden = false
    nameField.focus()
  }
  $('ib-c-name-save').addEventListener('click', () => {
    if (!nameSender(nameField.value)) return
    $('ib-c-name-box').hidden = true
    render()
    $('ib-c-name').focus()
  })
  nameField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('ib-c-name-save').click()
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-c-name-box').hidden = true
      $('ib-c-more').focus()
    }
  })
  function useName() {
    if (!chatWith || !nameSender(box.givenName(chatWith))) return
    render()
    $('ib-c-name').focus()
  }

  // --- Replying, in the chat ------------------------------------------------------------------

  /** The name the owner shows this inbox: the one they showed last, kept with the inbox when it's kept. */
  const chatAs = () => (chatWith ? box.shownTo(chatWith) : '')
  /**
   * How much one message can hold, packed (pack.ts), with this inbox included
   * and the name shown: sealed with the reply keys they gave, if they gave
   * some, or as their address says.
   */
  const chatRoom = () => (chatWith ? textRoom(chatWith, { nameBytes: textBytes(chatAs()), reply: box.hasReplyKeys(chatWith) }) : 0)

  function renderChatCompose() {
    const f = fillRoom(chatText.value, chatRoom())
    const room = $('ib-c-room')
    // A conversation marked quantum-safe, with neither their quantum-safe address nor reply keys
    // from them (a conversation from before reply keys): the reply can only go to their secure
    // address, the standard way.
    $('ib-c-not-qs').hidden = !(chatWith && box.threadQs(chatWith) && !isQuantumSafe(chatWith) && !box.hasReplyKeys(chatWith))
    const send = $<HTMLButtonElement>('ib-c-send')
    const wait = !(info && !opening && !failed)
    const upload = uploadMode()
    $('ib-c-attach').hidden = !INBOX_FILES
    // This conversation's files, if any, between the conversation and the reply box: the files, the meter, the offer.
    const t = INBOX_FILES && chatWith ? trays.get(inboxKey(chatWith)) : undefined
    for (const [slot, el] of [[$('ib-c-files-slot'), t?.list], [$('ib-c-fit-slot'), t?.fit]] as const) {
      if (el ? slot.firstChild !== el : slot.firstChild) slot.replaceChildren(...(el ? [el] : []))
    }
    $('ib-c-tray').hidden = !upload
    room.toggleAttribute('data-over', false)
    if (upload) {
      // Files, or more than one message holds: the composer's meter, and why it can't go yet.
      const { tray, list } = trayFor(chatWith!)
      list.hidden = !tray.count()
      const c = chatCompose(tray, inboxKey(chatWith!))
      const m = meter({ wire: c.wire, files: c.files, messages: c.messages, varied: settings().variedBatches, pending: c.pending, limit: DROP_LIMIT, working: tray.working() })
      $('ib-c-meter-fill').style.width = `${m.fill}%`
      $('ib-c-meter').toggleAttribute('data-over', m.over)
      $('ib-c-meter').toggleAttribute('data-working', m.working)
      $('ib-c-meter-working').hidden = !m.working
      $('ib-c-meter-text').textContent = m.text
      $('ib-c-meter-eta').textContent = m.eta
      tray.renderOffer(c)
      // Once a visit, until the first upload goes: what an upload can give away.
      $('ib-c-honest').hidden = honestDone
      const blocked = wait ? copy.CHAT_WAIT : tray.blocker(c) || tray.waiting(c)
      room.textContent = blocked
      room.hidden = !blocked
      send.disabled = !!blocked || packingUpload
    } else {
      // The room left shows only near the end.
      room.hidden = !wait && !f.over && f.chars > 120
      room.toggleAttribute('data-over', !wait && f.over)
      room.textContent = wait ? copy.CHAT_WAIT : f.over ? copy.TO_OVER(f.chars) : copy.TO_ROOM(f.chars)
      send.disabled = wait || !chatText.value.trim() || f.over
    }
    fill($('ib-c-as'), copy.CHAT_AS(chatAs()))
    $('ib-c-as-go').textContent = chatAs() ? copy.CHAT_AS_CHANGE : copy.CHAT_AS_ADD
  }

  /** The reply box grows with what's written, up to a limit (styles). */
  function growText() {
    chatText.style.height = 'auto'
    chatText.style.height = `${chatText.scrollHeight}px`
  }
  chatText.addEventListener('input', () => {
    growText()
    renderChatCompose()
    deps.warm()
    // As the composer does: the text is packed a moment after the last key, for the meter.
    if (uploadMode()) {
      clearTimeout(chatTyping)
      chatTyping = setTimeout(() => void packChatText(), 200)
    }
  })
  // On a computer, Enter sends and Shift+Enter starts a new line; on a touch screen, Enter is a new line.
  chatText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer: fine)').matches) {
      e.preventDefault()
      $<HTMLFormElement>('ib-c-form').requestSubmit()
    }
  })
  $('ib-c-form').addEventListener('submit', (e) => {
    e.preventDefault()
    sendChat()
  })

  function sendChat() {
    const address = chatWith
    const text = chatText.value
    if (!address || !info || opening || failed || box.isBlocked(address)) return
    if (uploadMode()) return void sendUpload(address)
    if (!text.trim() || !fits(text, chatRoom())) return
    const busy = deps.canSend()
    if (busy) return deps.toast(busy)
    const x = box.addSent(address, new TextEncoder().encode(text), chatAs())
    chatText.value = ''
    drafts.delete(inboxKey(address))
    growText()
    stickToEnd = true
    render()
    chatText.focus({ preventScroll: true })
    deliver(x.id)
  }

  function retrySent(id: string) {
    // An upload that hasn't gone waits for any collecting too; one that has needs only its notice.
    const busy = deps.canSend(outgoing.has(id) && !outgoing.get(id)!.v1)
    if (busy) return deps.toast(busy)
    if (box.getSent(id)?.upload !== undefined && !outgoing.has(id)) return deps.toast(copy.CHAT_FAILED)
    if (!box.sentRetry(id)) return
    unconfirmed.delete(id)
    stopped.delete(id)
    stickToEnd = true
    render()
    // Try again has gone with the redraw: the reply box, near the message, rather than the top.
    chatText.focus({ preventScroll: true })
    deliver(id)
  }

  /** A reply whose address the core refused: gone from the conversation, its text back in the reply box. */
  function refusedAddress(x: SentItem) {
    box.removeSent(x.id, false)
    forgetOutgoing(x.id)
    if (chatWith && inboxKey(chatWith) === x.to) {
      chatWith = box.bestAddress(compactAddress(x.address)).slice()
      if (!chatText.value.trim() && x.upload === undefined) chatText.value = new TextDecoder().decode(x.body)
    }
    changed()
    deps.toast(copy.TO_BAD_ADDRESS_TITLE)
  }

  /** Sends one of the owner's messages, after any still going: one at a time, in order. */
  function deliver(id: string) {
    const run = opened
    sendingNow++
    queue = queue.then(async () => {
      const x = box.getSent(id)
      if (!x || x.state !== 'sending' || run !== opened) return
      going = id
      renderSoon()
      const text = new TextDecoder().decode(x.body)
      // Sealed with the reply keys they gave, if any: quantum-safe, in one message. Ones
      // that came while this waited its turn are used too, unless the text then doesn't fit, as
      // when it was written without them: it goes as it was written. A copy of its own, which
      // nothing can wipe while an upload runs, wiped once it has gone.
      let keys = box.replyKeysFor(x.address)
      if (keys && x.upload === undefined && !fits(text, textRoom(x.address, { nameBytes: textBytes(x.name), reply: true }))) {
        keys.fill(0)
        keys = undefined
      }
      try {
        const at =
          x.upload !== undefined
            ? await deliverUpload(x, run, keys)
            : await deps.sendReply(x.address, text, x.name, keys, (stage) => stages.set(id, stage))
        if (run !== opened) return
        box.sentDone(id, at, !!keys || isQuantumSafe(x.address))
        forgetOutgoing(id)
        changed()
        $('ib-announce').textContent = copy.CHAT_SENT
      } catch (e) {
        if (run !== opened) return
        // The core refused the address itself: no try will ever go, so the message comes back to
        // the reply box rather than staying on to be what this conversation is written to.
        if (errorCode(e) === 'address') refusedAddress(x)
        else {
          box.sentFailed(id)
          if (errorCode(e) === 'unconfirmed') unconfirmed.add(id)
          if (errorCode(e) === 'stopped') stopped.add(id)
          $('ib-announce').textContent = `${stateText(x)} ${copy.CHAT_RETRY}?`
        }
      } finally {
        keys?.fill(0)
        stages.delete(id)
        if (going === id) going = undefined
      }
      renderSoon()
    })
    // Nothing that goes wrong in one send may stop the ones after it.
    queue = queue.catch(() => {})
    void queue.finally(() => sendingNow--)
  }

  // The name they see: changed here, kept with the inbox when it's kept.
  const asField = $<HTMLInputElement>('ib-c-as-field')
  asField.maxLength = MAX_GIVEN_NAME * 2
  asField.placeholder = copy.INCLUDE_NAME_PLACEHOLDER
  $('ib-c-as-go').addEventListener('click', () => {
    const show = $('ib-c-as-box').hidden
    closeChatForms()
    $('ib-c-as-box').hidden = !show
    $('ib-c-as-go').setAttribute('aria-expanded', String(show))
    if (show) {
      asField.value = chatAs()
      asField.focus()
    }
  })
  $('ib-c-as-save').addEventListener('click', () => {
    if (chatWith && box.setShownTo(chatWith, asField.value)) {
      changed()
      // Nothing changes at their end until the next message carries it: say so, briefly.
      deps.toast(copy.CHAT_AS_SAVED(!!box.shownTo(chatWith)))
    }
    closeChatForms()
    renderChatCompose()
    chatText.focus()
  })
  asField.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      $('ib-c-as-save').click()
    }
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeChatForms()
      $('ib-c-as-go').focus()
    }
  })

  // --- Stopping a reply's files on their way ----------------------------------------------
  // Cancel at the end of its state line asks here. A reply still waiting its turn never
  // starts; an upload under way stops (the core drops what's still to go); the message
  // telling them stops while it waits for its moment, but not once it has started to go.
  // A stopped reply keeps its upload, so Try again tells them without uploading again.

  function askStop(id: string) {
    closeChatForms()
    stopping = id
    $('ib-c-stop-ask').hidden = false
    $('ib-c-stop-no').focus()
  }
  $('ib-c-stop-no').addEventListener('click', () => {
    const id = stopping
    $('ib-c-stop-ask').hidden = true
    stopping = undefined
    // Back to the message's Cancel, or the reply box if it has gone meanwhile.
    const back = id ? $('ib-c-log').querySelector<HTMLElement>(`[data-key="${id}"] [data-role="cancel"]`) : null
    ;(back ?? chatText).focus({ preventScroll: !back })
  })
  $('ib-c-stop-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      $('ib-c-stop-no').click()
    }
  })
  $('ib-c-stop-yes').addEventListener('click', async () => {
    const id = stopping
    $('ib-c-stop-ask').hidden = true
    stopping = undefined
    const x = id ? box.getSent(id) : undefined
    if (!id || x?.state !== 'sending' || stopped.has(id)) return
    if (going !== id) {
      // Still waiting its turn: it never starts.
      stopped.add(id)
      box.sentFailed(id)
    } else if (stages.get(id) === 'telling') {
      if (!(await deps.stopNotice())) return deps.toast(copy.STOP_TOO_LATE)
      stopped.add(id)
    } else {
      stopped.add(id)
      deps.stopUpload()
    }
    render()
    chatText.focus({ preventScroll: true })
  })

  // --- Files, or a reply too long for one message, from the chat (INBOX_FILES) ---------------
  // Attached with the paperclip (or dropped on the screen), with the
  // composer's own tray: cleaned, measured, made smaller if asked. Send packs
  // it at once, and the owner's message shows the text and the files' names
  // and sizes while it waits its turn, uploads, then tells them a few minutes
  // later. Each conversation keeps its own files until Lock.

  /** The reply goes as an upload: files are attached, or it's too long for one message. */
  const uploadMode = () => INBOX_FILES && !!chatWith && needsUpload(trays.get(inboxKey(chatWith))?.tray.count() ?? 0, chatText.value, chatRoom())

  /** A conversation's files, made the first time it gets any. */
  function trayFor(address: Uint8Array): ChatTray {
    const key = inboxKey(address)
    const have = trays.get(key)
    if (have) return have
    const list = Object.assign(document.createElement('ul'), { className: 'items', hidden: true })
    list.setAttribute('aria-label', copy.CHAT_FILES_LIST)
    const fit = Object.assign(document.createElement('div'), { className: 'fit', hidden: true })
    fit.setAttribute('role', 'status')
    const fitText = Object.assign(document.createElement('p'), { tabIndex: -1 })
    const fitGo = Object.assign(document.createElement('button'), { type: 'button', className: 'btn mini', hidden: true })
    fit.append(fitText, fitGo)
    const tray: Tray = createTray({
      list,
      fit,
      fitText,
      fitGo,
      compose: () => chatCompose(tray, key),
      // Nothing can change it later (no one-time layer, no password): copies aim for the whole of it.
      limit: () => DROP_LIMIT,
      planLimit: () => DROP_LIMIT,
      changed: () => {
        if (chatWith && inboxKey(chatWith) === key) renderChatCompose()
      },
      added: () => {},
      toast: deps.toast,
      addButton: () => $('ib-c-attach'),
      sendButton: () => $<HTMLButtonElement>('ib-c-send'),
      openSetting: (id) => deps.openSetting(id),
    })
    const made = { tray, list, fit }
    trays.set(key, made)
    return made
  }

  /** A conversation's files go for good: it was removed. */
  function closeTray(address: Uint8Array) {
    trays.get(inboxKey(address))?.tray.close()
    trays.delete(inboxKey(address))
  }

  /** What a conversation's reply would send now: its text (once packed, in the open one) and its files. */
  function chatCompose(tray: Tray, key: string): Compose {
    const open = !!chatWith && inboxKey(chatWith) === key
    const text = open ? chatText.value : (drafts.get(key) ?? '')
    return tray.compose(open ? chatMsg : undefined, text ? 1 : 0)
  }

  let chatTyping: ReturnType<typeof setTimeout> | undefined
  let chatMsgReady: Promise<void> = Promise.resolve()

  /** Packs the reply box's text for an upload; resolves once the current text is packed. */
  function packChatText(): Promise<void> {
    clearTimeout(chatTyping)
    const text = chatText.value
    if (chatMsg?.text === text) return chatMsgReady
    chatSqueeze?.abort() // for the text as it was
    if (!text) {
      chatMsg = undefined
      renderChatCompose()
      return (chatMsgReady = Promise.resolve())
    }
    const m: Text & { text: string } = { text, data: new TextEncoder().encode(text) }
    chatMsg = m
    chatMsgReady = (async () => {
      m.stored = await store(m.data)
      if (chatMsg === m) {
        renderChatCompose()
        squeezeChat(m)
      }
    })()
    return chatMsgReady
  }

  let chatSqueeze: AbortController | undefined

  /** Brotli's smaller version of the reply, if it's made before it goes; one at a time, as the composer's message. */
  function squeezeChat(m: Text & { text: string }) {
    chatSqueeze?.abort()
    const deflated = m.stored
    if (!settings().brotli || !deflated || deflated.method === 'brotli') return
    const stop = (chatSqueeze = new AbortController())
    void squeeze(m.data, deflated, qualityFor(m.data.length), stop.signal)
      .then((better) => {
        if (chatMsg !== m || m.stored !== deflated || !settings().brotli) return
        m.stored = better
        renderChatCompose()
      })
      .catch(() => {})
  }

  // "Stronger compression" turned on or off: the reply too, in place (each chat's tray does its files).
  let brotliWasOn = settings().brotli
  onSettings((st) => {
    if (st.brotli === brotliWasOn) return
    brotliWasOn = st.brotli
    const m = chatMsg
    if (!m?.stored) return
    if (st.brotli) return squeezeChat(m)
    chatSqueeze?.abort()
    if (m.stored.method === 'brotli')
      void store(m.data).then((deflated) => {
        if (chatMsg !== m) return
        m.stored = deflated
        renderChatCompose()
      })
  })

  function addChatFiles(files: File[]) {
    if (!INBOX_FILES || !chatWith || !files.length) return
    deps.warm()
    trayFor(chatWith).tray.add(files)
    void packChatText()
    renderChatCompose()
  }

  $('ib-c-attach').setAttribute('aria-label', copy.CHAT_FILES)
  $('ib-c-attach').title = copy.CHAT_FILES
  $('ib-c-attach').addEventListener('click', () => $('ib-c-file').click())
  $<HTMLInputElement>('ib-c-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = '' // so choosing the same file again still fires
    addChatFiles(files)
  })

  /** Packs the reply and its files, and queues it: it uploads in its turn. */
  async function sendUpload(address: Uint8Array) {
    if (packingUpload) return // a double click
    const busy = deps.canSend(true)
    if (busy) return deps.toast(busy)
    const key = inboxKey(address)
    const { tray } = trayFor(address)
    packingUpload = true
    try {
      // In case the last keystrokes are still being packed.
      while (chatText.value !== (chatMsg?.text ?? '') || (chatMsg && !chatMsg.stored)) await packChatText()
    } finally {
      packingUpload = false
    }
    if (!info || !chatWith || inboxKey(chatWith) !== key) return
    // Something may have started while it was being packed (collecting their files, say).
    const later = deps.canSend(true)
    if (later) return deps.toast(later)
    const c = chatCompose(tray, key)
    if (!uploadMode() || tray.blocker(c) || tray.waiting(c) || !c.packed.length) return renderChatCompose()
    const text = chatText.value
    const bytes = encode(c.packed)
    // Sending has begun: Brotli stops, so it doesn't compete with the upload.
    chatSqueeze?.abort()
    tray.stopSqueezing()
    const x = box.addSent(address, new TextEncoder().encode(text), chatAs(), bytes.length, Date.now(), fileNames(c.packed))
    outgoing.set(x.id, { bytes, since: 0, done: 0, total: 0 })
    chatText.value = ''
    chatMsg = undefined
    drafts.delete(key)
    tray.clear()
    honestDone = true
    growText()
    stickToEnd = true
    render()
    chatText.focus({ preventScroll: true })
    deliver(x.id)
  }

  /** An upload's turn: the package (unless it went before), then the notice that tells them, with the reply keys they gave, if any. */
  async function deliverUpload(x: SentItem, run: number, keys: Uint8Array | undefined): Promise<number> {
    const out = outgoing.get(x.id)
    if (!out || (!out.bytes && !out.v1)) throw new Error(copy.CHAT_FAILED)
    if (!out.v1) {
      out.done = 0
      out.total = 0
      stages.set(x.id, 'uploading')
      renderSoon()
      const v1 = await deps.uploadReply(out.bytes!, (_stage, done, total) => {
        out.done = done
        out.total = total
        paintState(x.id)
      })
      // Locked or removed meanwhile: the link (its key) goes.
      if (run !== opened || outgoing.get(x.id) !== out) {
        v1.fill(0)
        throw new Error(copy.CHAT_FAILED)
      }
      out.v1 = v1
      out.since = Date.now()
      // Uploaded: only its link is needed now, to tell them.
      out.bytes?.fill(0)
      out.bytes = undefined
      // Finished just as the owner stopped it: they aren't told, unless Try again.
      if (stopped.has(x.id)) throw new Error(copy.CHAT_STOPPED)
    }
    stages.set(x.id, 'telling')
    renderSoon()
    $('ib-announce').textContent = copy.CHAT_TELLING
    return deps.noticeReply(x.address, out.v1, out.since, x.name, keys)
  }

  /** Wipes what an upload held: its package and its link. */
  function forgetOutgoing(id: string) {
    const out = outgoing.get(id)
    out?.bytes?.fill(0)
    out?.v1?.fill(0)
    outgoing.delete(id)
  }

  /** Files from the chat that uploaded, but they haven't been told about yet (or are being told now). */
  const untold = () => [...outgoing].some(([id, out]) => !!out.v1 && !stopped.has(id))

  /** Files from the chat still to upload, now or in their turn: the core does one transfer at a time. */
  const uploadsWaiting = () => [...outgoing].some(([id, out]) => !out.v1 && box.getSent(id)?.state === 'sending')

  /** How one of the owner's messages is getting on. */
  function stateText(x: SentItem): string {
    if (x.state === 'sent') return copy.CHAT_SENT
    if (x.state === 'failed') return stopped.has(x.id) ? copy.CHAT_STOPPED : unconfirmed.has(x.id) ? copy.CHAT_UNCONFIRMED : outgoing.get(x.id)?.v1 ? copy.CHAT_TELL_FAILED : copy.CHAT_FAILED
    if (going !== x.id) return copy.CHAT_QUEUED
    const stage = stages.get(x.id)
    const out = outgoing.get(x.id)
    if (stage === 'uploading') return copy.CHAT_UPLOADING(out?.total ? Math.floor((out.done / out.total) * 100) : 0)
    if (stage === 'telling') return copy.CHAT_TELLING
    return copy.CHAT_SENDING
  }

  /** Updates a message's state line where it is, without redrawing the conversation (an upload's percentage). */
  function paintState(id: string) {
    const el = stateEls.get(id)
    const x = box.getSent(id)
    if (el?.isConnected && x?.state === 'sending') el.textContent = stateText(x)
  }

  /** The files in the owner's own message, by name and size. */
  function sentFiles(files: FileNote[]): HTMLElement {
    const ul = document.createElement('ul')
    ul.className = 'bubble-files'
    ul.setAttribute('aria-label', copy.CHAT_FILES_SENT)
    for (const f of files) {
      const li = document.createElement('li')
      li.innerHTML = FILE_SVG // fixed markup
      const name = Object.assign(document.createElement('bdi'), { className: 'bubble-file-name', textContent: f.name })
      const bytes = Object.assign(document.createElement('span'), { className: 'bubble-file-size', textContent: size(f.size) })
      li.append(name, bytes)
      ul.append(li)
    }
    return ul
  }

  // --- Uploads: files or a longer message (INBOX_FILES) ---------------------------

  /** An upload's part of the message opened, made the first time it's opened and kept while it's held. */
  function dropFor(item: MailItem): Drop {
    const have = drops.get(item.id)
    if (have) return have
    const el = clone('tpl-inbox-drop')
    const zip = zipButtons(part(el, 'save-all') as HTMLButtonElement, part(el, 'share-all') as HTMLButtonElement, part(el, 'zip-note'), deps.toast)
    const drop: Drop = { item, el, state: 'ready', error: '', stalledAt: -1, stopping: false, gone: false, zip }
    part(el, 'label').textContent = copy.DROP_LABEL
    part(el, 'size').textContent = size(item.upload!.size)
    part(el, 'collect').addEventListener('click', () => void collect(drop))
    part(el, 'wait').textContent = copy.DROP_KEEP_WAITING
    part(el, 'wait').addEventListener('click', () => (part(el, 'stall').hidden = true))
    part(el, 'stop').textContent = copy.DROP_STOP
    part(el, 'stop').addEventListener('click', () => {
      if (collecting !== drop) return
      drop.stopping = true
      ;(part(el, 'stop') as HTMLButtonElement).disabled = true
      deps.stopDownload()
    })
    part(el, 'forget').textContent = copy.DROP_FORGET
    part(el, 'forget').addEventListener('click', () => {
      forget(drop)
      renderDrop(drop)
      part(el, 'collect').focus()
      deps.toast(copy.DROP_FORGOTTEN)
    })
    drops.set(item.id, drop)
    return drop
  }

  const collectedDate = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })

  function renderDrop(drop: Drop) {
    const el = drop.el
    const u = drop.item.upload!
    if (!u.v1 && ['ready', 'failed'].includes(drop.state)) drop.state = 'expired'
    const status = part(el, 'status')
    const go = part(el, 'collect')
    const statusText: Record<Drop['state'], string> = {
      ready: '',
      collecting: status.textContent || copy.DROP_COLLECTING,
      failed: drop.error,
      damaged: copy.DROP_DAMAGED,
      expired: u.collected ? copy.DROP_GONE(collectedDate(u.collected)) : copy.DROP_EXPIRED,
      collected: '',
    }
    status.textContent = statusText[drop.state]
    status.hidden = !status.textContent
    go.hidden = !['ready', 'failed'].includes(drop.state)
    go.textContent = drop.state === 'failed' ? copy.DROP_TRY_AGAIN : copy.DROP_COLLECT
    go.setAttribute('aria-label', copy.DROP_COLLECT_LABEL(go.textContent, size(u.size)))
    // When it was collected before, and that files are never kept here.
    const note = part(el, 'kept-note')
    note.textContent =
      drop.state === 'collected' && kept() ? copy.DROP_NOT_KEPT : drop.state === 'ready' && u.collected ? copy.DROP_COLLECTED_ON(collectedDate(u.collected)) : ''
    note.hidden = !note.textContent
    if (drop.state !== 'collecting') part(el, 'stall').hidden = true
    const items = part(el, 'items')
    const after = part(el, 'after')
    // Drawn again only when what was collected changes: a redraw of the conversation keeps the
    // focus where it was, and Save's "Saved".
    if (drop.drawn === drop.items && (drop.items || items.hidden)) return
    drop.drawn = drop.items
    if (drop.state !== 'collected' || !drop.items) {
      items.replaceChildren()
      items.hidden = true
      after.hidden = true
      drop.zip.clear()
      return
    }
    items.replaceChildren(
      ...drop.items.map((item) =>
        item.kind === 'file'
          ? fileRow(
              item,
              (it, button) => {
                if (drop.items?.includes(it)) {
                  saveFile(it)
                  markSaved(button, it)
                }
              },
              deps.toast,
            )
          : drop.item.from
            ? chatMessage(item)
            : shown(itemMessageRow(item, (text) => void copyText(text, 'Copied', deps.toast), 'inbox')),
      ),
    )
    items.hidden = false
    after.hidden = false
    drop.zip.show(drop.items)
  }

  /** A message in what was collected in a conversation: plain text, like their other messages (Copy is in its menu). */
  function chatMessage(item: Item): HTMLElement {
    const li = Object.assign(document.createElement('li'), { className: 'drop-msg', tabIndex: -1 })
    li.append(linkedText(new TextDecoder().decode(item.data), 'inbox'))
    return li
  }

  /** The text of what was collected of an upload, for Copy in the conversation. */
  const collectedText = (id: string) =>
    (drops.get(id)?.items ?? [])
      .filter((i) => i.kind === 'text')
      .map((i) => new TextDecoder().decode(i.data))
      .join('\n\n')

  /** A message in a collected upload shows at once, like any message opened from the list. */
  function shown(li: HTMLElement): HTMLElement {
    setHidden(li.querySelector<HTMLElement>('[data-part="secret"]')!, false)
    return li
  }

  async function collect(drop: Drop) {
    const el = drop.el
    if (drop.gone || !['ready', 'failed'].includes(drop.state)) return
    if (box.dropExpiredLinks()) changed()
    const v1 = drop.item.upload?.v1
    if (!v1) {
      drop.state = 'expired'
      renderDrop(drop)
      return part(el, 'status').focus() // the button it replaces had the focus
    }
    if (collecting) return deps.toast(copy.DROP_ONE_AT_A_TIME)
    if (uploadsWaiting()) return deps.toast(copy.CHAT_UPLOAD_BUSY)
    const eta = new Eta()
    let arrived = 0
    const status = part(el, 'status')
    const run = deps.download(v1, (stage, done, total) => {
      if (drop.gone) return
      if (stage === 'stalled') {
        drop.stalledAt = done
        part(el, 'stall-text').textContent = copy.DROP_STALLED(done, total)
        ;(part(el, 'stop') as HTMLButtonElement).disabled = false
        part(el, 'stall').hidden = false
        return
      }
      arrived = done
      if (done > drop.stalledAt) part(el, 'stall').hidden = true
      status.textContent = piecesText(done, total, total > 2 ? eta.update(done, total) : undefined, false)
    })
    if (!run) return deps.toast(copy.DROP_ONE_AT_A_TIME)
    collecting = drop
    drop.state = 'collecting'
    drop.stopping = false
    drop.stalledAt = -1
    status.textContent = copy.DROP_COLLECTING
    renderDrop(drop)
    status.focus() // the button it replaces had the focus
    $('ib-announce').textContent = copy.DROP_COLLECTING
    let bytes: Uint8Array
    try {
      bytes = await run
    } catch (e) {
      if (collecting === drop) collecting = undefined
      if (drop.gone) return
      drop.state = 'failed'
      drop.error = drop.stopping ? copy.DROP_STOPPED(arrived) : copy.DROP_FAILED(e instanceof Error ? e.message : String(e))
      renderDrop(drop)
      $('ib-announce').textContent = drop.error
      if (el.isConnected) part(el, 'collect').focus()
      return
    }
    if (collecting === drop) collecting = undefined
    if (drop.gone) return bytes.fill(0)
    let items: Item[]
    try {
      items = await decode(bytes)
    } catch (e) {
      bytes.fill(0)
      // This tab couldn't unpack it just now: collecting it again may do better.
      if (e instanceof EnvelopeError && e.again) {
        drop.state = 'failed'
        drop.error = e.message
        renderDrop(drop)
        $('ib-announce').textContent = drop.error
        if (el.isConnected) part(el, 'collect').focus()
        return
      }
      // Collecting it again would bring back the same bytes.
      drop.state = 'damaged'
      renderDrop(drop)
      if (el.isConnected) part(el, 'status').focus()
      $('ib-announce').textContent = copy.DROP_DAMAGED
      return
    }
    if (drop.gone) {
      bytes.fill(0)
      for (const item of items) item.data.fill(0)
      return
    }
    // Names come from the sender: show and save only cleaned-up ones.
    drop.items = items.map((i) => (i.kind === 'file' ? { ...i, name: safeName(i.name, '') } : i))
    drop.bytes = bytes
    drop.state = 'collected'
    if (box.markCollected(drop.item.id)) changed()
    renderDrop(drop)
    const files = items.filter((i) => i.kind === 'file').length
    $('ib-announce').textContent = `${capitalize(countLabel(files, items.length - files))} collected.`
    // The first thing to do with it: a file's Save, or else the message itself (never Forget, which an
    // Enter too many would press; a message's own reveal button is hidden).
    const list = part(el, 'items')
    if (el.isConnected) ([...list.querySelectorAll<HTMLElement>('button')].find((b) => b.getClientRects().length) ?? list.querySelector<HTMLElement>('.drop-msg, .item'))?.focus()
  }

  /** Overwrites what was collected of an upload. Its link stays, so it can be collected again. */
  function forget(drop: Drop) {
    drop.zip.clear() // and the zip made for sharing them
    for (const item of drop.items ?? []) item.data.fill(0)
    drop.bytes?.fill(0)
    drop.items = undefined
    drop.bytes = undefined
    if (drop.state === 'collected') drop.state = 'ready'
  }

  /** Overwrites what was collected and stops collecting it: the mailbox wipes the link. */
  function wipeDrop(drop: Drop) {
    drop.gone = true
    forget(drop)
    if (collecting === drop) {
      collecting = undefined
      deps.stopDownload()
    }
  }

  function wipeMessages() {
    for (const d of drops.values()) wipeDrop(d)
    drops.clear()
    box.wipeAll()
    rows.clear()
    shownRows.clear()
    selecting = false
    selected.clear()
    openId = undefined
    chatWith = undefined
    folder = INBOX
    drafts.clear()
    stages.clear()
    stateEls.clear()
    unconfirmed.clear()
    going = undefined
    for (const id of [...outgoing.keys()]) forgetOutgoing(id)
    for (const t of trays.values()) t.tray.close()
    trays.clear()
    $('ib-c-files-slot').replaceChildren()
    $('ib-c-fit-slot').replaceChildren()
    chatMsg = undefined
    fresh.clear()
    clearTimeout(renderTimer)
    renderDue = 0
    chatShown = ''
    removing = undefined
    chatText.value = ''
    // The open message's box goes home first: it's part of the page, not of the list.
    placeOpen()
    closeOpenForms()
    $('ib-list').replaceChildren()
    $('ib-r-body').replaceChildren()
    log.replaceChildren()
  }

  // --- Opening ---------------------------------------------------------------------

  /**
   * Checks the words offline, shows the card with whatever this device kept,
   * and opens the inbox once connected. keep: start keeping it on this
   * device; label: the owner's name for it, from the saved passphrase or creating it.
   */
  /** Reads what's kept for an inbox, once more after a moment if the browser's storage doesn't answer (a passing hiccup). */
  /** opts.qs: the quantum-safe address was chosen as it was made: Share opens on it. */
  async function open(words: string, opts: { keep?: boolean; label?: string; remember?: boolean; password?: string; qs?: boolean; restore?: Mailbox } = {}): Promise<'ok' | 'words' | 'already'> {
    if (info) return 'already'
    // Pasted as "Copy the words" gives them, numbered, or typed with stray capitals or commas.
    words = normalizeWords(words)
    let checked: InboxInfo
    try {
      checked = await deps.core().inboxCheckWords(words)
    } catch (e) {
      if (errorCode(e) === 'words') return 'words'
      throw e
    }
    if (info) {
      checked.store?.fill(0)
      return 'already'
    }
    // Only now: mistyped words shouldn't cost this tab its identity.
    deps.claim()
    const run = ++opened
    info = checked
    opening = words
    failed = ''
    lookback = undefined
    announced = ''
    wipeMessages()
    box = new Mailbox()
    keeping = elsewhere = blocked = offerDismissed = resuming = remembered = false
    key = undefined
    if (checked.store) {
      try {
        key = await keptKey(checked.store)
      } catch {
        // keeping isn't offered
      }
      delete checked.store
    }
    // What this device kept for the inbox, if anything.
    if (key) {
      try {
        const rec = await readKept(key.name) // tried again on a hiccup (kept.ts)
        if (run !== opened) return 'ok'
        if (rec !== undefined) {
          box = Mailbox.fromKept(await unseal(key, rec), INBOX_FILES)
          const dropped = box.dropExpiredLinks()
          if ((await startKeeping(false)) && dropped) changed()
        }
      } catch (e) {
        // Left as it is, never overwritten: it may be from a newer version of Slynk.
        if (e instanceof KeptError && e.code === 'unreadable') blocked = true
        else {
          // The browser's storage didn't answer, three times: it may well keep this inbox, so don't offer
          // to keep it as if it didn't (that offer was seen on a kept inbox). Say so instead.
          offerDismissed = true
          deps.toast(copy.KEEP_READ_FAILED)
        }
      }
    }
    if (run !== opened) return 'ok'
    // A backup's messages: joined to what's kept here, which wins where both
    // hold one, and kept here with them (opts.keep).
    let restored: number | undefined
    if (opts.restore) {
      // Counted as the messages it added: merging applies the backup's removals too.
      const had = new Set(box.all().map((i) => i.id))
      box.merge(opts.restore)
      box.dropExpiredLinks()
      restored = box.all().filter((i) => !had.has(i.id)).length
      changed()
    }
    // The site's welcome at the bottom, unless the owner removed it (kept here, it stays removed).
    box.addWelcome()
    if (!box.label && opts.label) {
      box.label = cleanName(opts.label)
      changed()
    }
    // Share opens first on the address chosen as it was made.
    if (opts.qs !== undefined && box.sharesQs !== opts.qs) {
      box.sharesQs = opts.qs
      changed()
    }
    if (opts.keep && !kept()) await startKeeping(true)
    if (run !== opened) return 'ok'
    // "Remember my passphrase on this device", asked for as it opened (only where it's kept here).
    if (opts.remember && !(key && keeping)) deps.toast(copy.REMEMBER_SKIPPED)
    if (key) {
      if (opts.remember && keeping) await storeWords(words, opts.password)
      else {
        try {
          remembered = await wordsRemembered(key.name)
        } catch {
          remembered = false
        }
      }
      if (run !== opened) return 'ok'
    }
    hideShare()
    $('ib-lock-ask').hidden = true
    $('ib-forget-ask').hidden = true
    $('ib-words-ask').hidden = true
    closeRemember(false)
    renameBox.hidden = true
    renderLabel()
    renderKeep()
    render()
    status()
    deps.changed(info)
    deps.whenReady(connected)
    deps.ensureConnected()
    // Last, so it's the toast that shows: if this device couldn't keep the inbox (another tab has it open,
    // or its storage failed), the messages are only in this tab, and it says so.
    if (restored !== undefined) deps.toast(keeping ? copy.RESTORED(restored) : copy.RESTORED_TAB(restored))
    return 'ok'
  }

  async function connected() {
    const words = opening
    if (!words || !info) return
    const core = deps.core()
    core.onEvent = onEvent
    const plan = box.lookbackPlan()
    resuming = plan.skipTo !== undefined
    try {
      await core.inboxOpen(words, plan)
      if (core === deps.core()) opening = undefined
    } catch (e) {
      if (core === deps.core()) failed = e instanceof Error ? e.message : String(e)
    }
    status()
    deps.includeChanged()
  }

  $('ib-retry').addEventListener('click', () => {
    if (!info) return
    failed = ''
    status()
    deps.whenReady(connected)
    if (deps.net().state === 'error') deps.retryConnect()
  })

  // --- Share and Lock ------------------------------------------------------------------

  function hideShare() {
    $('ib-share-box').hidden = true
    drawn++
    $('ib-qr').replaceChildren()
    $('ib-share').textContent = copy.OWNER_SHARE
    $('ib-share').setAttribute('aria-expanded', 'false')
  }

  /**
   * Closes what the inbox's heading opened (Share, Rename, the Lock and
   * Forget questions): they belong to the list, so going anywhere else
   * closes them (otherwise Share was still open on coming back).
   */
  function closeHeadPanels() {
    hideShare()
    closeNew(false)
    renameBox.hidden = true
    $('ib-lock-ask').hidden = true
    $('ib-forget-ask').hidden = true
    $('ib-words-ask').hidden = true
    closeRemember(false)
    closeSaveFile(false)
    closeBlocked(false)
    closeMarks() // a marker's note too
  }

  /** The address Share gives: the one shared last, or chosen as it was made. */
  const sharedAddress = () => (info ? (box.sharesQs ? info.address4 : info.address) : undefined)
  let drawn = 0 // bumps on every fill, so a slow QR code doesn't land after a switch of tabs

  async function fillShare() {
    const address = sharedAddress()
    if (!address) return
    $<HTMLInputElement>('ib-link').value = inboxLink(LINK_ORIGIN, address)
    const qr = $('ib-qr')
    qr.classList.toggle('dense', isQuantumSafe(address))
    const run = ++drawn
    try {
      await drawQr(qr, inboxQrText(LINK_ORIGIN, address), () => run === drawn && !$('ib-share-box').hidden)
    } catch {
      if (run === drawn) qr.replaceChildren()
    }
  }

  $('ib-share').addEventListener('click', async () => {
    if (!info) return
    if (!$('ib-share-box').hidden) return hideShare()
    $('ib-share-box').hidden = false
    $('ib-share').textContent = copy.OWNER_HIDE_SHARE
    $('ib-share').setAttribute('aria-expanded', 'true')
    renderShareTabs()
    await fillShare()
  })
  $('ib-copy').addEventListener('click', () => void copyText($<HTMLInputElement>('ib-link').value, 'Link copied', deps.toast, $<HTMLInputElement>('ib-link')))
  // The same printable code as after creating the inbox, for posters and leaflets.
  $('ib-save-qr').addEventListener('click', async () => {
    const address = sharedAddress()
    if (address) saveBlob(await qrSvgFile(inboxQrText(LINK_ORIGIN, address)), copy.READY_QR_FILE(isQuantumSafe(address)))
  })
  $('ib-link').addEventListener('focus', () => $<HTMLInputElement>('ib-link').select())

  /** Something Lock would cut short: a send, a collect, a notice still to go, or a reply on its way. */
  /**
   * Why Lock must wait, or '': something under way that Lock would cut short, or
   * files from the chat that uploaded but whose notice didn't go (Lock would
   * lose their link, so they could never be announced).
   */
  function lockWait(): string {
    if (deps.busy() || deps.pending() || !!collecting || sendingNow > 0) return copy.OWNER_LOCK_BUSY
    return untold() ? copy.OWNER_LOCK_UNTOLD : ''
  }

  $('ib-lock').addEventListener('click', () => {
    const wait = lockWait()
    if (wait) return deps.toast(wait)
    $('ib-lock-text').textContent = copy.OWNER_LOCK_ASK(kept(), remembered)
    $('ib-lock-ask').hidden = false
    $('ib-lock-no').focus()
  })
  $('ib-lock-no').addEventListener('click', () => {
    $('ib-lock-ask').hidden = true
    $('ib-lock').focus()
  })
  $('ib-lock-ask').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') $('ib-lock-no').click()
  })
  $('ib-lock-yes').addEventListener('click', () => {
    const wait = lockWait()
    if (wait) return deps.toast(wait)
    lock()
    deps.toast(copy.OWNER_LOCKED)
  })

  /** Closes the inbox: what's kept is written one last time, its messages are wiped and the worker holding its key ends. */
  function lock() {
    if (!info) return
    opened++
    markCovered() // live messages since the look-back count too, if nothing is missing
    closeShowWords() // the words, if shown, leave the page with the inbox
    if (keeping) {
      const rel = release
      release = undefined
      releasing = save().finally(() => rel?.())
      keeping = saveOnShow = false
    } else stopKeeping()
    elsewhere = blocked = remembered = false
    closeRemember(false)
    closeSaveFile(false)
    closeBlocked(false)
    closeScan()
    key = undefined
    info = undefined
    opening = undefined
    lookback = undefined
    failed = ''
    wipeMessages()
    hideShare()
    $<HTMLInputElement>('ib-link').value = ''
    $('ib-name').textContent = ''
    deps.replaceCore()
    deps.changed(undefined)
    deps.bookChanged()
  }

  // --- The open form ------------------------------------------------------------------------

  const wordsBox = $<HTMLInputElement>('oi-words')
  const fileInput = $<HTMLInputElement>('oi-file')
  const filePw = $<HTMLInputElement>('oi-file-pw')
  const keepBox = $<HTMLInputElement>('oi-keep')
  const rememberBox = $<HTMLInputElement>('oi-remember')
  // Remembering the words goes with keeping the inbox: on, it keeps it too. The warnings show at once.
  // Restoring a backup's messages keeps it here too, said under the file.
  // While either needs it, the keep switch is on and fixed; otherwise it shows the owner's own choice,
  // so it goes back to what it was when they're switched off or the file is changed.
  let keepChosen = false
  let fileKeeps = false
  keepBox.addEventListener('change', () => {
    if (!keepBox.disabled) keepChosen = keepBox.checked
  })
  function renderKeepBox() {
    const needed = rememberBox.checked || fileKeeps
    keepBox.checked = keepChosen || needed
    keepBox.disabled = needed
  }
  rememberBox.addEventListener('change', () => {
    $('oi-remember-warn').hidden = !rememberBox.checked
    $('oi-remember-pw-box').hidden = !rememberBox.checked
    renderKeepBox()
  })
  let keyFile: ParsedKeyFile | undefined
  function fileHoldsMessages(holds: boolean) {
    fileKeeps = holds
    $('oi-file-messages').hidden = !holds
    renderKeepBox()
  }

  function formError(text: string) {
    const el = $('oi-error')
    el.textContent = text
    el.hidden = !text
  }

  fileInput.addEventListener('change', async () => {
    formError('')
    keyFile = undefined
    if (fileKeeps) fileHoldsMessages(false)
    const file = fileInput.files?.[0]
    if (!file) return
    if (file.size > MAX_BACKUP_FILE) return formError(copy.OPEN_NOT_KEY_FILE)
    // Read once: a backup with messages can be megabytes.
    const parsed = parseKeyFile(await file.text())
    if (typeof parsed === 'string') return formError(parsed === 'newer' ? copy.OPEN_NEWER_KEY_FILE : copy.OPEN_NOT_KEY_FILE)
    if (fileInput.files?.[0] !== file) return // another file was chosen meanwhile
    keyFile = parsed
    if (parsed.v === 2) fileHoldsMessages(true)
    filePw.focus()
  })

  async function submit() {
    const go = $<HTMLButtonElement>('oi-go')
    formError('')
    let words = wordsBox.value
    let label = ''
    let restore: Mailbox | undefined
    go.disabled = true
    go.textContent = copy.OPEN_CHECKING
    try {
      // A backup with messages is used even with words typed too: it's what restores them.
      if (keyFile && (!words.trim() || fileKeeps)) {
        let inbox: unknown
        try {
          ;({ words, label, inbox } = await readKeyFile(keyFile, filePw.value))
        } catch (e) {
          return formError(e instanceof KeyFileError && e.code === 'wrong' ? copy.OPEN_WRONG_PASSWORD : copy.OPEN_KEY_FAILED)
        }
        if (inbox) {
          // Kept by a newer version of Slynk, it may hold what this one would lose.
          if ((inbox as { v?: unknown }).v !== 1) return formError(copy.OPEN_NEWER_KEY_FILE)
          restore = Mailbox.fromKept(inbox, INBOX_FILES)
        }
      }
      if (!words.trim()) return formError(copy.OPEN_BAD_WORDS)
      const password = rememberBox.checked ? rememberPassword('oi-remember-pw') : ''
      if (password === undefined) return
      const result = await open(words, { keep: keepBox.checked || rememberBox.checked || !!restore, label, remember: rememberBox.checked, password, restore })
      if (result === 'words') return formError(copy.OPEN_BAD_WORDS)
      if (result === 'already') return formError(copy.OPEN_ALREADY)
      clearForm()
      afterOpen()
    } catch (e) {
      formError(e instanceof Error ? e.message : String(e))
    } finally {
      restore?.wipeAll()
      go.disabled = false
      go.textContent = copy.OPEN_BUTTON
    }
  }

  // The eye's name stays "Show the words", pressed or not; its tooltip says what a click does.
  $('oi-show').setAttribute('aria-label', copy.OPEN_SHOW)
  $('oi-show').title = copy.OPEN_SHOW
  function showWords(show: boolean) {
    wordsBox.type = show ? 'text' : 'password'
    $('oi-show').title = show ? copy.OPEN_HIDE : copy.OPEN_SHOW
    $('oi-show').setAttribute('aria-pressed', String(show))
  }
  $('oi-show').addEventListener('click', () => {
    showWords(wordsBox.type === 'password')
    wordsBox.focus()
  })

  function clearForm() {
    wordsBox.value = ''
    showWords(false)
    filePw.value = ''
    fileInput.value = ''
    keepChosen = fileKeeps = false
    keepBox.checked = false
    keepBox.disabled = false
    $('oi-file-messages').hidden = true
    rememberBox.checked = false
    $('oi-remember-warn').hidden = true
    $('oi-remember-pw-box').hidden = true
    resetRememberPassword('oi-remember-pw')
    keyFile = undefined
    $<HTMLDetailsElement>('oi-file-opts').open = false
    formError('')
  }

  let afterOpen = () => {}

  /**
   * Opens an inbox whose words this device remembers. Words remembered with a password need it:
   * 'password' says so (none given), 'wrong' that it didn't open them.
   */
  async function openRemembered(name: string, password?: string): Promise<'ok' | 'failed' | 'already' | 'password' | 'wrong'> {
    let found: Awaited<ReturnType<typeof readWords>>
    try {
      found = await readWords(name)
    } catch {
      // as if there were none
    }
    if (!found) return 'failed'
    let words: string
    if ('words' in found) words = found.words
    else {
      if (!password) return 'password'
      try {
        words = await openSealedWords(found.sealed, password)
      } catch (e) {
        if (e instanceof KeyFileError && e.code === 'wrong') return 'wrong'
        throw e
      }
    }
    const result = await open(words, { keep: true })
    if (result === 'words') return 'failed'
    if (result === 'already') return 'already'
    clearForm()
    afterOpen()
    return 'ok'
  }

  let wantPassword = '' // the remembered inbox whose password box takes the focus when the list shows (from the front page)

  /** One remembered inbox on the open screen: a tap, or, remembered with a password, the password and Open. */
  function rememberedEntry({ name, label, password }: Remembered): HTMLElement {
    const shown = label ? isolate(label) : ''
    const run = async (button: HTMLButtonElement, pw?: () => string) => {
      formError('')
      button.disabled = true
      try {
        const result = await openRemembered(name, pw?.())
        if (result === 'failed') formError(copy.OPEN_REMEMBERED_FAILED)
        else if (result === 'already') formError(copy.OPEN_ALREADY)
        return result
      } catch (e) {
        formError(e instanceof Error ? e.message : String(e))
      } finally {
        button.disabled = false
      }
    }
    if (!password) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn primary', textContent: copy.OPEN_REMEMBERED(shown) })
      b.addEventListener('click', () => void run(b))
      return b
    }
    // Asked for here, hidden as it's typed (the words box above is too), with the usual eye.
    const id = `oi-pw-${name.slice(0, 16)}`
    const wrap = Object.assign(document.createElement('div'), { className: 'remembered-pw' })
    wrap.dataset.name = name
    const labelEl = Object.assign(document.createElement('label'), { className: 'opts-label', htmlFor: id, textContent: copy.OPEN_REMEMBERED_PW_LABEL(shown) })
    const row = Object.assign(document.createElement('div'), { className: 'linkbox' })
    const field = Object.assign(document.createElement('span'), { className: 'field-wrap' })
    const input = Object.assign(document.createElement('input'), { id, type: 'password', className: 'pw-input', autocomplete: 'off', spellcheck: false, maxLength: 400 })
    for (const [k, v] of [['autocapitalize', 'none'], ['autocorrect', 'off'], ['data-1p-ignore', ''], ['data-lpignore', 'true']]) input.setAttribute(k, v)
    const eye = Object.assign(document.createElement('button'), { type: 'button', className: 'field-btn eye-btn' })
    eye.setAttribute('aria-controls', id)
    eye.innerHTML = $('oi-show').innerHTML // the same eye, from fixed markup
    const go = Object.assign(document.createElement('button'), { type: 'button', className: 'btn', textContent: copy.OPEN_REMEMBERED_PW_GO })
    const error = Object.assign(document.createElement('p'), { className: 'note pw-error', hidden: true })
    error.setAttribute('role', 'alert')
    field.append(input, eye)
    row.append(field, go)
    wrap.append(labelEl, row, error)
    const submit = async () => {
      if (!input.value) return input.focus()
      error.hidden = true
      go.textContent = copy.OPEN_REMEMBERED_PW_CHECKING
      const result = await run(go, () => input.value)
      go.textContent = copy.OPEN_REMEMBERED_PW_GO
      if (result === 'wrong') {
        error.textContent = copy.OPEN_REMEMBERED_PW_WRONG
        error.hidden = false
        input.select()
      } else if (result === 'ok') input.value = ''
    }
    go.addEventListener('click', () => void submit())
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        void submit()
      }
    })
    input.addEventListener('input', () => (error.hidden = true))
    wireEye(eye, input)
    return wrap
  }

  /** The open screen's list of inboxes this device remembers the words of, each opened with a tap or its password. */
  async function showRemembered() {
    let list: Remembered[] = []
    try {
      list = await rememberedInboxes()
    } catch {
      // none shown
    }
    $('oi-remembered-list').replaceChildren(...list.map(rememberedEntry))
    $('oi-remembered').hidden = !list.length
    const asked = wantPassword && $('oi-remembered-list').querySelector<HTMLElement>(`[data-name="${CSS.escape(wantPassword)}"] input`)
    wantPassword = ''
    // The one asked for from the front page, or the first of them, takes the focus from the empty words box above.
    if (asked) asked.focus()
    else if (list.length && document.activeElement === wordsBox && !wordsBox.value) $('oi-remembered-list').querySelector<HTMLElement>('button, input')?.focus()
  }
  // Unlocked with the button, or Enter in one of its boxes, as a form would be; but not a form, so browsers
  // don't take it for a sign-in and offer to save the passphrase.
  const unlock = () => {
    if (!$<HTMLButtonElement>('oi-go').disabled) void submit()
  }
  $('oi-go').addEventListener('click', unlock)
  $('oi-form').addEventListener('keydown', (e) => {
    const box = e.target
    if (e.key !== 'Enter' || e.isComposing || !(box instanceof HTMLInputElement) || box.type === 'checkbox' || box.type === 'file') return
    e.preventDefault()
    unlock()
  })

  // --- The address book (only while the inbox is kept on this device) --------------------------

  // The address book is only offered where it's saved: not in a second tab with the same inbox.
  const withBook = () => !!info && keeping

  return {
    open,
    lock,
    clearForm,
    openRemembered,
    /** Remembered with a password, opened from the front page: its box takes the focus when the open screen shows. */
    askPassword(name: string) {
      wantPassword = name
    },
    showRemembered,
    isOpen: () => !!info,
    /** This inbox's address, while it's open. */
    address: (): Uint8Array | undefined => info?.address,
    /** Whether this inbox can go with a message now: it's open in the core, whose key proves it. */
    canInclude: () => !!info && !opening && !failed,
    /** Who an inbox is, if it has written to this one with theirs included: as the list shows them. */
    senderLabel(address: Uint8Array): Part[] | undefined {
      if (!info || !box.sender(address)) return undefined
      return whoIs(address)
    },
    /** For the front page's inbox bar: its name, how many messages are unread, and how opening is going. */
    summary(): { label: string; unread: number; state: 'connecting' | 'looking' | 'ready' | 'failed' } {
      const net = deps.net()
      const state = failed || (opening && net.state === 'error') ? 'failed' : opening ? 'connecting' : lookback?.finished ? 'ready' : 'looking'
      return { label: box.label || copy.OWNER_LABEL, unread: box.unread(), state }
    },
    /**
     * A message the owner sent from the composer with this inbox included:
     * it joins the conversation with that inbox. upload: files or
     * a longer message, and its size; files: the files in it, by name and size.
     * reply: it was sealed with the reply keys that inbox gave.
     */
    noteSent(address: Uint8Array, text: string, name: string, at: number, upload?: number, files?: FileNote[], reply = false) {
      if (!info) return
      const x = box.addSent(address, new TextEncoder().encode(text), name, upload, Date.now(), files)
      // Quantum-safe, to a quantum-safe address or as a reply, it carried this inbox's reply keys:
      // their replies come quantum-safe.
      box.sentDone(x.id, at, reply || isQuantumSafe(address))
      changed()
      renderSoon()
    },
    /**
     * Notes a message the owner sent from this tab to another inbox without
     * theirs included (at: its round's time): in Inbox, so they can check it
     * later. Reports whether it was noted (an inbox is open, and not full).
     */
    noteMine(address: Uint8Array, text: string, at: number, upload?: number, files?: FileNote[]): boolean {
      if (!info) return false
      const i = box.addMine(address, new TextEncoder().encode(text), at, upload, files, Date.now())
      if (!i) return false
      fresh.add(i.id)
      changed()
      renderSoon()
      return true
    },
    /** The name last shown to an inbox, written to with this one included (kept with it, when it's kept). */
    shownTo: (address: Uint8Array): string => (info ? box.shownTo(address) : ''),
    /** The reply keys an inbox gave this one, as a copy to wipe once sent, while it's open. */
    replyKeysFor: (address: Uint8Array): Uint8Array | undefined => (info ? box.replyKeysFor(address) : undefined),
    hasReplyKeys: (address: Uint8Array): boolean => !!info && box.hasReplyKeys(address),
    setShownTo(address: Uint8Array, name: string) {
      if (info && box.setShownTo(address, name)) changed()
    },
    /** The inbox's screen has come into sight: what's shown is drawn afresh (a conversation left open is seen). */
    shown() {
      if (!info) return
      stickToEnd = !!chatWith
      render()
    },
    /** The inbox's screen has gone (the front page, a link): what its heading opened closes. */
    left() {
      closeMenus()
      closeHeadPanels()
    },
    /** The focus, on coming into the inbox's screen: the open conversation, or how opening is going. */
    focus() {
      ;(chatWith ? $('ib-c-name') : $('ib-status')).focus({ preventScroll: true })
    },
    /** Back left a conversation, or Forward came back to one (its inbox, in hex). */
    historyChat(key: string | undefined) {
      if (!info) return
      if (!key) return closeChat(undefined, true)
      if (chatWith && inboxKey(chatWith) === key) return
      const t = box.rows(box.threadFolder(fromHexKey(key))).find((r) => r.kind === 'thread' && r.key === key)
      if (t?.kind === 'thread') {
        folder = box.threadFolder(t.address)
        openChat(t.address)
      }
    },
    /** The open conversation's inbox, in hex, if one is open. */
    chatKey: (): string | undefined => (info && chatWith ? inboxKey(chatWith) : undefined),
    /** A reply of the owner's is on its way, or waiting its turn: closing the tab would lose it. */
    unsent: () => sendingNow > 0 || untold(),
    /** Files from the chat still to upload: a link's send or collection waits for them. */
    uploading: () => uploadsWaiting(),
    /** Whether files dropped on the inbox's screen now would go somewhere: into the open conversation's reply. */
    takesFiles: () => INBOX_FILES && !!info && !!chatWith && !box.isBlocked(chatWith),
    /** Files dropped on the inbox's screen: into the open conversation's reply. */
    dropFiles(files: File[]) {
      if (INBOX_FILES && info && chatWith) addChatFiles(files)
    },
    /** An upload is being collected into the card. */
    isCollecting: () => !!collecting,
    /** The page's connection changed: the card says so while the inbox waits for it. */
    netChanged: () => {
      if (info && opening) status()
    },
    /** What to do once the form has opened the inbox (show the usual page). */
    onOpened(fn: () => void) {
      afterOpen = fn
    },
    /** The owner's address book, or undefined when there's none (the inbox isn't kept on this device). */
    book: (): Contact[] | undefined => (withBook() ? box.book() : undefined),
    contactFor: (address: Uint8Array): Contact | undefined => (withBook() ? box.contactFor(address) : undefined),
    contactNamed: (name: string): Contact | undefined => (withBook() ? box.contactNamed(name) : undefined),
    saveContact(address: Uint8Array, name: string): Contact | 'empty' | 'taken' | 'full' | 'off' {
      if (!withBook()) return 'off'
      const c = box.saveContact(address, name)
      if (typeof c !== 'string') {
        changed()
        deps.bookChanged()
      }
      return c
    },
    removeContact(address: Uint8Array) {
      if (withBook() && box.removeContact(address)) {
        changed()
        deps.bookChanged()
      }
    },
  }
}
