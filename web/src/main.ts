import './style.css'
import { newNonce, prepareShare, protect, reserve, revoke, unlock, wipe, type ProtectResult, type Share } from './burn'
import * as burnCopy from './burnCopy'
import { startCover, stopCover } from './burnCover'
import { Core, errorCode, type InboxInfo, type NetStatus } from './core/client'
import { OPEN_INBOX_ROUTE, inboxRoute, isQuantumSafe, sameInbox, textBytes, textRoom, type InboxRoute } from './inbox/address'
import { fill, fits, pack } from './inbox/pack'
import { setupCreate } from './inbox/create'
import { DROP_LIMIT, fileNoticeBody, needsUpload } from './inbox/drop'
import { fillCopy, fillParts, isolate, part } from './inbox/dom'
import { wireQsWhy } from './inbox/qsWhy'
import { setIcon, setMarker } from './inbox/marker'
import { openCheck } from './inbox/check'
import { openScanFor } from './inbox/scan'
import { qrPngFile, qrSvg } from './inbox/qr'
import * as inboxCopy from './inbox/inboxCopy'
import { setupOwner } from './inbox/owner'
import { PASTE_INBOX_OPEN, PASTE_NOT_A_LINK, SCAN_LINK_WORDS, localCopy, pastedFragment, setMayLeave, wireLocalLinks } from './ui/localLinks'
import { MAX_GIVEN_NAME, cleanGivenName } from './inbox/names'
import { inboxKey, type FileNote } from './inbox/mailbox'
import { countKept, forgetAllKept, rememberedInboxes } from './inbox/kept'
import { coolKdf, warmKdf } from './kdf'
import {
  EXPIRY_HOURS,
  LinkError,
  MAX_TTL_HOURS,
  buildLinkV2,
  linkKindFor,
  linkV2Times,
  parseLinkFragment,
  passwordLinkV1,
  toBase64url,
  type LinkKind,
  type LinkMode,
  type LinkV2,
  type ParsedLink,
} from './linkv2'
import { fetchNdf, probe, sampleGateways } from './netcheck'
import { DAMAGED_TEXT, EnvelopeError, NEWER_TEXT, decode, encode, fileNames, linkSize, linkTimes, linkToFragment, squeeze, store, usesBrotli, usesMany, type Item } from './payload'
import { preloadEverything } from './preload'
import {
  MIN_PASSWORD,
  MAX_PASSWORD,
  lock,
  normalizePassword,
  passwordKey,
  passwordProblem,
  suggestPassword,
  type PasswordKey,
} from './password'
import * as pwCopy from './passwordCopy'
import { checkPassword } from './passwordStep'
import { FILE_PREFIX, INBOX_FILES, ONE_TIME_ONLY, SITE_NAME, opensHere } from './site'
import { LINK_ORIGIN } from './home'
import { atTime, cancelOutcome, optionsSummary, putProblem, reserveProblem, unlockProblem, untilTime } from './ui/linkText'
import { stallText, stoppedText } from './ui/stall'
import { INBOX_FACTS, INBOX_FACTS_QS, INBOX_FACTS_REPLY, INBOX_UPLOAD_FACTS, rotateFacts } from './ui/facts'
import { Eta, ago, capitalize, countLabel, day, duration, piecesText, size } from './ui/format'
import { limitFor, meter } from './ui/meter'
import { flagTab, initTabSignals, titleProgress } from './ui/notify'
import { applyTheme, loadSettings, onSettings, settings, updateSettings, type Settings } from './ui/settings'
import { qualityFor } from './squeeze/index.ts'
import { docKindOf, fileDetails, fileRow, isAudio, isVideo, markSaved, messageRow, saveFile, setHidden } from './ui/items'
import { showWarnings, warningsFor } from './ui/fileWarn'
import * as fileWarnCopy from './fileWarnCopy'
import { askBeforeLeaving, linkedText } from './ui/linkWarn'
import { drawAudioThumb, drawDocThumb, drawVideoThumb, releaseThumb, showAudio, showDoc, showPhoto, showVideo, thumbFor } from './ui/photoView'
import { docPreviewOf } from './docview'
import { tip } from './ui/tip'
import { photoInfo } from './shrink/info'
import { isSvgPicture } from './ui/svgPicture'
import * as shrinkCopy from './shrinkCopy'
import { isAppleTouch, saveBlob } from './ui/save'
import { RECEIVED_SMALLER, RECEIVED_STRIPPED } from './ui/cleaning'
import { SHARE, SHARE_FAILED, asFile, canShare, shareFile } from './ui/share'
import { startSpring } from './ui/spring'
import { createTray, type Compose, type Text } from './tray'
import { safeName } from './zip'
import { zipButtons } from './ui/zipButtons'
import { canKeepScreenOn, keepScreenOn } from './ui/wakeLock'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

loadSettings()
// From the moment the page loads, so slynk.me's visit logs can't tell which
// visitors sent or opened a link (burnCover.ts).
if (settings().coverRequests) startCover()
const spring = startSpring($<HTMLCanvasElement>('spring'))
applyTheme((dark) => spring.setDark(dark))
initTabSignals()

// --- Views -----------------------------------------------------------------------

type View = 'compose' | 'progress' | 'sent' | 'incoming' | 'received' | 'failed' | 'delivered' | 'new-inbox' | 'open-inbox' | 'inbox'
/** The main card's views; 'inbox' is the open inbox's screen of its own. */
const VIEWS: View[] = ['compose', 'progress', 'sent', 'incoming', 'received', 'failed', 'delivered', 'new-inbox', 'open-inbox']
let view: View = 'compose'

/** Called when the page leaves the create-an-inbox flow, which then forgets the new inbox. */
let leftCreate: (() => void) | undefined

function show(next: View) {
  if (view === 'new-inbox' && next !== 'new-inbox') leftCreate?.()
  // Send pressed while typing on a phone: the keyboard is still up. Close it now, as the
  // message box is about to go, and check where the page has ended up once it has.
  const typing = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement
  const keyboard = next !== view && typing && $('card').contains(document.activeElement) && matchMedia('(pointer: coarse)').matches
  if (keyboard) (document.activeElement as HTMLElement).blur()
  const was = view
  view = next
  for (const v of VIEWS) $(`v-${v}`).hidden = v !== next
  if (next === 'sent') renderSentToInbox()
  // The open inbox has a screen of its own: the hero, the main card
  // and what's under it give way to it, and come back after.
  const inbox = next === 'inbox'
  $('card').hidden = inbox
  $('hero').hidden = inbox
  $('inbox-card').hidden = !inbox
  if (inbox) $('how').hidden = true
  else if (was === 'inbox') {
    owner.left()
    // Back to the front page's own hero (a link or a failure sets its own).
    if (next === 'compose' || next === 'delivered') setHero(heroNow())
    // Its step in the history is spent: Back from here leaves the page as usual.
    if (history.state?.slynk === 'inbox') history.replaceState(null, '')
  }
  renderKeptPrompt()
  renderElsewhere()
  if (inbox) {
    toTop()
    // Drawn afresh in sight: a conversation left open shows its newest messages, now seen.
    owner.shown()
  }
  // Back from the inbox's screen (Back, Lock, Forget this device): the front page from its top.
  else if (was === 'inbox') toTop()
  // On a phone, a tall view giving way to a short one (Send, then progress)
  // can leave the card above the screen: bring it back into sight. A closing
  // keyboard can stop that scroll part-way (iPhone), so once it's gone the
  // card is checked again and, if it's still out of sight, jumped to.
  // A link just made (or files delivered to an inbox): the whole card in sight, from its top on
  // a phone, so the link isn't left below the screen's edge.
  else if (next === 'sent' || next === 'delivered') reveal($('card'))
  else {
    reveal($('card'), true)
    if (keyboard) afterKeyboard(() => reveal($('card'), false, true))
  }
}

/**
 * Runs fn once a phone's keyboard has finished closing: when the visible
 * part of the page stops resizing, or soon anyway if it never does.
 */
function afterKeyboard(fn: () => void) {
  const vv = window.visualViewport
  let settle = window.setTimeout(finish, 600)
  const cap = window.setTimeout(finish, 1500)
  const resized = () => {
    clearTimeout(settle)
    settle = window.setTimeout(finish, 150)
  }
  vv?.addEventListener('resize', resized)
  function finish() {
    clearTimeout(settle)
    clearTimeout(cap)
    vv?.removeEventListener('resize', resized)
    fn()
  }
}

/** The inbox's screen, as a step in the browser's history, so Back (a phone's too) returns to the front page. */
function showInbox() {
  if (!owner.isOpen()) return
  if (history.state?.slynk !== 'inbox') {
    history.pushState({ slynk: 'inbox' }, '')
    // A conversation left open is a step of its own again, so Back closes it first.
    const chat = owner.chatKey()
    if (chat) history.pushState({ slynk: 'inbox', chat }, '')
  }
  show('inbox')
}

/** From the inbox's screen to the front page: Back, where the screen was a step of its own. */
function leaveInbox() {
  const step = history.state as Step
  // Past the open conversation's step too, if there is one.
  if (step?.slynk === 'inbox') history.go(step.chat ? -2 : -1)
  else backHome()
}

/** On the front page from the inbox's screen: the focus on the inbox's bar, where it came from. */
function backHome() {
  // The front page itself, not a composer still addressed to an inbox written to earlier,
  // unless something is written there and not yet sent.
  if (addressed && !transferring && !pendingDrop && !textBox.value.trim() && !tray.count()) {
    switchDraft(draftKey(addressed), '') // the link's message, as it was left
    addressed = undefined
    if (coreUse === 'notices') replaceCore()
  }
  goHome()
  if (!$('kept-card').hidden) $('kept-open').focus({ preventScroll: true })
}

/**
 * To the top of the page, between the inbox's screen and the front page. Again a moment later:
 * iPhone Safari can put back the position it remembered for that step in the history after the
 * page has scrolled, despite scrollRestoration (after Forget this device, the page once landed
 * where it had been before the inbox was opened).
 */
function toTop() {
  const was = view
  const run = ++scrollRun
  window.scrollTo({ top: 0, behavior: 'instant' })
  const again = () => {
    if (view === was && run === scrollRun) window.scrollTo({ top: 0, behavior: 'instant' })
  }
  requestAnimationFrame(() => requestAnimationFrame(again))
  window.setTimeout(again, 300)
}

/**
 * Bumps whenever the page decides where to scroll, so the second tries of an
 * earlier decision (toTop's) can't undo a later one: New message from the
 * inbox's screen goes to the top, then straight on to the card (landOnCard).
 */
let scrollRun = 0

/** The inbox's screen in the history: its own step, and one for an open conversation, so Back closes it first. */
type Step = { slynk?: 'inbox'; chat?: string } | null

// A reload starts afresh: an inbox's step left from before doesn't lead back to it.
if ((history.state as Step)?.slynk) history.replaceState(null, '')

// The page's own steps in the history (the inbox's screen, a conversation) say where the page
// scrolls. Left to the browser, Back from the inbox put the front page back where "Open my inbox"
// had been tapped, half way down (seen on an iPhone).
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

window.addEventListener('popstate', () => {
  if (location.hash.length > 1) return // a link or an inbox's page: readLinkFromAddress has it
  const step = history.state as Step
  if (step?.slynk === 'inbox' && owner.isOpen()) {
    // Never away from something that would be lost: a send or collect under way, a link just
    // made, or a one-time item on screen. Its step is spent instead.
    if (view !== 'inbox' && view !== 'compose' && view !== 'delivered' && (transferring || pendingDrop || view === 'sent' || (view === 'received' && onceShown))) {
      history.replaceState(null, '')
      return toast(inboxCopy.NAV_STAY)
    }
    if (view !== 'inbox') show('inbox')
    owner.historyChat(step.chat)
  } else if (view === 'inbox') backHome()
})

/**
 * Scrolls el into sight if it isn't: centred when it fits (otherwise the
 * progress had to be scrolled to the middle every time), else from
 * its top so the start of something tall shows. onlyIfAbove: only when it's
 * gone off the top. instant: a jump, which nothing can stop part-way.
 */
function reveal(el: HTMLElement, onlyIfAbove = false, instant = false) {
  const box = el.getBoundingClientRect()
  if (box.top >= 0 && (onlyIfAbove || box.bottom <= window.innerHeight)) return
  el.scrollIntoView({
    block: box.height < window.innerHeight ? 'center' : 'start',
    behavior: instant ? 'instant' : matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  })
}

let toastTimer = 0
function toast(message: string) {
  const el = $('toast')
  el.textContent = message
  el.classList.add('show')
  clearTimeout(toastTimer)
  // Long enough to read: a longer note stays up longer.
  toastTimer = window.setTimeout(() => el.classList.remove('show'), Math.max(1800, message.length * 60))
}

/**
 * A join that stalled each time it started again with a fresh identity (the core's "stalled",
 * 2026-10-24), as the reason after "Couldn't join the mixnet:" or "Not connected:".
 */
const JOIN_STALLED = 'it stopped making progress, even after starting again with a fresh identity 3 times. Check your internet connection, then try again.'

function errorText(e: unknown): string {
  if (errorCode(e) === 'stalled') return JOIN_STALLED
  return e instanceof Error ? e.message : String(e)
}

// --- Mixnet connection ---------------------------------------------------------------
// Joining the mixnet creates a brand-new identity, and the network admits only so
// many new identities a day for everyone, so the page waits for a sign that the
// visitor means to send or receive (typing, choosing a file, opening a link, or
// clicking the pill). Anything that uses the mixnet waits for the connection.

let core = new Core()
// Everything else a visit might need, fetched for every visitor so the web
// host's logs don't show what anyone did (preload.ts). It waits for the page
// and then the engine, so on a slow connection it never slows them down; if
// the engine fails, or hasn't come in two minutes, it goes anyway.
const pageLoaded = new Promise<void>((done) => (document.readyState === 'complete' ? done() : addEventListener('load', () => done(), { once: true })))
const engineIn = Promise.race([core.ready().catch(() => {}), new Promise((done) => setTimeout(done, 120_000))])
void pageLoaded.then(() => engineIn).then(preloadEverything)
type NetState = 'idle' | 'connecting' | 'ready' | 'error'
let netState: NetState = 'idle'
let netStatus: NetStatus | undefined
let netError = ''
let connectedAt: Date | undefined
let joinPct: number | undefined
let joinStarted = 0 // when this tab's join began (ms)
let pollTimer = 0
const onReadyQueue: (() => void)[] = []

function setNet(state: NetState, text: string) {
  netState = state
  $('net').dataset.state = state
  $('net-text').textContent = text
  updateSendButton()
  describeConnection()
  owner?.netChanged()
}

function whenReady(fn: () => void) {
  if (netState === 'ready') fn()
  else if (!onReadyQueue.includes(fn)) onReadyQueue.push(fn)
}

const STAGES: Record<string, string> = {
  engine: 'Loading engine…',
  network: 'Fetching network map…',
  identity: 'Creating identity…',
}
/** A join that stalled, starting again by itself with a fresh identity (the core's "restart" stage, 2026-10-24). */
const JOIN_RETRYING = 'Trying again…'

/** Starts joining the mixnet unless already connected or on the way. */
function ensureConnected() {
  if (netState === 'idle') void connect()
}

async function connect() {
  setNet('connecting', 'Starting…')
  joinStarted = Date.now()
  const c = core
  if (settings().verbose) c.verbose(true).catch(() => {})
  // Once it has started again, it says so until the fresh identity is registering.
  let retrying = false
  try {
    await c.connect((stage, done, total) => {
      if (c !== core) return
      if (stage === 'nodes') {
        retrying = false
        netStatus = { registered: done, total, healthy: false }
        const pct = Math.min(99, Math.round((done / Math.max(1, total * 0.85)) * 100))
        joinPct = pct
        setNet('connecting', `Joining mixnet ${pct}%`)
        if (view === 'incoming') $('in-status').textContent = `Joining the mixnet to collect it… ${pct}%`
      } else if (stage === 'restart') {
        retrying = true
        joinPct = undefined
        setNet('connecting', JOIN_RETRYING)
        if (view === 'incoming') $('in-status').textContent = inboxCopy.JOIN_SLOW
      } else if (STAGES[stage]) {
        setNet('connecting', retrying ? JOIN_RETRYING : STAGES[stage])
      }
    })
    if (c !== core) return // replaced meanwhile (Lock)
    connectedAt = new Date()
    setNet('ready', 'Connected')
    if (settings().cover) void core.setCover(true)
    await refreshStatus()
    pollTimer = window.setInterval(refreshStatus, 5000)
    onReadyQueue.splice(0).forEach((fn) => fn())
  } catch (e) {
    if (c !== core) return // replaced meanwhile (Lock)
    netError = errorText(e)
    setNet('error', 'Not connected · retry')
    if (view === 'incoming') {
      $('in-status').textContent = `Couldn’t join the mixnet: ${netError}`
      // Tapping again tries again, and a typo in the password can be fixed first.
      if (incoming) incoming.tapped = false
      inPwField.readOnly = false
      $('collect').hidden = false
    }
  }
}

async function refreshStatus() {
  try {
    netStatus = await core.status()
    if (netStatus.healthy) setNet('ready', `Connected · ${netStatus.registered} nodes`)
    else setNet('ready', 'Reconnecting…')
    showCoverCount()
  } catch {
    // The worker is busy or gone; try again on the next tick.
  }
}

/** "12 sent so far" under the Cover messages setting, once any have gone out. */
function showCoverCount() {
  const n = netStatus?.cover ?? 0
  const el = $('s-cover-count')
  el.textContent = `${n} sent so far`
  el.hidden = !settings().cover || !n
}

// --- Which identity does what ------------------------------------------------------------
// Messages to an inbox never go from an identity that makes links or checks
// an inbox, so the mixnet's nodes, which see each message's sender identity,
// can't tie them together. A tab that only writes to inboxes
// uses its one identity for that. When it has done both kinds of thing:
// - an identity that has made links or opened an inbox sends to inboxes from
//   a second identity, which the core connects for the purpose (separate);
// - one that has sent to inboxes is replaced by a fresh one before it makes a
//   link, collects one or opens an inbox.

let coreUse: 'none' | 'links' | 'notices' = 'none'
/** This core's second identity has been asked to connect (warmNotices). */
let noticeWarm = false

/**
 * Someone has started writing to an inbox from a tab whose identity makes
 * links or checks an inbox: the second identity, which the message will go
 * from, connects now rather than at Send (a second connect
 * after "Connected" felt like one too many). Send then needn't wait, and the
 * identity's registration doesn't mark the moment of sending.
 */
function warmNotices() {
  if (noticeWarm || coreUse !== 'links') return
  noticeWarm = true
  const c = core
  c.noticeConnect().catch(() => {
    if (c === core) noticeWarm = false // Send connects it, and says so
  })
}

/** Ends the core's worker (and with it every identity and key it held) and starts afresh. */
function replaceCore() {
  core.close()
  core = new Core()
  coreUse = 'none'
  noticeWarm = false
  clearInterval(pollTimer)
  onReadyQueue.splice(0)
  netStatus = undefined
  connectedAt = undefined
  joinPct = undefined
  netError = ''
  setNet('idle', 'Connects when needed')
}

// --- Restart (Settings) -------------------------------------------------------------------
// A join can stall short of ready (registered with nearly enough nodes, or
// not yet "healthy"). The core starts a stalled join again by itself with a
// fresh identity, up to 3 times (2026-10-24), within 5 minutes in all.
// Settings' Restart starts it again with a fresh identity, without reloading
// the page, so what's written and whatever waits for the join carry on.

/** How long a join may take before Settings offers Restart: it usually takes 12-27 s. */
const SLOW_JOIN_MS = 30_000

/** What Restart would start again: this tab's join, its second identity's (for a message to an inbox), or nothing. */
function restartable(): 'main' | 'separate' | undefined {
  if (netState === 'error') return 'main'
  if (netState === 'connecting') return Date.now() - joinStarted > SLOW_JOIN_MS ? 'main' : undefined
  const since = netStatus?.noticeJoining
  if (netState === 'ready' && since && Date.now() - since > SLOW_JOIN_MS) return 'separate'
  return undefined
}

async function restartConnection() {
  const which = restartable()
  if (which === 'main') {
    // A fresh worker and identity. Nothing has gone from the old one, which never joined, so
    // what was waiting for it (a send, a collect, an inbox opening) waits on, for the same use.
    const waiting = onReadyQueue.splice(0)
    const use = coreUse
    replaceCore()
    coreUse = use
    onReadyQueue.push(...waiting)
    void connect()
  } else if (which === 'separate') {
    // Only the second identity starts again: an inbox open in this tab stays open.
    if (netStatus) netStatus.noticeJoining = Date.now()
    await core.noticeRestart().catch(() => false)
    void refreshStatus()
  }
  describeConnection()
}

/** Readies the identity for links or an inbox check: never one that has sent to inboxes. */
function claimForLinks() {
  if (coreUse === 'notices') replaceCore()
  coreUse = 'links'
}

$('net').addEventListener('click', () => {
  if (netState === 'idle') {
    void connect()
  } else if (netState === 'error') {
    clearInterval(pollTimer)
    void connect()
  } else {
    openSettings(true)
  }
})

// --- Compose -----------------------------------------------------------------------
// One composer: an optional message plus a list of files. Each file is read,
// cleaned of hidden info (when that setting is on) and compressed on its own
// as soon as it's added, so the meter shows exactly what will be sent, and
// adding or removing a file never redoes the others.

let message: (Text & { text: string }) | undefined
const fileList = $('files')
const fileInput = $<HTMLInputElement>('file')
const textBox = $<HTMLTextAreaElement>('text')

const tray = createTray({
  list: fileList,
  fit: $('fit'),
  fitText: $('fit-text'),
  fitGo: $<HTMLButtonElement>('fit-go'),
  compose: () => composeState(),
  limit: () => payloadLimit(),
  // Copies aim for the smallest limit, so turning on a one-time link or a
  // password afterwards can't push it over.
  planLimit: () => limitFor(true, true),
  changed: () => {
    renderCompose()
    readyLink() // when it has finished reading or shrinking something
  },
  added: () => {
    ensureConnected()
    readyLink()
  },
  toast,
  addButton: () => fileInput,
  sendButton: () => $<HTMLButtonElement>('send'),
  openSetting: openSettingAt,
})

/**
 * Starts the next link's puzzle (burn.ts), so it's solved while the person
 * writes: once there's something to send, and while the tray isn't reading
 * or making anything smaller, which on a phone it would compete with. The
 * puzzle runs in a worker of its own; Send waits for it if it hasn't started.
 * Its re-solving every 10 minutes waits for the tray too, and goes on here.
 */
function readyLink() {
  if (addressed || tray.working()) return
  const c = composeState()
  if ((c.files || c.messages) && !c.pending) void prepareShare(() => tray.working())
}

let typingTimer = 0
let messageReady: Promise<void> = Promise.resolve()

/** Packs the message box's text; resolves once the current text is packed. */
function prepareMessage(): Promise<void> {
  clearTimeout(typingTimer)
  const text = textBox.value
  if (message?.text === text) return messageReady
  messageSqueeze?.abort() // for the text as it was
  if (!text) {
    message = undefined
    renderCompose()
    return (messageReady = Promise.resolve())
  }
  const m: NonNullable<typeof message> = { text, data: new TextEncoder().encode(text) }
  message = m
  messageReady = (async () => {
    m.stored = await store(m.data)
    if (message === m) {
      renderCompose()
      squeezeMessage(m)
    }
  })()
  return messageReady
}

let messageSqueeze: AbortController | undefined

/**
 * Brotli's smaller version of the message, if it's made before the message goes: nothing waits
 * for it. One at a time: each pause in typing stops the last (they queued
 * up and held up the files' own).
 */
function squeezeMessage(m: NonNullable<typeof message>) {
  messageSqueeze?.abort()
  const deflated = m.stored
  if (!settings().brotli || !deflated || deflated.method === 'brotli') return
  const stop = (messageSqueeze = new AbortController())
  void squeeze(m.data, deflated, qualityFor(m.data.length), stop.signal)
    .then((better) => {
      if (message !== m || m.stored !== deflated || !settings().brotli) return
      m.stored = better
      renderCompose()
    })
    .catch(() => {})
}

/** Sending has begun: Brotli stops for the message and the files, so it doesn't compete with the upload. */
function stopSqueezing() {
  messageSqueeze?.abort()
  tray.stopSqueezing()
}

textBox.addEventListener('input', () => {
  ensureConnected()
  if (addressed) warmNotices()
  else readyLink()
  if (addressed) renderCompose() // the room left changes with every key
  clearTimeout(typingTimer)
  typingTimer = window.setTimeout(prepareMessage, 200)
})

fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files ?? [])
  fileInput.value = '' // so choosing the same file again still fires
  tray.add(files)
})

// On an iPhone, iOS converts a chosen video before handing it over (15-20 s
// for a minute of it, as measured), and the page hears nothing
// until it's done. If nothing has come a few seconds after the picker opened,
// say so; the line goes when the files come or the picker is cancelled.
const pickWait = $('pick-wait')
let pickTimer = 0
const pickDone = () => {
  clearTimeout(pickTimer)
  pickWait.hidden = true
}
fileInput.addEventListener('click', () => {
  if (!isAppleTouch()) return
  pickDone()
  pickTimer = window.setTimeout(() => {
    pickWait.textContent = shrinkCopy.PICK_WAIT
    pickWait.hidden = false
    pickTimer = window.setTimeout(pickDone, 180_000) // in case no cancel event ever comes
  }, 3000)
})
fileInput.addEventListener('change', pickDone)
fileInput.addEventListener('cancel', pickDone)

// Drag and drop anywhere on the page; never let the browser navigate to a dropped file.
// On the inbox's screen they go into the open conversation's reply (INBOX_FILES).
const drop = $('drop')
window.addEventListener('dragover', (e) => {
  e.preventDefault()
  if (view === 'compose' && (!addressed || INBOX_FILES)) drop.classList.add('drag')
  else if (view === 'inbox' && owner.takesFiles()) $('ib-c-form').classList.add('drag')
})
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return
  drop.classList.remove('drag')
  $('ib-c-form').classList.remove('drag')
})
window.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('drag')
  $('ib-c-form').classList.remove('drag')
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (view === 'compose' && (!addressed || INBOX_FILES)) tray.add(files)
  else if (view === 'inbox') owner.dropFiles(files)
})

/** Everything that would be sent right now: the message and the tray's files. */
function composeState(): Compose {
  return tray.compose(message, textBox.value ? 1 : 0)
}

function renderCompose() {
  if (addressed && !inboxUpload()) return renderInboxCompose()
  const c = composeState()
  $('to-upload-honest').hidden = !addressed
  fileList.hidden = !tray.count()
  drop.classList.toggle('compact', tray.count() > 0)
  $('drop-lead').textContent = tray.count() ? 'Drop more files here' : 'Drop files here'
  const m = meter({
    wire: c.wire,
    files: c.files,
    messages: c.messages,
    varied: settings().variedBatches,
    pending: c.pending,
    limit: payloadLimit(),
    working: tray.working(),
  })
  $('meter-fill').style.width = `${m.fill}%`
  $('meter').toggleAttribute('data-over', m.over)
  $('meter').toggleAttribute('data-working', m.working)
  $('meter-text').textContent = m.text
  $('meter-eta').textContent = m.eta
  // The drop zone's "2 MB in total" link is hidden once files are listed.
  $('meter-why').hidden = c.wire <= payloadLimit() || m.working
  $('meter-working').hidden = !m.working
  tray.renderOffer(c)
  updateSendButton(c)
}

/** Why the composer can't be sent as it is, or '' when it can. */
function blocker(c: Compose): string {
  if (addressed && !inboxUpload()) return inboxBlocker()
  if (addressed && !addressed.checked) return 'Checking the address…'
  if (addressed && including() && !owner.canInclude()) return inboxCopy.INCLUDE_WAIT
  if (!c.files && !c.messages) return 'Write a message or add files'
  const files = tray.blocker(c) // too many, being made smaller, or too large
  if (files) return files
  if (usePassword && !addressed) {
    const problem = passwordProblem(pwField.value)
    if (problem) return problem === 'short' ? pwCopy.TOO_SHORT(MIN_PASSWORD) : pwCopy.TOO_LONG(MAX_PASSWORD)
  }
  return tray.waiting(c)
}

function updateSendButton(c = composeState()) {
  const btn = $<HTMLButtonElement>('send')
  const blocked = blocker(c)
  // A message to an inbox from a second identity doesn't wait for this one;
  // an upload to an inbox goes from this one.
  const mainNeeded = !addressed || inboxUpload() || coreUse !== 'links'
  const waiting = mainNeeded && netState === 'connecting' && !blocked
  let text = addressed?.checked ? inboxCopy.TO_SEND(isolated(nameFor(addressed.address))) : 'Send through the mixnet'
  if (mainNeeded && netState === 'error') text = 'Not connected to the mixnet'
  else if (blocked) text = blocked
  else if (waiting) text = joinPct === undefined ? 'Connecting to the mixnet…' : `Connecting to the mixnet… ${joinPct}%`
  btn.disabled = (mainNeeded && netState === 'error') || !!blocked || waiting
  btn.toggleAttribute('data-waiting', waiting)
  $('send-label').textContent = text
}

// --- Link options --------------------------------------------------------------------------
// One-time and expiring links (burn.ts): slynk.me keeps a random half of the
// key until the link stops working. Password links (password.ts): the
// recipient needs a password too. The choices last for this tab, and the
// closed "Link options" line says what the next link will be. The password
// itself is never stored anywhere.

let expiryHours: number = MAX_TTL_HOURS
let oneTime = ONE_TIME_ONLY // slynk.me's rule (site.ts): no other kind of link
let usePassword = false
const pwField = $<HTMLInputElement>('pw')
const linkKind = (): LinkKind => linkKindFor(expiryHours, oneTime)
/** Each extra layer adds a few bytes, so these links carry slightly less. An upload to an inbox has neither. */
const payloadLimit = () => (addressed ? DROP_LIMIT : limitFor(linkKind() !== 'ordinary', usePassword))

function para(text: string, className = 'note'): HTMLElement {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

function setupLinkOptions() {
  $('opts-title').textContent = burnCopy.OPTIONS_TITLE
  $('one-time-label').textContent = burnCopy.ONE_TIME_LABEL
  $('one-time-help').textContent = burnCopy.ONE_TIME_HELP
  $('expiry').replaceChildren(
    ...EXPIRY_HOURS.map((hours) => {
      const label = document.createElement('label')
      const input = document.createElement('input')
      input.type = 'radio'
      input.name = 'expiry'
      input.value = String(hours)
      input.checked = hours === expiryHours
      input.addEventListener('change', () => {
        expiryHours = hours
        renderLinkOptions()
      })
      const span = document.createElement('span')
      span.textContent = burnCopy.EXPIRY_OPTIONS[hours]
      label.append(input, span)
      return label
    }),
  )
  // With slynk.me's rule, the switch gives way to a line saying why.
  $('one-time').closest('label')!.hidden = ONE_TIME_ONLY
  $('one-time-rule').hidden = !ONE_TIME_ONLY
  $('one-time-rule-text').textContent = burnCopy.ONE_TIME_RULE
  $('one-time-why').textContent = burnCopy.ONE_TIME_WHY
  // Browsers can restore a checkbox's state on reload: the page decides it.
  $<HTMLInputElement>('one-time').checked = oneTime
  $('one-time').addEventListener('change', (e) => {
    oneTime = (e.target as HTMLInputElement).checked
    renderLinkOptions()
  })
  $('pw-label').textContent = pwCopy.PASSWORD_LABEL
  $('pw-help').textContent = pwCopy.PASSWORD_HELP
  $('pw-field-label').textContent = pwCopy.PASSWORD_FIELD
  pwField.placeholder = pwCopy.PLACEHOLDER
  $('pw-new').textContent = pwCopy.NEW_WORDS
  $<HTMLInputElement>('pw-on').checked = usePassword
  pwField.value = ''
  $('pw-on').addEventListener('change', (e) => {
    usePassword = (e.target as HTMLInputElement).checked
    if (usePassword) {
      if (!pwField.value) pwField.value = suggestPassword()
      warmKdf() // so Send doesn't wait for the password module to load
    } else {
      coolKdf()
    }
    renderLinkOptions()
  })
  $('pw-new').addEventListener('click', () => {
    pwField.value = suggestPassword()
    renderCompose()
  })
  $('pw-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pwField.value.trim())
      toast('Password copied')
    } catch {
      pwField.select()
      toast('Press Ctrl+C to copy')
    }
  })
  pwField.addEventListener('input', () => renderCompose())
  renderLinkOptions()
}

function renderLinkOptions() {
  $('pw-box').hidden = !usePassword
  $('opts-now').textContent = optionsSummary(expiryHours, oneTime, usePassword)
  $('expiry-label').textContent = oneTime ? burnCopy.EXPIRY_LABEL_ONE_TIME : burnCopy.EXPIRY_LABEL
  renderCompose()
}

// The time estimate depends on "Uneven uploads" (the tray redoes its files
// when hidden-info removal is turned on or off).
onSettings(() => renderCompose())

// --- Progress (shared by sending and receiving) --------------------------------------------

let stopFacts: (() => void) | undefined
let transferring = false // a send or a collect is under way
// The core runs one download at a time: a link being collected, or an
// upload an inbox's owner is collecting into their card.
let downloading = false

function startProgress(kicker: string, detail: string, facts?: string[]) {
  transferring = true
  show('progress')
  hideStall()
  showStopSend(false)
  $('p-keep').hidden = true
  keepScreenOn(true, () => {
    if (!$('p-keep').hidden) $('p-keep-text').textContent = KEEP_OPEN_SCREEN_TOO
  })
  $('p-kicker').textContent = kicker
  $('p-pct').textContent = '0%'
  $('p-bar').toggleAttribute('data-indeterminate', true)
  $('p-detail').textContent = detail
  spring.setMood('busy')
  stopFacts?.()
  stopFacts = rotateFacts($('fact'), () => netStatus?.total, facts)
  titleProgress(kicker)
}

function updateProgress(kicker: string, done: number, total: number, detail: string) {
  const pct = total ? Math.floor((done / total) * 100) : 0
  const bar = $('p-bar')
  const fill = $('p-fill')
  $('p-pct').textContent = `${pct}%`
  if (done > 0 && bar.hasAttribute('data-indeterminate')) {
    // The waiting sweep is 28% wide: without this the bar shrank from there
    // to the first real figure, as if it had started a fifth of the way in.
    fill.style.transition = 'none'
    fill.style.width = `${pct}%`
    bar.removeAttribute('data-indeterminate')
    void fill.offsetWidth // apply the jump before the transition comes back
    fill.style.transition = ''
  } else {
    bar.toggleAttribute('data-indeterminate', done === 0)
    fill.style.width = `${pct}%`
  }
  $('p-detail').textContent = detail
  titleProgress(`${pct}% ${kicker}`)
}

function endProgress(ok: boolean) {
  transferring = false
  sending = undefined
  showStopSend(false)
  keepScreenOn(false)
  stopFacts?.()
  stopFacts = undefined
  $('p-fill').style.width = '0%'
  spring.setMood(ok ? 'done' : 'idle')
  titleProgress()
}

// A send or collect of a megabyte or more takes minutes, and a phone that locks or switches apps
// pauses it: the progress screen says to keep the page open.
// The screen is kept on for every transfer where the browser allows (ui/wakeLock.ts).
const BIG_TRANSFER = 1_000_000
const KEEP_OPEN = `Keep this page open until it’s done. ${SITE_NAME} keeps the screen on for you.`
const KEEP_OPEN_SCREEN_TOO = 'Keep this page open, with the screen on, until it’s done.'

function showKeepOpen(bytes: number) {
  const big = bytes >= BIG_TRANSFER
  $('p-keep').hidden = !big
  if (big) $('p-keep-text').textContent = canKeepScreenOn() ? KEEP_OPEN : KEEP_OPEN_SCREEN_TOO
}

function pieces(done: number, total: number, eta: Eta, sending: boolean): string {
  return piecesText(done, total, total > 2 ? eta.update(done, total) : undefined, sending)
}

// --- Sending -----------------------------------------------------------------------------

let sendClicked = false

/**
 * The send on the progress screen, until it ends or its sender stops it.
 * share: slynk.me's half of the key, once it holds it, so a stop
 * can take it back. uploading: the core has been given the upload. notice:
 * an upload to an inbox is waiting to tell it (stopping asks the core first,
 * as the notice can't be called back once it starts to go). stopping: that
 * question is out.
 */
interface Sending {
  stopped: boolean
  share?: Share
  uploading: boolean
  notice?: boolean
  stopping?: boolean
}
let sending: Sending | undefined

/** Replies from the inbox's chat on their way: the composer's Send waits for them. */
let replying = 0

async function send() {
  // Replies from the chat first, files from it above all: the core does one transfer at a time.
  if (replying || owner.uploading()) return toast(inboxCopy.CHAT_BUSY)
  if (addressed) return sendToInbox()
  if (sendClicked) return // a double click
  sendClicked = true
  try {
    // In case the last keystrokes are still being packed. Typing during the
    // wait packs again.
    while (textBox.value !== (message?.text ?? '') || (message && !message.stored)) await prepareMessage()
  } finally {
    sendClicked = false
  }
  const c = composeState()
  if (blocker(c)) return
  claimForLinks()
  if (netState === 'idle') {
    // Nothing triggered a connection yet (rare): join now and send once ready.
    whenReady(() => void send())
    ensureConnected()
    return
  }
  if (netState !== 'ready') return
  const kind = linkKind()
  const hours = expiryHours
  // Shown on the sent screen as typed: both ends normalise it before working
  // out the key, so the sender never sees their capitals changed.
  const password = usePassword ? pwField.value.trim() : ''
  const payload = encode(c.packed)
  const many = usesMany(c.packed)
  const brotli = usesBrotli(c.packed)
  stopSqueezing()
  const only = c.packed.length === 1 ? c.packed[0] : undefined
  const what = !only
    ? `${capitalize(countLabel(c.files, c.messages))} · ${size(c.raw)}`
    : only.kind === 'text'
      ? `Your message · ${size(c.raw)}`
      : `${tray.firstName()} · ${size(c.raw)}`
  startProgress('Sending', password ? pwCopy.LOCKING : kind === 'ordinary' ? 'Mixing your first pieces…' : 'Setting up the link…')
  showKeepOpen(payload.length)
  const run: Sending = (sending = { stopped: false, uploading: false })
  showStopSend(true)
  forgetSentLink()
  showSentPassword('')
  // The password's key first: it's the slow part, and slynk.me counts a
  // link's expiry from the moment it's set up below.
  let pk: PasswordKey | undefined
  if (password) {
    try {
      pk = await passwordKey(password)
    } catch {
      if (run.stopped) return
      endProgress(false)
      fail('Sending didn’t finish', pwCopy.LOCK_FAILED, () => show('compose'))
      return
    }
    if (run.stopped) return
    if (kind !== 'ordinary') $('p-detail').textContent = 'Setting up the link…'
  }
  let share: Share | undefined
  let upload = payload
  if (kind !== 'ordinary') {
    // slynk.me counts the expiry from here, so this comes just before the
    // upload; and if slynk.me can't be reached, nothing has been sent yet.
    let protectedPayload: ProtectResult
    try {
      protectedPayload = await protect(payload, kind, hours)
    } catch (e) {
      if (run.stopped) return
      endProgress(false)
      fail('Sending didn’t finish', errorText(e), () => show('compose'))
      return
    }
    if (!protectedPayload.ok) {
      if (run.stopped) return
      endProgress(false)
      const problem = putProblem(protectedPayload.reason)
      fail(problem.title, problem.message, () => show('compose'))
      return
    }
    share = run.share = protectedPayload.share
    upload = protectedPayload.sealed
    // Stopped while slynk.me was being asked: it holds a half-key for nothing.
    if (run.stopped) return dropShare(run)
    $('p-detail').textContent = 'Mixing your first pieces…'
  }
  const eta = new Eta()
  try {
    // Outside the one-time layer, so a recipient's password is checked before
    // slynk.me is asked for its half of the key.
    if (pk) upload = await lock(upload, pk)
    if (run.stopped) return
    run.uploading = true
    const v1 = await core.upload(upload, settings().variedBatches, (_stage, done, total) => {
      if (!run.stopped) updateProgress('Sending', done, total, pieces(done, total, eta, true))
    })
    if (run.stopped) {
      // Finished just as its sender stopped it: nobody gets the link.
      v1.fill(0)
      return
    }
    // Finished while its sender was deciding whether to stop it: the link
    // is theirs, and "Cancel this link" is asked at once where there is one.
    const wasAsking = !$('p-stop-ask').hidden
    endProgress(true)
    let fragment = password ? toBase64url(passwordLinkV1(v1)) : linkToFragment(v1)
    if (share && kind !== 'ordinary') {
      const v2: LinkV2 = { mode: kind, ttlHours: hours, v1, secret: share.L, password: !!password, brotli, many }
      fragment = toBase64url(buildLinkV2(v1, kind, hours, share.L, !!password, brotli, many))
      sentLink = { id: share.id, cancelToken: share.cancelToken, mode: kind, expires: linkV2Times(v2).expires }
      wipe(share.L) // it's in the link now, and nowhere else
    }
    $<HTMLInputElement>('link').value = `${LINK_ORIGIN}/#${fragment}`
    $('sent-what').textContent = `${what} · sent in ${duration(eta.elapsed())}`
    showSentNotes(linkTimes(v1).expires)
    showSentPassword(password)
    hideQr()
    show('sent')
    if (wasAsking && sentLink) $('cancel-link').click()
    if (settings().notify) flagTab('Link ready')
  } catch (e) {
    if (run.stopped) return
    endProgress(false)
    // No link came of it, so take the half-key back off slynk.me.
    dropShare(run)
    fail('Sending didn’t finish', errorText(e), () => show('compose'))
  }
}

/** Takes a send's half-key back off slynk.me when no link came of it. A failure says nothing: the half-key expires anyway. */
function dropShare(run: Sending) {
  const s = run.share
  if (!s) return
  run.share = undefined
  wipe(s.L)
  void revoke(s, { when: 'slot' }).finally(() => wipe(s.cancelToken)) // nobody waits on it: a cover slot will do
}

// --- Stopping a send ---------------------------------------------------------------------------
// xxDK can't take back what it has sent, but our fork drops what's still to
// go. Without the link nobody can read what got out, and the sender never
// gets one. The identity carries on, so an inbox open in this tab stays open.

/** What "Stop sending?" says about a link; an upload to an inbox says its own (inboxCopy). */
const STOP_WHY_LINK = $('p-stop-why').textContent!

/** Cancel at the end of the progress line, only while a link, or files to an inbox, are being sent. */
function showStopSend(on: boolean, inbox = false) {
  $('p-stop-send').hidden = !on
  $('p-stop-ask').hidden = true
  $('p-stop-why').textContent = inbox ? inboxCopy.STOP_WHY : STOP_WHY_LINK
}

$('p-cancel').addEventListener('click', () => {
  $('p-stop-send').hidden = true
  $('p-stop-ask').hidden = false
  $('p-stop-no').focus()
})

$('p-stop-no').addEventListener('click', () => {
  $('p-stop-ask').hidden = true
  $('p-stop-send').hidden = false
  $('p-cancel').focus()
})

$('p-stop-yes').addEventListener('click', async () => {
  const run = sending
  if (!run || run.stopped || run.stopping) return
  if (run.notice) {
    // The message telling the inbox can be stopped only while it waits for its moment.
    run.stopping = true
    const inTime = await core.stopFileNotice().catch(() => false)
    run.stopping = false
    if (sending !== run) return // it finished meanwhile
    if (!inTime) {
      showStopSend(false)
      return toast(inboxCopy.STOP_TOO_LATE)
    }
  }
  run.stopped = true
  if (run.uploading) void core.stopUpload().catch(() => {})
  dropShare(run)
  if (run.notice) forgetPendingDrop()
  endProgress(false)
  // Back to the composer as it was, ready to fix and send again.
  show('compose')
  $('send').focus({ preventScroll: true })
  toast('Sending stopped')
})

// --- One-time and expiring links on the sent screen ------------------------------------------
// Only this screen can cancel the link: the cancel token lives in this tab's
// memory and is wiped when the sender moves on.

let sentLink: { id: Uint8Array; cancelToken: Uint8Array; mode: LinkMode; expires: Date } | undefined

function forgetSentLink() {
  if (sentLink) wipe(sentLink.cancelToken)
  sentLink = undefined
}

/** The notes under the link. until: when the mixnet lets go of an ordinary link. */
function showSentNotes(until: Date) {
  const link = sentLink
  $('sent-ordinary').hidden = !!link
  $('sent-until').textContent = day(until)
  const notes = $('sent-burn')
  notes.hidden = !link
  notes.replaceChildren()
  if (link) {
    if (link.mode === 'one-time') {
      notes.append(para(burnCopy.SENT_ONE_TIME, 'note once'), para(burnCopy.SENT_ONE_TIME_EXPIRY(atTime(link.expires))))
    } else {
      notes.append(para(burnCopy.SENT_EXPIRING(atTime(link.expires))))
    }
  }
  $('cancel').hidden = !link
  $('cancel-link').hidden = false
  $('cancel-ask').hidden = true
  $('cancel-result').hidden = true
  for (const id of ['cancel-yes', 'cancel-no', 'send-another']) $<HTMLButtonElement>(id).disabled = false
  markLinkDead(false)
}

/** A cancelled or used-up link stays on screen, struck through, with Copy and QR off. */
function markLinkDead(dead: boolean) {
  $('link').closest('.linkbox')!.toggleAttribute('data-cancelled', dead)
  $<HTMLInputElement>('link').disabled = dead
  $<HTMLButtonElement>('copy-link').disabled = dead
  if (dead) $('sent-to-inbox').hidden = true
  qrButton.hidden = dead
  if (dead) {
    hideQr()
    showSentPassword('') // no use any more
  }
}

/** The password under the link, so the sender can pass it on; '' hides it. */
function showSentPassword(password: string) {
  $('sent-pw').hidden = !password
  $('sent-and-pw').hidden = !password
  $('sent-pw-label').textContent = pwCopy.SENT_LABEL
  $('sent-pw-note').textContent = pwCopy.SENT_NOTE
  $('sent-pw-value').textContent = password
}

$('cancel-link').addEventListener('click', () => {
  $('cancel-link').hidden = true
  $('cancel-ask').hidden = false
  $('cancel-no').focus()
})

$('cancel-no').addEventListener('click', () => {
  $('cancel-ask').hidden = true
  $('cancel-link').hidden = false
  $('cancel-link').focus()
})

$('cancel-yes').addEventListener('click', async () => {
  const link = sentLink
  if (!link) return
  // Leaving now would lose the answer, so "Send something else" waits too.
  const buttons = ['cancel-yes', 'cancel-no', 'send-another'].map((id) => $<HTMLButtonElement>(id))
  buttons.forEach((b) => (b.disabled = true))
  const result = $('cancel-result')
  result.textContent = 'Cancelling…'
  result.hidden = false
  const outcome = cancelOutcome(await revoke(link), link.mode, link.expires)
  buttons.forEach((b) => (b.disabled = false))
  if (sentLink !== link) return // the sender moved on meanwhile
  $('cancel-ask').hidden = true
  result.textContent = outcome.text
  if (outcome.retry) {
    $('cancel-link').hidden = false
    $('cancel-link').focus()
    return
  }
  // Cancelled, used up or expired: either way the link no longer opens.
  $('cancel').hidden = true
  $('sent-burn').hidden = true
  forgetSentLink()
  markLinkDead(true)
  result.focus()
})

$('send').addEventListener('click', send)

/** "Copy it and go to my inbox": only with an inbox open or kept here, and a link still alive. */
function renderSentToInbox() {
  $('sent-to-inbox').hidden = !(owner?.isOpen() || keptCount > 0) || $<HTMLInputElement>('link').disabled
}

$('sent-to-inbox').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('sent-to-inbox')
  try {
    await navigator.clipboard.writeText($<HTMLInputElement>('link').value)
  } catch {
    // Not copied: stay with the link, so it isn't lost from sight.
    $<HTMLInputElement>('link').select()
    toast('Press Ctrl+C to copy')
    return
  }
  toast(inboxCopy.SENT_TO_INBOX_COPIED)
  backToLink = true
  if (owner.isOpen()) {
    showInbox()
    owner.focus()
    return
  }
  // The one inbox kept here, with its words remembered: straight in, as the bar's Open does.
  if (keptCount === 1 && remembered.length === 1) return void openRememberedHere(remembered[0].name, button)
  location.hash = OPEN_INBOX_ROUTE
})

$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($<HTMLInputElement>('link').value)
    toast('Link copied')
  } catch {
    $<HTMLInputElement>('link').select()
    toast('Press Ctrl+C to copy')
  }
})
$('link').addEventListener('focus', () => $<HTMLInputElement>('link').select())

$('copy-pw').addEventListener('click', async () => {
  const shown = $('sent-pw-value')
  try {
    await navigator.clipboard.writeText(shown.textContent ?? '')
    toast('Password copied')
  } catch {
    getSelection()?.selectAllChildren(shown)
    toast('Press Ctrl+C to copy')
  }
})

function resetCompose() {
  forgetPendingDrop()
  forgetSentLink()
  backToLink = false
  $<HTMLInputElement>('link').value = '' // the link holds the key: don't leave it in the page
  showSentPassword('')
  // A new send gets new words; it's up to the sender to reuse a password.
  pwField.value = usePassword ? suggestPassword() : ''
  fileInput.value = ''
  textBox.value = ''
  message = undefined
  tray.clear()
  renderCompose()
  hideQr()
  setHero(heroNow())
  show('compose')
}

$('send-another').addEventListener('click', resetCompose)

// The QR code is the secret link, so it's drawn only on request, and saved as a
// picture only when the sender asks (to show or print it later, in person), with a
// note on what that picture is.
const qrButton = $<HTMLButtonElement>('show-qr')

function hideQr() {
  $('qr').replaceChildren()
  $('qr-box').hidden = true
  qrButton.textContent = 'Show QR code'
  qrButton.setAttribute('aria-expanded', 'false')
}

qrButton.addEventListener('click', async () => {
  if (!$('qr-box').hidden) return hideQr()
  try {
    $('qr').replaceChildren(qrSvg($<HTMLInputElement>('link').value))
    $('qr-box').hidden = false
    qrButton.textContent = 'Hide QR code'
    qrButton.setAttribute('aria-expanded', 'true')
  } catch (e) {
    qrButton.textContent = `Couldn’t draw the QR code: ${errorText(e)}`
  }
})
$('save-qr').addEventListener('click', async () => {
  const link = $<HTMLInputElement>('link').value
  if (!link) return
  try {
    saveBlob(await qrPngFile(link), `${FILE_PREFIX}-link-qr.png`)
  } catch (e) {
    toast(`Couldn’t save the QR code: ${errorText(e)}`)
  }
})
$('new-send').addEventListener('click', () => {
  forgetReceived()
  resetCompose()
})

// --- Receiving -----------------------------------------------------------------------------

/** A link waiting to be collected, or being collected. */
interface Incoming {
  kind: LinkKind
  v1: Uint8Array // what core.download takes
  sent: Date
  expires: Date // when the page stops opening it
  link?: LinkV2 // one-time and expiring links
  nonce?: Uint8Array // one-time links: this tab's claim nonce, reused for every retry
  sealed?: Uint8Array // downloaded, still to be unlocked
  tapped?: boolean // the recipient pressed Collect it / Open it now for this link
  password: boolean // it's locked with a password (password.ts)
  pwChecked?: boolean // sealed holds what was inside the password layer
  pwText?: string // what the recipient typed, until it has been tried
}

const inPwField = $<HTMLInputElement>('in-pw-field')

let incoming: Incoming | undefined
let received: Item[] = []
let onceShown = false // a one-time link's contents are on screen: they can't be fetched again
let receivedBytes: Uint8Array | undefined // the envelope they came in, wiped with them

const HERO = {
  send: {
    eyebrow: $('hero-eyebrow').textContent!,
    title: [$('hero-title').firstChild!.textContent!, $('hero-title').querySelector('.grad')!.textContent!],
    lede: $('hero-lede').textContent!,
  },
  receive: {
    eyebrow: 'Private delivery',
    title: ['Someone sent you ', 'something.'],
    lede: 'It travelled through the mixnet and is unlocked here, in your\u00a0browser.',
  },
}

type Hero = { eyebrow: string; title: string[]; lede: string }

function setHero(which: keyof typeof HERO | Hero) {
  const h = typeof which === 'string' ? HERO[which] : which
  // The cards under the page describe links (keys that travel in them), so
  // the inbox's own pages leave them out.
  $('how').hidden = typeof which !== 'string'
  $('hero-eyebrow').textContent = h.eyebrow
  const title = $('hero-title')
  title.textContent = h.title[0]
  const grad = document.createElement('span')
  grad.className = 'grad'
  grad.textContent = h.title[1]
  title.append(grad)
  $('hero-lede').textContent = h.lede
}

// A link arrives in the fragment. Read it, then wipe it from the address bar.
// Nothing joins the mixnet until the recipient taps Collect it (or Open it
// now): mail and chat services, and some scanners, open links by themselves.
function readLinkFromAddress(): boolean {
  if (location.hash.length <= 1) return false
  const fragment = location.hash
  history.replaceState(null, '', location.pathname + location.search)
  return openFragment(fragment)
}

/** Opens a link's fragment (#…), from the address bar or pasted into "Received a Slynk link?". */
function openFragment(fragment: string): boolean {
  // A link pasted into the address bar mustn't pull the page from under a
  // transfer, or hide a one-time item that can't be fetched again.
  if (transferring) {
    toast('Wait for this to finish, then open the link again')
    return true
  }
  if (pendingDrop) {
    toast(inboxCopy.UPLOAD_PENDING_NAV)
    return true
  }
  if (view === 'received' && onceShown) {
    toast('Save what’s here first, then open the link again')
    return true
  }
  // With an inbox open here, a link is never collected by this tab's identity, the one checking the
  // inbox: a link in a message opens in a new tab, and this catches a
  // browser that opened it here instead, or one pasted into this tab's address bar. An inbox's
  // address is fine: writing to it goes from an identity of its own.
  if (owner.isOpen() && !inboxRoute(fragment)) {
    toast(inboxCopy.LINK_NOT_HERE)
    return true
  }
  // Leaving the sent screen: its cancel token, link and password go.
  forgetSentLink()
  $<HTMLInputElement>('link').value = ''
  showSentPassword('')
  // Inbox addresses and pages first: an address isn't a link, so neither the
  // link checks nor the one-time rule (site.ts) apply to it, and opening one
  // joins nothing until the visitor writes.
  const route = inboxRoute(fragment)
  if (route) {
    if (incoming) dropIncoming(incoming)
    openInboxRoute(route)
    return true
  }
  // A link is collected, not written to: the composer stops writing to an inbox.
  if (addressed) {
    switchDraft(draftKey(addressed), '')
    addressed = undefined
    applyMode()
  }
  setHero('receive')
  let link: ParsedLink
  try {
    link = parseLinkFragment(fragment)
  } catch (e) {
    if (incoming) dropIncoming(incoming)
    fail('This link doesn’t work', e instanceof LinkError ? e.message : 'It looks damaged or incomplete. Ask the sender to copy it again.')
    return true
  }
  // The same link again keeps its download and, for a one-time link, its
  // claim nonce: a claim whose answer was lost can only be retried with it.
  const same = incoming && sameLink(incoming, link) ? incoming : undefined
  if (incoming && !same) dropIncoming(incoming)
  // slynk.me opens one-time links only (site.ts), and refuses others before
  // anything joins the mixnet.
  if (!opensHere(link.kind)) {
    if (same) dropIncoming(same)
    link.v1.fill(0)
    if (link.kind !== 'ordinary') wipe(link.link.secret)
    fail(burnCopy.NOT_ONE_TIME_TITLE, burnCopy.NOT_ONE_TIME)
    return true
  }
  const { sent, expires } = link
  if (Date.now() >= expires.getTime()) {
    if (same) dropIncoming(same)
    if (link.kind === 'ordinary') {
      fail('This link has expired', `It was sent ${ago(sent)}. The mixnet only holds deliveries for up to three weeks.`)
    } else {
      fail(burnCopy.EXPIRED_TITLE, burnCopy.EXPIRED(ago(expires)))
    }
    return true
  }
  incoming =
    same ??
    (link.kind === 'ordinary'
      ? { kind: link.kind, v1: link.v1, sent, expires, password: link.password }
      : {
          kind: link.kind,
          v1: link.v1,
          sent,
          expires,
          password: link.password,
          link: link.link,
          nonce: link.kind === 'one-time' ? newNonce() : undefined,
        })
  incoming.tapped = false
  showIncoming(incoming)
  return true
}

function sameLink(inc: Incoming, link: ParsedLink): boolean {
  const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i])
  if (inc.kind !== link.kind || inc.password !== link.password || !equal(inc.v1, link.v1)) return false
  return link.kind === 'ordinary' || (!!inc.link && equal(inc.link.secret, link.link.secret))
}

/** It still needs the password typed: it does unless what's held is past the password layer. */
const needsPassword = (inc: Incoming) => inc.password && !(inc.pwChecked && inc.sealed)

function showIncoming(inc: Incoming) {
  const v2 = inc.kind !== 'ordinary'
  $('in-meta').textContent = v2 ? `Sent ${ago(inc.sent)}` : `Sent ${ago(inc.sent)} · available until ${day(inc.expires)} at the latest`
  $('in-once').hidden = inc.kind !== 'one-time'
  $('in-once').textContent = burnCopy.ONE_TIME_BEFORE
  $('in-until').hidden = !v2
  $('in-until').textContent = v2 ? burnCopy.EXPIRING_BEFORE(untilTime(inc.expires)) : ''
  const pw = needsPassword(inc)
  $('in-pw').hidden = !pw
  $('in-pw-note').textContent = pwCopy.NEEDED
  $('in-pw-label').textContent = pwCopy.FIELD_LABEL
  $('in-pw-error').hidden = true
  inPwField.readOnly = false
  if (pw) warmKdf()
  // Downloaded already, with only the password left to try.
  const onlyPassword = pw && !!inc.sealed
  $('collect').textContent = onlyPassword ? pwCopy.UNLOCK_BUTTON : inc.kind === 'one-time' ? burnCopy.OPEN_BUTTON : burnCopy.COLLECT_BUTTON
  $('collect').hidden = false
  updateCollectButton()
  $('in-status').hidden = true
  show('incoming')
}

/** A password link can't be collected until something's typed: without one, joining the mixnet is wasted. */
function updateCollectButton() {
  $<HTMLButtonElement>('collect').disabled = !!incoming && needsPassword(incoming) && !normalizePassword(inPwField.value)
}

// Hidden as it's typed; the eye shows it to check a typo.
// The eye's name stays "Show the password", pressed or not; its tooltip says what a click does.
$('in-pw-show').setAttribute('aria-label', pwCopy.SHOW)
function showInPw(show: boolean) {
  inPwField.type = show ? 'text' : 'password'
  $('in-pw-show').title = show ? pwCopy.STOP_SHOWING : pwCopy.SHOW
  $('in-pw-show').setAttribute('aria-pressed', String(show))
}
showInPw(false)
$('in-pw-show').addEventListener('click', () => {
  showInPw(inPwField.type === 'password')
  inPwField.focus()
})

inPwField.addEventListener('input', updateCollectButton)
inPwField.addEventListener('keydown', (e) => {
  const collect = $<HTMLButtonElement>('collect')
  if (e.key === 'Enter' && !collect.hidden && !collect.disabled) collect.click()
})

// On a phone, the password worker loaded ahead of time can be paused or
// dropped while the visitor is in another app, fetching the password say.
// Close it when the page is hidden, and load a fresh one on the way back.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return coolKdf()
  const waiting = view === 'incoming' && !!incoming && needsPassword(incoming)
  if (waiting || (view === 'compose' && usePassword)) warmKdf()
})

/** Back to the incoming screen, for a new tap. */
function tapAgain(inc: Incoming) {
  inc.tapped = false
  showIncoming(inc)
}

/** The password didn't open it. What was downloaded stays, so trying again is instant. */
function askPasswordAgain(inc: Incoming) {
  inc.tapped = false
  showIncoming(inc)
  const error = $('in-pw-error')
  error.textContent = pwCopy.WRONG
  error.hidden = false
  inPwField.focus()
  inPwField.select()
}

$('collect').addEventListener('click', () => void collect())

async function collect() {
  const inc = incoming
  // Once only: a second run alongside the first would read data it had wiped.
  if (!inc || inc.tapped) return
  // The core runs one download at a time: an owner may be collecting into their inbox,
  // or have files from their inbox's chat still to upload.
  if (downloading) return toast(inboxCopy.DROP_WAIT_LINK)
  if (owner.uploading()) return toast(inboxCopy.CHAT_UPLOAD_BUSY)
  if (needsPassword(inc)) {
    const typed = normalizePassword(inPwField.value)
    if (!typed) return
    inc.pwText = typed
    inPwField.readOnly = true
    $('in-pw-error').hidden = true
  }
  inc.tapped = true
  $('collect').hidden = true
  if (inc.sealed) {
    // Only the password was left: no need for the mixnet.
    void receive()
    return
  }
  const status = $('in-status')
  status.hidden = false
  status.focus() // the button it replaces had the focus
  // A one-time link is held for this tab first, so anyone else who has it is
  // turned away before joining the mixnet. Nothing is used up yet.
  if (inc.kind === 'one-time') {
    status.textContent = burnCopy.CHECKING
    // Fail closed: without its link and nonce it can't be held, so it isn't collected.
    const held = inc.link && inc.nonce ? await reserve(inc.link, inc.nonce) : ({ ok: false, reason: 'malformed' } as const)
    if (incoming !== inc || !inc.tapped) return // another link replaced it meanwhile
    if (!held.ok) {
      const problem = reserveProblem(held.reason, inc.expires)
      inc.tapped = false
      if (!problem.retry) dropIncoming(inc)
      // Start over would lose this tab's nonce, and with it a hold that may have got through.
      fail(problem.title, problem.message, problem.retry ? () => tapAgain(inc) : undefined, held.reason !== 'unreachable')
      return
    }
  }
  claimForLinks()
  status.textContent = netState === 'ready' ? 'Collecting it now…' : 'Connecting to the mixnet to collect it…'
  whenReady(receive)
  if (netState === 'error') {
    clearInterval(pollTimer)
    void connect()
  } else {
    ensureConnected()
  }
}

// A download that goes quiet says so (the core's "stalled" stage), and the
// recipient can keep waiting or stop it.
let stalledAt = -1 // pieces received when the notice was last shown
let arrived = 0
let stopping = false

function showStall(done: number, total: number) {
  stalledAt = done
  $('p-stall-text').textContent = stallText(done, total)
  $<HTMLButtonElement>('p-stop').disabled = false
  $('p-stall').hidden = false
}

function hideStall() {
  $('p-stall').hidden = true
}

$('p-wait').addEventListener('click', hideStall)
$('p-stop').addEventListener('click', () => {
  stopping = true
  $<HTMLButtonElement>('p-stop').disabled = true
  void core.stopDownload()
})

async function receive() {
  const inc = incoming
  // Only ever the link on screen, and only once its recipient has tapped: a
  // collect queued for an earlier link (connecting, or a failed connection)
  // never fetches one that arrived later.
  if (!inc?.tapped) return
  // Already downloaded: only the password or the unlock is left (Unlock after
  // a wrong password, or Try again after slynk.me didn't answer).
  if (inc.sealed) return afterDownload(inc, false)
  startProgress('Receiving', 'Collecting pieces from the mixnet…')
  showKeepOpen(linkSize(inc.v1))
  const eta = new Eta()
  stalledAt = -1
  arrived = 0
  stopping = false
  // An owner may have started collecting into their inbox after the tap
  // (while a one-time link was being held, say): the core takes one at a time.
  // Or files from the inbox's chat may be uploading: the same.
  if (downloading || owner.uploading()) {
    $('p-detail').textContent = downloading ? inboxCopy.DROP_LINK_WAITS : inboxCopy.LINK_WAITS_UPLOAD
    while (downloading || owner.uploading()) await new Promise((r) => setTimeout(r, 500))
    $('p-detail').textContent = 'Collecting pieces from the mixnet…'
  }
  let bytes: Uint8Array
  downloading = true
  try {
    bytes = await core.download(inc.v1, (stage, done, total) => {
      if (stage === 'stalled') return showStall(done, total)
      arrived = done
      if (done > stalledAt) hideStall()
      updateProgress('Receiving', done, total, pieces(done, total, eta, false))
    })
    downloading = false
  } catch (e) {
    downloading = false
    endProgress(false)
    // A one-time link is tried again through a fresh tap, which holds it again first.
    const retry = inc.kind === 'one-time' ? () => tapAgain(inc) : receive
    if (stopping) fail('Stopped', stoppedText(arrived), retry)
    else fail('Couldn’t collect it', errorText(e), retry)
    return
  }
  if (inc.password || inc.link) {
    inc.sealed = bytes
    inc.pwChecked = false
    return afterDownload(inc, true)
  }
  await openEnvelope(bytes)
}

/**
 * The password first (it's the outer layer), then slynk.me's half of the key
 * for a one-time or expiring link. A wrong password keeps the download and
 * asks again, and never reaches slynk.me, so it can't use up a one-time link.
 */
async function afterDownload(inc: Incoming, inProgress: boolean) {
  if (inc.password && !inc.pwChecked) {
    if (!inProgress) startProgress('Receiving', '')
    inProgress = true
    $('p-detail').textContent = pwCopy.CHECKING
    const step = await checkPassword(inc)
    if (!step.ok) {
      endProgress(false)
      if (step.reason === 'wrong') {
        askPasswordAgain(inc)
      } else if (step.reason === 'failed') {
        // The password module didn't load or run, twice: the download and the
        // typed password are kept for Try again.
        fail(pwCopy.CHECK_FAILED_TITLE, pwCopy.CHECK_FAILED, receive)
      } else {
        // No retry: collecting it again would bring back the same bytes.
        dropIncoming(inc)
        fail('Couldn’t open it', step.reason === 'newer' ? NEWER_TEXT : DAMAGED_TEXT)
      }
      return
    }
    inPwField.value = ''
    showInPw(false)
  }
  if (inc.link) return unlockIncoming(inc, inProgress)
  // An ordinary link: nothing more to unlock.
  const bytes = inc.sealed!
  inc.sealed = undefined
  await openEnvelope(bytes)
}

/**
 * Fetches slynk.me's half of the key for a downloaded one-time or expiring
 * link and opens it. For a one-time link this uses it up, which is why it
 * only ever follows the recipient's tap.
 */
async function unlockIncoming(inc: Incoming, inProgress: boolean) {
  if (!inProgress) startProgress('Receiving', '')
  $('p-detail').textContent = 'Unlocking…'
  const result = await unlock(inc.link!, inc.sealed!, inc.nonce)
  if (!result.ok) {
    endProgress(false)
    const problem = unlockProblem(result.reason, inc.kind as LinkMode, inc.expires)
    if (!problem.retry) dropIncoming(inc)
    // Start over would throw away the nonce that alone can still open a one-time link.
    fail(problem.title, problem.message, problem.retry ? receive : undefined, !(problem.retry && inc.kind === 'one-time'))
    return
  }
  const once = inc.kind === 'one-time'
  dropIncoming(inc)
  await openEnvelope(result.envelope, once)
}

/** Overwrites a link's secrets and its sealed copy, once they're no longer needed. */
function dropIncoming(inc: Incoming) {
  inc.sealed?.fill(0)
  inc.sealed = undefined
  inc.pwText = undefined
  inPwField.value = ''
  showInPw(false)
  coolKdf()
  if (inc.link) wipe(inc.link.secret)
  inc.nonce?.fill(0)
  inc.v1.fill(0) // for an ordinary link, the whole key
  if (incoming === inc) incoming = undefined
}

/** once: a one-time link was just opened, so this is the only chance to keep it. */
async function openEnvelope(bytes: Uint8Array, once = false) {
  try {
    const items = await decode(bytes)
    wipeReceived() // anything collected earlier in this tab
    receivedBytes = bytes
    // Names come from the sender: show and save only cleaned-up ones, so a
    // hidden direction mark can't make "fdp.exe" look like ".pdf".
    received = items.map((i) => (i.kind === 'file' ? { ...i, name: safeName(i.name, '') } : i))
  } catch (e) {
    endProgress(false)
    // This tab couldn't unpack it just now: the same bytes, tried again, may open.
    if (e instanceof EnvelopeError && e.again) {
      let trying = false
      const retry = $<HTMLButtonElement>('f-retry')
      return fail('Couldn’t open it', errorText(e), () => {
        // One try at a time: two would share the same bytes, and the second would wipe the first's.
        if (trying) return
        trying = true
        retry.disabled = true
        void openEnvelope(bytes, once).finally(() => {
          trying = false
          retry.disabled = false
        })
      }, !once)
    }
    // No retry: collecting it again would bring back the same bytes.
    fail('Couldn’t open it', once ? `${errorText(e)} ${burnCopy.ONE_TIME_UNREADABLE}` : errorText(e))
    return
  }
  endProgress(true)
  showReceived(received, once)
  if (settings().notify) flagTab('Ready')
  if (settings().autoSave) void autoSave()
}

// One item looks just as it always has; several get a list.
function showReceived(items: Item[], once = false) {
  $('r-once').hidden = !once
  $('r-once').textContent = once ? burnCopy.ONE_TIME_AFTER : ''
  onceShown = once
  const single = items.length === 1 ? items[0] : undefined
  $('r-file').hidden = single?.kind !== 'file'
  $('r-text').hidden = single?.kind !== 'text'
  $('r-list').hidden = !!single
  if (single?.kind === 'file') {
    $('r-title').textContent = 'Your file is here'
    $('r-name').textContent = single.name || 'Untitled file'
    $('r-size').textContent = fileDetails(single)
    $('r-stripped').textContent = single.smaller ? RECEIVED_SMALLER : RECEIVED_STRIPPED
    $('r-stripped').hidden = !single.stripped && !single.smaller
    $('save').textContent = 'Save file'
    receivedThumb(single)
    void warningsFor(single).then((warnings) => {
      if (received.includes(single)) showWarnings($('r-warns'), warnings)
    })
  } else if (single) {
    $('r-title').textContent = 'Your message is here'
    $('secret-text').replaceChildren(linkedText(new TextDecoder().decode(single.data), 'link'))
    setHidden($('secret'), true)
  } else {
    showList(items)
  }
  offerShare(items)
  show('received')
}

const saveButtons = new Map<Item, HTMLElement>()

function showList(items: Item[]) {
  const files = items.filter((i) => i.kind === 'file').length
  const messages = items.length - files
  $('r-title').textContent = `${capitalize(countLabel(files, messages))} are here`
  saveButtons.clear()
  $('r-items').replaceChildren(
    ...items.map((item) => {
      if (item.kind !== 'file') return messageRow(item, (text) => void copySecret(text), 'link')
      const li = fileRow(item, saveItem, toast)
      saveButtons.set(item, part(li, 'save'))
      return li
    }),
  )
}

function saveItem(item: Item) {
  if (item.kind !== 'file' || !received.includes(item)) return
  saveFile(item)
  if (received.length === 1) $('save').textContent = 'Saved · save again'
  else markSaved(saveButtons.get(item)!, item)
}

// One file saves as itself; two or more as one zip, which also avoids the
// browser asking whether this site may download several files. A file with a
// warning waits for a tap, and so does all of it, the zip holding it:
// its warning is on the screen.
async function autoSave() {
  const files = received.filter((i) => i.kind === 'file')
  if (!files.length) return
  const warned = (await Promise.all(files.map(warningsFor))).some((w) => w.length)
  if (!files.every((f) => received.includes(f))) return // gone meanwhile
  if (warned) toast(fileWarnCopy.AUTO_SAVE_HELD(files.length))
  else if (files.length === 1) saveItem(files[0])
  else $('save-all').click()
}

async function copySecret(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied')
  } catch {
    toast('Couldn’t copy. Reveal it and copy by hand.')
  }
}

/** Overwrites what arrived in this page's memory and takes it off the page. */
function wipeReceived() {
  for (const item of received) item.data.fill(0)
  receivedBytes?.fill(0)
  received = []
  receivedBytes = undefined
  saveButtons.clear()
  receivedThumb(undefined)
  receivedZip.clear()
  $('share').hidden = true
  $('secret-text').textContent = ''
  $('r-name').textContent = ''
  $('r-size').textContent = ''
  $('r-items').replaceChildren()
  showWarnings($('r-warns'), [])
  $('r-once').textContent = ''
  onceShown = false
}

function forgetReceived() {
  wipeReceived()
  if (incoming) dropIncoming(incoming)
  incoming = undefined
}

/**
 * "Show photo, media and document previews": a single photo that arrived, small in place
 * of its icon, or a still from a video. The picture, or its name, open it big
 * (a video plays) with a Save button that does what "Save file" does. Nothing
 * is drawn for one this browser can't open.
 */
/** What arrived whose small picture was drawn, or couldn't be. */
let receivedTried: Item | undefined

function receivedThumb(item: Item | undefined) {
  const thumb = $('r-thumb')
  thumb.hidden = true
  $('r-icon').classList.remove('has-thumb')
  $('r-file').classList.remove('previewable')
  releaseThumb(thumb.querySelector('canvas')!)
  // A PDF, or a document shown as its text (RTF, 2026-10-24; Word and LibreOffice Writer, 2026-10-25).
  const audio = !!item && !isVideo(item.data) && isAudio(item.data)
  const doc = item && !isVideo(item.data) && !audio ? docPreviewOf(item.data) : null
  if (!item || !settings().photoPreviews || !(photoInfo(item.data) || isSvgPicture(item.data) || isVideo(item.data) || doc || audio)) return
  thumb.setAttribute('aria-label', shrinkCopy.PREVIEW_RECEIVED(item.name || 'Untitled file'))
  const canvas = thumb.querySelector('canvas')!
  void (isVideo(item.data) ? drawVideoThumb(canvas, item.data, item.type) : audio ? drawAudioThumb(canvas, item.data) : doc ? drawDocThumb(canvas, item.data, doc) : thumbFor(canvas, item.data, item.type)).then((ok) => {
    if (received[0] !== item) return // gone or replaced meanwhile
    receivedTried = item
    thumb.hidden = !ok
    $('r-icon').classList.toggle('has-thumb', ok)
    $('r-file').classList.toggle('previewable', ok)
  })
}

function previewReceived() {
  const item = received[0]
  if (item?.kind !== 'file') return
  // A PowerPoint or Excel file says it can't be shown here, as does an
  // RTF, Word or Writer document with no text to show, once its small picture couldn't be drawn.
  if (!$('r-file').classList.contains('previewable')) {
    const textWaiting = !!docPreviewOf(item.data) && receivedTried !== item
    if (settings().photoPreviews && docKindOf(item.data) === 'office' && !textWaiting) tip($('r-meta'), shrinkCopy.DOC_NO_PREVIEW_RECEIVED)
    return
  }
  const share = canShare(asFile(item)) ? () => void shareReceived(item) : undefined
  const name = item.name || 'Untitled file'
  const actions = { save: () => saveItem(item), share }
  const audio = !isVideo(item.data) && isAudio(item.data)
  const doc = isVideo(item.data) || audio ? null : docPreviewOf(item.data)
  if (doc) void showDoc(name, item.data, doc, 'received', actions)
  else if (audio) void showAudio(name, item.data, item.type, 'received', actions)
  else void (isVideo(item.data) ? showVideo : showPhoto)(name, item.data, item.type, 'received', actions)
}

// --- Share: a received file straight to another app, where the browser can (ui/share.ts) ----

/** "Save all (.zip)" and "Share all (.zip)" under a list of what arrived (shared with the inbox). */
const receivedZip = zipButtons($<HTMLButtonElement>('save-all'), $<HTMLButtonElement>('share-all'), $('zip-note'), toast)

async function shareReceived(item: Item) {
  if (!received.includes(item)) return
  if ((await shareFile(asFile(item))) === 'failed') toast(SHARE_FAILED)
}

/** Shows Share beside Save, or "Share all" beside "Save all", where this browser can share them. */
function offerShare(items: Item[]) {
  const files = items.filter((i) => i.kind === 'file')
  const single = items.length === 1 ? files[0] : undefined
  $('share').hidden = !single || !canShare(asFile(single))
  if (single) {
    $('share').setAttribute('aria-label', SHARE(single.name || 'Untitled file'))
    $('share').title = SHARE(single.name || 'Untitled file')
  }
  receivedZip.show(items)
}

$('share').addEventListener('click', () => received[0] && void shareReceived(received[0]))
$('r-thumb').addEventListener('click', previewReceived)
$('r-meta').addEventListener('click', previewReceived)

$('save').addEventListener('click', () => received[0] && saveItem(received[0]))
$('reveal').addEventListener('click', () => setHidden($('secret'), false))
$('hide-secret').addEventListener('click', () => setHidden($('secret'), true))
$('copy-secret').addEventListener('click', () => void copySecret($('secret-text').textContent ?? ''))
$('forget').addEventListener('click', () => {
  forgetReceived()
  resetCompose()
  toast('Forgotten')
})

window.addEventListener('hashchange', readLinkFromAddress)

// --- Anonymous inbox ---------------------------------------------------------------------------
// An inbox is a long-lived address anyone can write to. Three
// kinds of visitor: everyone else sees the page as it always was; someone who
// opens an inbox's address gets the composer addressed to it; an owner who
// has opened their inbox gets it in a card above the usual composer, and can
// write to other inboxes too. Text goes as one message, one piece.

/** The inbox the composer is writing to, if any, and whether the core has checked its address yet. */
let addressed: { address: Uint8Array; checked: boolean } | undefined

/**
 * What's being written to each recipient, so a message never turns up in a box for another
 * (a message started for a link once turned up, already written, in
 * New message to an inbox). '' is the link's, and each inbox has its own (inboxKey: either of
 * its addresses). The box holds the current one's; the others wait here, in memory only.
 */
const drafts = new Map<string, string>()
const draftKey = (to: typeof addressed): string => (to ? inboxKey(to.address) : '')

/** The message box passes from the recipient it was for to another: each keeps its own text. */
function switchDraft(from: string, to: string) {
  if (from === to) return
  if (textBox.value) drafts.set(from, textBox.value)
  else drafts.delete(from)
  textBox.value = drafts.get(to) ?? ''
  drafts.delete(to)
  void prepareMessage()
}

/** Whether something written waits in a draft away from the box. */
const draftsWaiting = () => [...drafts.values()].some((t) => t.trim())

/**
 * Whether the address can be taken for the inbox its compact part names: a
 * quantum-safe one only once the core has checked the inbox's signature on
 * it, since until then anyone's ML-KEM key could sit beside a known inbox's
 * key. A compact address is its inbox's key, so it always can.
 */
const confirmed = (to: { address: Uint8Array; checked: boolean }) => to.checked || !isQuantumSafe(to.address)
const PLAIN_PLACEHOLDER = textBox.placeholder

/** The hero for the page as it is now. */
const heroNow = () => (addressed && !owner?.isOpen() ? inboxCopy.HERO_SENDER : 'send')

/** The owner's name for an inbox, from their address book, if they have one. */
const nameFor = (address: Uint8Array): string | undefined => owner?.contactFor(address)?.name
const isolated = (name: string | undefined) => (name ? isolate(name) : undefined)

// --- Replies -------------------------------------------------------------------------------------
// Writing to an inbox with one's own open in this tab, it can go with the
// message ("Let them reply", off by default: anonymous
// stays the default), with a name to show them if they like. The core proves
// it with this inbox's key. Without an inbox open, a quiet line says how to
// get replies: creating or opening one comes back to this composer.

const includeBox = $<HTMLInputElement>('include-on')
const includeName = $<HTMLInputElement>('include-name')
includeName.maxLength = MAX_GIVEN_NAME * 2
includeName.placeholder = inboxCopy.INCLUDE_NAME_PLACEHOLDER

/** Whether the composer can include the owner's inbox: writing to another inbox with it open (either of its own addresses is its own). */
function canOfferInclude(): boolean {
  const own = owner?.address()
  return !!addressed && !!owner?.isOpen() && !(own && sameInbox(addressed.address, own))
}

/** The owner's inbox goes with the message being written. */
const including = () => canOfferInclude() && includeBox.checked

/** The name to show, cleaned as the recipient's page will clean it. */
const includeAs = () => cleanGivenName(includeName.value)

/**
 * Whether the message would go sealed with the reply keys the inbox written
 * to gave the owner's: with their inbox included, a reply in a
 * conversation that began quantum-safe, however the composer was reached.
 */
const replyWithKeys = () => including() && !!owner?.hasReplyKeys(addressed!.address)

/**
 * How much of one message the text can have, packed (inbox/pack.ts): less the
 * included inbox and its name, and, when it's quantum-safe, this inbox's reply
 * keys; sealed with their keys, as a reply's room.
 */
const noticeRoom = () => (addressed ? textRoom(addressed.address, including() ? { nameBytes: textBytes(includeAs()), reply: replyWithKeys() } : undefined) : 0)

/**
 * The room and how it travels, for the message as it would go now: a reply sealed with keys is one
 * piece. Beside "To an anonymous inbox", its marker: an atom when it would go
 * quantum-safe, to a quantum-safe address or sealed with the reply keys that inbox gave. Beside
 * "To a quantum-safe anonymous inbox", which says so, the atom alone, and the (i) explains.
 */
function renderSize() {
  if (!addressed) return
  // Two pieces, a few seconds apart, so it takes a bit longer.
  const two = isQuantumSafe(addressed.address) && !replyWithKeys()
  $('to-size').textContent = inboxCopy.TO_SIZE(INBOX_FILES, two)
  $('to-honest-qs').hidden = !two
  if (isQuantumSafe(addressed.address)) setIcon($('to-mark'), true)
  else setMarker($('to-mark'), replyWithKeys(), 'sender')
}

function renderInclude() {
  const offer = canOfferInclude()
  $('include').hidden = !offer
  if (!offer) includeBox.checked = false
  $('include-name-box').hidden = !including()
  $('reply-hint').hidden = !addressed || !!owner?.isOpen()
  renderSize()
}

includeBox.addEventListener('change', () => {
  // The name they were last shown, so it doesn't look like a change of name.
  if (includeBox.checked && addressed && !includeName.value) includeName.value = owner.shownTo(addressed.address)
  renderInclude()
  renderCompose()
  if (includeBox.checked) includeName.focus()
})
includeName.addEventListener('input', () => renderCompose())

/** Shows or hides what differs between writing to an inbox and making a link. */
function applyMode() {
  const to = addressed
  $('to-inbox').hidden = !to
  $('to-after').hidden = !to
  renderElsewhere()
  drop.hidden = !!to && !INBOX_FILES
  $('open-link').hidden = !localCopy || !!to
  $('link-opts').hidden = !!to
  textBox.placeholder = to ? inboxCopy.TO_PLACEHOLDER : PLAIN_PLACEHOLDER
  $('text-label').textContent = to && !INBOX_FILES ? 'Message' : 'Message (optional)'
  if (to) {
    // No codename: the link is the address, and only an owner's own address book names it,
    // or, replying, how their list shows the sender, once it's confirmed.
    const known = confirmed(to)
    const name = known ? nameFor(to.address) : undefined
    const theirs = known ? owner?.senderLabel(to.address) : undefined
    fillParts($('to-name'), name ? [{ name }] : (theirs ?? []))
    $('to-name').hidden = !name && !theirs
    $('to-check-text').textContent = theirs ? inboxCopy.TO_REPLYING : inboxCopy.TO_CHECK
    // "Check it." follows the line asking them to check; a reply's address came with their message.
    $('to-check-it').hidden = !!theirs
    // With files off, as on slynk.me: messages only, and why.
    const qs = isQuantumSafe(to.address)
    $('to-label').textContent = qs ? inboxCopy.TO_LABEL_QS : inboxCopy.TO_LABEL
    renderSize()
    $('to-qs').hidden = !qs
    $('to-only').hidden = INBOX_FILES
    $('to-links').hidden = !!name || !owner?.book() || !known
    if ($('to-links').hidden) showSaveForm(false)
  }
  renderInclude()
  renderKeptPrompt()
  renderCompose()
}

// --- An inbox kept on this device: open it, or forget it ------------------------------------
// The owner asked to keep it, so the main page says so and offers to
// open it (the words box, which a password manager may fill) or forget it.
// Without the words the page can't tell which inbox it is or read it, only
// count what's kept. Shown on the plain composer, never to someone writing to
// an inbox or collecting a link.

let keptCount = 0
/** Kept inboxes whose words are remembered here ("Remember my passphrase"): their record's name and label. */
let remembered: { name: string; label: string }[] = []

function renderKeptPrompt() {
  if (view === 'sent') renderSentToInbox()
  const open = !!owner?.isOpen()
  const plain = view === 'compose' && !addressed && !open
  // While the inbox is open in this tab, the bar is on the front page whatever it's doing, and goes straight in.
  const show = open ? view === 'compose' || view === 'delivered' : keptCount > 0 && plain
  // The way in, under the main card: only while no inbox is open or kept here (the kept one has its bar above).
  $('inbox-entry').hidden = !plain || keptCount > 0
  renderInboxLinks()
  $('kept-card').hidden = !show
  $('kept-card').toggleAttribute('data-open', open)
  $('kept-forget').hidden = open
  if (!show) return
  if (open) {
    renderNamed([])
    $('kept-open').hidden = false
    $('kept-open').classList.add('grad-btn')
    const s = owner.summary()
    // The same two parts each time, changed only when what they say changes: the count is a live status.
    let name = $('kept-text').querySelector('strong')
    let state = $('kept-text').querySelector<HTMLElement>('.bar-state')
    if (!name || !state) {
      name = document.createElement('strong')
      state = Object.assign(document.createElement('span'), { className: 'bar-state' })
      state.setAttribute('role', 'status')
      $('kept-text').replaceChildren(name, state)
    }
    const said = s.state === 'failed' ? inboxCopy.BAR_FAILED : s.unread ? inboxCopy.BAR_NEW(s.unread) : s.state === 'ready' ? inboxCopy.BAR_NONE : inboxCopy.BAR_CHECKING
    if (name.textContent !== s.label) name.textContent = s.label
    if (state.textContent !== said) state.textContent = said
    state.toggleAttribute('data-new', s.unread > 0)
    $('kept-open').textContent = inboxCopy.BAR_OPEN
    $('kept-open').setAttribute('aria-label', inboxCopy.BAR_OPEN_LABEL)
    $('kept-ask').hidden = true
    return
  }
  $('kept-open').removeAttribute('aria-label')
  $('kept-text').textContent = inboxCopy.KEPT_HERE(keptCount)
  // Several kept: those whose words are remembered by name, one tap each, and "Open another" for the
  // rest. The others can't be named without their words.
  const named = keptCount > 1 ? remembered : []
  renderNamed(named)
  $('kept-open').hidden = named.length > 0 && named.length >= keptCount
  $('kept-open').classList.toggle('grad-btn', !named.length)
  $('kept-open').textContent = named.length ? inboxCopy.KEPT_OPEN_OTHER : inboxCopy.KEPT_OPEN(keptCount)
  $('kept-forget').textContent = inboxCopy.KEPT_FORGET(keptCount)
  $('kept-ask-text').textContent = inboxCopy.KEPT_FORGET_ASK(keptCount, remembered.length > 0)
}

/** The front page's buttons for kept inboxes whose words are remembered, drawn again only when they change. */
let namedShown = ''
function renderNamed(list: { name: string; label: string }[]) {
  const shown = JSON.stringify(list)
  if (shown === namedShown) return
  namedShown = shown
  $('kept-named').replaceChildren(
    ...list.map(({ name, label }) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'btn mini grad-btn kept-name' })
      b.append(Object.assign(document.createElement('span'), { textContent: inboxCopy.OPEN_REMEMBERED(label ? isolate(label) : '') }))
      b.addEventListener('click', () => void openRememberedHere(name, b))
      return b
    }),
  )
}

/** Opens a kept inbox with its remembered words, straight from the front page; otherwise the open screen. */
async function openRememberedHere(name: string, button: HTMLButtonElement) {
  button.disabled = true
  try {
    const result = await owner.openRemembered(name)
    if (result === 'ok') return
    // Remembered with a password: the open screen asks for it.
    if (result === 'password') owner.askPassword(name)
    else toast(result === 'already' ? inboxCopy.OPEN_ALREADY : inboxCopy.OPEN_REMEMBERED_FAILED)
  } catch (e) {
    toast(errorText(e))
  } finally {
    button.disabled = false
  }
  location.hash = OPEN_INBOX_ROUTE
}

/**
 * No second inbox is offered while one is in use, open in this tab or kept on
 * this device: the footer, the reply line and the way in
 * leave "Create an anonymous inbox" out, and the route refuses (openInboxRoute).
 */

function renderInboxLinks() {
  const open = !!owner?.isOpen()
  const inUse = open || keptCount > 0
  $('footer-create').hidden = inUse
  $('footer-open').hidden = open
  $('footer-sep').hidden = inUse || open
  // Where the card under the main one offers both, the footer needn't; nor on the inbox's own
  // screens (creating, opening, the inbox itself), where they'd lead back to where you are.
  const ownScreen = view === 'new-inbox' || view === 'open-inbox' || view === 'inbox'
  $('footer-inbox').hidden = (inUse && open) || !$('inbox-entry').hidden || ownScreen
  // With an inbox kept on this device, no second one is offered: the button opens that one.
  const replyGo = $('reply-hint-go')
  replyGo.textContent = keptCount > 0 ? inboxCopy.REPLY_HINT_OPEN_KEPT : inboxCopy.REPLY_HINT_GET
  replyGo.setAttribute('href', keptCount > 0 ? '#/open-inbox' : '#/new-inbox')
  $('reply-hint-have').hidden = keptCount > 0
}

/** Counts what's kept again: at the start, and when an inbox locks (it may have just been kept or forgotten). */
async function refreshKeptCount() {
  try {
    keptCount = await countKept()
    remembered = await rememberedInboxes()
  } catch {
    keptCount = 0
    remembered = []
  }
  renderKeptPrompt()
}

// While the inbox is open, the whole bar opens it, not only its button: a tap on
// "1 new" opens it too. The button stays the way in for the keyboard and screen readers.
$('kept-card').addEventListener('click', (e) => {
  if (!owner.isOpen() || (e.target as HTMLElement).closest('button, a')) return
  showInbox()
  owner.focus()
})

$('kept-open').addEventListener('click', () => {
  if (!owner.isOpen()) {
    // The one inbox kept here, with its words remembered: straight in, no words to type.
    if (keptCount === 1 && remembered.length === 1) return void openRememberedHere(remembered[0].name, $<HTMLButtonElement>('kept-open'))
    location.hash = OPEN_INBOX_ROUTE
    return
  }
  showInbox()
  owner.focus()
})
$('kept-forget').addEventListener('click', () => {
  $('kept-ask').hidden = false
  $('kept-no').focus()
})
$('kept-no').addEventListener('click', () => {
  $('kept-ask').hidden = true
  $('kept-forget').focus()
})
$('kept-ask').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('kept-no').click()
})
$('kept-yes').addEventListener('click', async () => {
  $('kept-ask').hidden = true
  try {
    await forgetAllKept()
    toast(inboxCopy.FORGOTTEN)
  } catch {
    toast(inboxCopy.KEEP_FAILED)
  }
  await refreshKeptCount()
  textBox.focus()
})

/** The composer's meter and button while it writes to an inbox: room left in one message. */
function renderInboxCompose() {
  const room = noticeRoom()
  // The limit is in bytes, packed; said in characters of the script being typed (inbox/pack.ts).
  const f = fill(textBox.value, room)
  fileList.hidden = !tray.count()
  drop.classList.toggle('compact', tray.count() > 0)
  $('drop-lead').textContent = tray.count() ? 'Drop more files here' : 'Drop files here'
  $('to-upload-honest').hidden = true
  $('meter-fill').style.width = `${Math.min(100, f.over ? 100 : (f.used / room) * 100)}%`
  $('meter').toggleAttribute('data-over', f.over)
  $('meter-text').textContent = f.over ? inboxCopy.TO_OVER(f.chars) : inboxCopy.TO_ROOM(f.chars)
  $('meter-eta').textContent = ''
  $('meter-why').hidden = true
  $('fit').hidden = true
  updateSendButton()
}

/**
 * The composer writes to an inbox with more than one notice can carry:
 * files or a longer message, which go as an upload (INBOX_FILES, site.ts).
 */
function inboxUpload(): boolean {
  return !!addressed && INBOX_FILES && needsUpload(tray.count(), textBox.value, noticeRoom())
}

function inboxBlocker(): string {
  if (!addressed?.checked) return 'Checking the address…'
  if (tray.count()) return inboxCopy.TO_FILES
  if (!textBox.value.trim()) return inboxCopy.TO_WRITE
  if (!fits(textBox.value, noticeRoom())) return inboxCopy.TO_TOO_LONG
  if (including() && !owner.canInclude()) return inboxCopy.INCLUDE_WAIT
  return ''
}

/** Addresses the composer to an inbox. Nothing joins the mixnet until the visitor writes. */
async function addressTo(address: Uint8Array) {
  const again = !!addressed && addressed.address.length === address.length && addressed.address.every((b, i) => b === address[i])
  switchDraft(draftKey(addressed), inboxKey(address))
  addressed = { address, checked: false }
  $<HTMLInputElement>('to-save-field').value = ''
  $('to-save-error').hidden = true
  showSaveForm(false)
  // A new inbox to write to starts anonymous, until "Let them reply" is switched on.
  if (!again) {
    includeBox.checked = false
    includeName.value = ''
  }
  setHero(heroNow())
  applyMode()
  show('compose')
  const to = addressed
  try {
    await core.inboxAddress(address)
    to.checked = true
  } catch {
    if (addressed !== to) return
    switchDraft(draftKey(to), '')
    addressed = undefined
    applyMode()
    setHero(heroNow())
    fail(inboxCopy.TO_BAD_ADDRESS_TITLE, inboxCopy.TO_BAD_ADDRESS)
    return
  }
  if (addressed === to) applyMode()
}

/**
 * After New message (a scan or "Write to it"): the card now addressed to the
 * inbox comes into sight, its "To an anonymous inbox" box lit up for a
 * moment, rather than the top of the page, which on a phone is all headline.
 */
function landOnCard() {
  // Again a moment later, as toTop does: iPhone Safari can put back where the page was.
  const run = ++scrollRun
  const land = () => {
    if (run === scrollRun && view === 'compose') $('card').scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  land()
  requestAnimationFrame(() => requestAnimationFrame(land))
  window.setTimeout(land, 300)
  const to = $('to-inbox')
  to.classList.remove('arrived')
  void to.offsetWidth // so the glow starts again
  to.classList.add('arrived')
  to.addEventListener('animationend', () => to.classList.remove('arrived'), { once: true })
}

/** "Sending something to someone else? Make a link instead", under the card while writing to an inbox. */
function renderElsewhere() {
  $('to-elsewhere').hidden = !(addressed && view === 'compose')
}
$('to-elsewhere-text').textContent = inboxCopy.TO_ELSEWHERE(INBOX_FILES)

/**
 * "Make a link instead": back to the usual composer, with a fresh identity if this one wrote to an inbox.
 * What's written goes with it, as asked (in place of any link message started before); with nothing
 * written, the link's own draft comes back.
 */
function clearAddress() {
  const from = draftKey(addressed)
  if (textBox.value.trim()) {
    drafts.delete(from)
    drafts.delete('')
  } else switchDraft(from, '')
  addressed = undefined
  if (coreUse === 'notices' && !transferring) replaceCore()
  setHero(heroNow())
  applyMode()
  show('compose')
  textBox.focus()
}

async function sendToInbox() {
  if (inboxUpload()) return sendUploadToInbox()
  const to = addressed
  if (!to || transferring || inboxBlocker()) return
  const separate = coreUse === 'links'
  if (!separate) {
    if (netState === 'idle' || netState === 'error') {
      whenReady(() => void send())
      if (netState === 'error') clearInterval(pollTimer)
      if (netState === 'error') void connect()
      else ensureConnected()
      return
    }
    if (netState !== 'ready') return
    coreUse = 'notices'
  }
  const text = textBox.value
  // With the reply keys that inbox gave, if any: a copy, wiped once it has gone.
  const replyKeys = including() ? owner.replyKeysFor(to.address) : undefined
  const include = including() ? { name: includeAs(), ...(replyKeys ? { replyKeys } : {}) } : undefined
  // So a second identity started for this follows the Cover messages setting.
  if (separate) void core.setCover(settings().cover)
  // To a quantum-safe address, two pieces a few seconds apart, each in a round of its own:
  // a reply sealed with keys is one piece.
  const apart = isQuantumSafe(to.address) && !replyKeys
  // Only what's happening: the separate identity says it's being made only when the core
  // connects it, the first time (it once showed on a send that didn't need one).
  const next = apart ? inboxCopy.SENDING_APART : inboxCopy.SENDING_NOW
  startProgress('Sending', next, replyKeys ? INBOX_FACTS_REPLY : apart ? INBOX_FACTS_QS : INBOX_FACTS)
  $('p-pct').textContent = '' // one piece, or two together: there's no percentage to show
  try {
    const at = await core.sendNotice(
      to.address,
      pack(text),
      separate,
      (stage, done, total) => {
        if (stage === 'network' || stage === 'identity') $('p-detail').textContent = inboxCopy.SENDING_SEPARATE
        else if (stage === 'restart') $('p-detail').textContent = inboxCopy.JOIN_SLOW
        else if (stage === 'nodes') $('p-detail').textContent = inboxCopy.SENDING_JOINING(Math.min(99, Math.round((done / Math.max(1, total * 0.85)) * 100)))
        else if (stage === 'ready') $('p-detail').textContent = next
        // Its first piece is delivered: the second follows after a pause, and the screen says so.
        else if (stage === 'apart') $('p-detail').textContent = inboxCopy.SENDING_APART_FIRST
      },
      include,
    )
    endProgress(true)
    if (textBox.value === text) textBox.value = ''
    message = undefined
    if (include) {
      owner.setShownTo(to.address, include.name)
      owner.noteSent(to.address, text, include.name, at, undefined, undefined, !!replyKeys)
    }
    // Without their inbox, it's in no conversation: noted in the inbox open here, if one is.
    const noted = !include && owner.noteMine(to.address, text, at)
    delivered(to.address, !!include, noted)
    $('d-when').textContent = inboxCopy.DELIVERED_WHEN(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    show('delivered')
    if (settings().notify) flagTab('Sent')
  } catch (e) {
    endProgress(false)
    fail('Sending didn’t finish', errorCode(e) === 'unconfirmed' ? inboxCopy.SENDING_UNCONFIRMED : errorText(e), () => show('compose'))
  } finally {
    replyKeys?.fill(0) // the worker has its own copy
  }
}

/** The Delivered screen's title and note: with the sender's inbox included, replies come to it. */
/** noted: sent without their inbox, and noted in the one open in this tab. */
function delivered(to: Uint8Array, included: boolean, noted = false) {
  $('d-title').textContent = inboxCopy.DELIVERED_TITLE(isolated(nameFor(to)))
  $('d-note').textContent = included ? inboxCopy.DELIVERED_NOTE_REPLY : noted ? inboxCopy.DELIVERED_NOTE_MINE : inboxCopy.DELIVERED_NOTE
}

// --- Files and longer messages to an inbox (INBOX_FILES, site.ts) ------------------------------
// The usual package (message and files, cleaned) goes as an ordinary upload
// to a random pickup address, from this tab's identity, never one that has
// sent to inboxes. A notice carrying its plain v1 link then goes from the
// tab's second identity, a random 1 to 3 minutes later, on the beat of
// cover messages (the core: sendFileNotice). Until it has gone, the owner
// can't know the upload is there, so the tab mustn't close.

interface PendingDrop {
  to: NonNullable<typeof addressed>
  v1: Uint8Array // the upload's link, and with it its key
  since: number // when the upload finished
  include?: { name: string } // the owner's inbox goes with the notice
  size: number // what was uploaded, for the owner's side of the conversation
  text: string // and its message, and the files' names and sizes (never the files)
  files: FileNote[]
}
let pendingDrop: PendingDrop | undefined

function forgetPendingDrop() {
  pendingDrop?.v1.fill(0)
  pendingDrop = undefined
}

window.addEventListener('beforeunload', (e) => {
  // A notice still to go, or a reply from the inbox's chat on its way.
  if (pendingDrop || owner.unsent()) e.preventDefault()
})

async function sendUploadToInbox() {
  const to = addressed
  if (!to || transferring || sendClicked) return
  sendClicked = true
  try {
    // In case the last keystrokes are still being packed.
    while (textBox.value !== (message?.text ?? '') || (message && !message.stored)) await prepareMessage()
  } finally {
    sendClicked = false
  }
  const c = composeState()
  if (addressed !== to || !inboxUpload() || blocker(c)) return
  claimForLinks()
  if (netState === 'idle' || netState === 'error') {
    whenReady(() => void send())
    if (netState === 'error') {
      clearInterval(pollTimer)
      void connect()
    } else ensureConnected()
    return
  }
  if (netState !== 'ready') return
  startProgress('Sending', 'Mixing your first pieces…', INBOX_UPLOAD_FACTS)
  const run: Sending = (sending = { stopped: false, uploading: true })
  showStopSend(true, true)
  showKeepOpen(c.wire)
  const eta = new Eta()
  let v1: Uint8Array
  const bytes = encode(c.packed)
  stopSqueezing()
  try {
    v1 = await core.upload(bytes, settings().variedBatches, (_stage, done, total) => {
      if (!run.stopped) updateProgress('Sending', done, total, pieces(done, total, eta, true))
    })
  } catch (e) {
    if (run.stopped) return
    endProgress(false)
    fail('Sending didn’t finish', errorText(e), () => show('compose'))
    return
  }
  if (run.stopped) {
    // Finished just as its sender stopped it: the inbox never hears of it.
    v1.fill(0)
    return
  }
  pendingDrop = { to, v1, since: Date.now(), size: bytes.length, text: message?.text ?? '', files: fileNames(c.packed), ...(including() ? { include: { name: includeAs() } } : {}) }
  await announceUpload(pendingDrop)
}

/** Sends the notice that tells the inbox about the upload. Try again sends only this. */
async function announceUpload(p: PendingDrop) {
  if (pendingDrop !== p) return
  if (!transferring) startProgress('Sending', inboxCopy.UPLOAD_WAITING, INBOX_UPLOAD_FACTS)
  // The upload's own run, or a fresh one when Try again sends only this.
  const run: Sending = (sending ??= { stopped: false, uploading: false })
  run.uploading = false
  run.notice = true
  showStopSend(true, true)
  updateProgress('Sending', 0, 0, inboxCopy.UPLOAD_WAITING)
  $('p-pct').textContent = '' // one piece: there's no percentage to show
  titleProgress('Sending')
  const body = fileNoticeBody(p.v1)
  // With the reply keys that inbox gave, if any, looked up as it goes: a copy, wiped after.
  const replyKeys = p.include ? owner.replyKeysFor(p.to.address) : undefined
  try {
    const at = await core.sendFileNotice(
      p.to.address,
      body,
      p.since,
      (stage, done, total) => {
        if (stage === 'nodes') $('p-detail').textContent = inboxCopy.UPLOAD_JOINING(Math.min(99, Math.round((done / Math.max(1, total * 0.85)) * 100)))
        else if (stage === 'restart') $('p-detail').textContent = inboxCopy.UPLOAD_JOIN_SLOW
        else if (stage === 'waiting') $('p-detail').textContent = inboxCopy.UPLOAD_WAITING
      },
      p.include && { ...p.include, ...(replyKeys ? { replyKeys } : {}) },
    )
    if (pendingDrop !== p || run.stopped) return
    endProgress(true)
    forgetPendingDrop()
    resetCompose() // what was sent leaves the composer
    if (p.include) {
      owner.setShownTo(p.to.address, p.include.name)
      owner.noteSent(p.to.address, p.text, p.include.name, at, p.size, p.files, !!replyKeys)
    }
    const noted = !p.include && owner.noteMine(p.to.address, p.text, at, p.size, p.files)
    delivered(p.to.address, !!p.include, noted)
    $('d-when').textContent = inboxCopy.DELIVERED_WHEN(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    show('delivered')
    if (settings().notify) flagTab('Sent')
  } catch (e) {
    if (pendingDrop !== p || run.stopped || errorCode(e) === 'stopped') return
    endProgress(false)
    const code = errorCode(e)
    const why = code === 'unconfirmed' ? inboxCopy.UPLOAD_UNCONFIRMED : code === 'undelivered' ? inboxCopy.UPLOAD_UNDELIVERED : inboxCopy.UPLOAD_NOTICE_FAILED(errorText(e))
    fail('Sending didn’t finish', why, () => void announceUpload(p))
  } finally {
    body.fill(0) // the worker has its own copy
    replyKeys?.fill(0)
  }
}

$('to-clear').addEventListener('click', clearAddress)
$('d-again').addEventListener('click', () => {
  renderCompose()
  show('compose')
  textBox.focus()
})

// Naming the inbox being written to, in the owner's address book.
/** The address book's form on the sender's card, opened from its link. */
function showSaveForm(show: boolean) {
  $('to-save').hidden = !show
  $('to-save-open').setAttribute('aria-expanded', String(show))
}
$('to-save-open').addEventListener('click', () => {
  const show = $('to-save').hidden === true
  showSaveForm(show)
  if (show) $('to-save-field').focus()
})

/** The inbox's full address on the sender's card, shown on request. */
// "Check its address is correct": a popup that compares the address
// written to with one pasted or scanned from where its owner published it (inbox/check.ts).
$('to-check-go').addEventListener('click', () => {
  if (addressed)
    openCheck(addressed.address, {
      works: (address) =>
        core.inboxAddress(address).then(
          () => true,
          () => false,
        ),
    })
})

/**
 * A short answer in a popup, the About page's longer one a link away (every
 * "why" on the page works this way, so nothing opens a new tab unasked).
 */
function infoSheet(id: string, ...openers: string[]) {
  const sheet = $<HTMLDialogElement>(id)
  for (const opener of openers)
    $(opener).addEventListener('click', (e) => {
      e.preventDefault() // a button in the drop zone's label never opens the file picker
      if (sheet.open) return
      sheet.showModal()
      // The title takes the focus, not the close button: Safari rings a button focused on opening.
      $(`${id}-title`).focus()
    })
  sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => sheet.close()))
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) sheet.close() // click on the backdrop
  })
}
// "2 MB in total" in the drop zone, and "Why only 2 MB?" beside the meter once it's too large.
infoSheet('size-why', 'size-why-go', 'meter-why')
// The footer's "Run locally (download)", there once a release is (scripts/release.ts).
if (document.getElementById('local-why')) infoSheet('local-why', 'local-why-go')
// In a copy run from one's own computer, Slynk's own pages open in its window while leaving loses
// nothing: the front page with nothing written or added, no inbox open and nothing going on.
setMayLeave(() => view === 'compose' && !transferring && !pendingDrop && !owner.isOpen() && !textBox.value.trim() && !draftsWaiting() && !tray.count())
wireLocalLinks()

// "Received a Slynk link? Paste it here.", in a local copy only, whose window
// has no address bar: the link goes the way one from the address bar does, but never into it, so never
// into the browser's history. With an inbox unlocked here, a link isn't collected in this window (as in
// openFragment), and the box says so rather than a toast about tabs the window doesn't have.
function openPasted(text: string) {
  const field = $<HTMLInputElement>('open-link-field')
  const error = $('open-link-error')
  const fragment = pastedFragment(text)
  const problem = !fragment ? PASTE_NOT_A_LINK : owner.isOpen() && !inboxRoute(fragment) ? PASTE_INBOX_OPEN : ''
  error.textContent = problem
  error.hidden = !problem
  if (problem) return field.focus()
  field.value = ''
  openFragment(fragment!)
}
$('open-link').addEventListener('submit', (e) => {
  e.preventDefault()
  openPasted($<HTMLInputElement>('open-link-field').value)
})
// Or its QR code (on a computer, most likely a picture of one), read as
// New message reads an inbox's: in the page, nothing kept, the camera only from this tap.
$('open-link-scan').setAttribute('aria-label', inboxCopy.SCAN_LABEL)
$('open-link-scan').title = inboxCopy.SCAN_LABEL
$('open-link-scan').addEventListener('click', () => openScanFor(pastedFragment, (fragment) => openPasted(fragment), SCAN_LINK_WORDS))
$('open-link-field').addEventListener('input', () => ($('open-link-error').hidden = true))
$('open-link').hidden = !localCopy || !!addressed
// "What's happening?" while photos or videos are made smaller, in the composer and in an inbox's chat.
infoSheet('working-why', 'meter-working', 'ib-c-meter-working')
// "Every Slynk link opens once only. Why?"
$('once-why-title').textContent = burnCopy.ONE_TIME_WHY_TITLE
$('once-why-body').replaceChildren(...burnCopy.ONE_TIME_WHY_TEXT.map((text) => Object.assign(document.createElement('p'), { textContent: text })))
infoSheet('once-why', 'one-time-why')

$('to-save-go').addEventListener('click', () => {
  const to = addressed
  if (!to || !confirmed(to)) return
  const result = owner.saveContact(to.address, $<HTMLInputElement>('to-save-field').value)
  const error = $('to-save-error')
  if (result === 'empty' || result === 'off') return $('to-save-field').focus()
  error.hidden = typeof result !== 'string'
  if (result === 'taken') error.textContent = inboxCopy.BOOK_TAKEN
  else if (result === 'full') error.textContent = inboxCopy.BOOK_FULL
  else {
    toast(inboxCopy.BOOK_SAVED(isolate(result.name)))
    applyMode()
    textBox.focus()
  }
})
$('to-save-field').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('to-save-go').click()
})

// "How is this different from a messaging app?": rows for whoever opened it.
const compare = $<HTMLDialogElement>('compare')
function openCompare(rowsFor: [string, string, string][]) {
  $('compare-rows').replaceChildren(
    ...rowsFor.map(([what, them, us]) => {
      const row = document.createElement('div')
      row.className = 'compare-row'
      const h = document.createElement('h3')
      h.textContent = what
      const cell = (label: string, text: string, cls: string) => {
        const p = document.createElement('p')
        p.className = cls
        const l = document.createElement('span')
        l.className = 'compare-who'
        l.textContent = label
        p.append(l, document.createTextNode(text))
        return p
      }
      row.append(h, cell(inboxCopy.COMPARE_THEM, them, 'compare-them'), cell(inboxCopy.COMPARE_US, us, 'compare-us'))
      return row
    }),
  )
  compare.showModal()
  // The title takes the focus, not the close button: Safari rings a button focused on opening.
  $('compare-title').focus()
}
// A message that goes quantum-safe says so: to a quantum-safe address, or
// sealed with reply keys, as its marker shows.
$('to-compare').addEventListener('click', () =>
  openCompare(addressed && (isQuantumSafe(addressed.address) || replyWithKeys()) ? inboxCopy.COMPARE_SENDER_QS : inboxCopy.COMPARE_SENDER),
)
$('ni-compare').addEventListener('click', () => openCompare(inboxCopy.COMPARE_OWNER))
compare.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => compare.close()))
compare.addEventListener('click', (e) => {
  if (e.target === compare) compare.close() // click on the backdrop
})

/** Back to the page as it is for this visitor: their composer, with their inbox if it's open. */
/** "Copy it and go to my inbox": the way back from the inbox is that link's screen, not an empty composer. */
let backToLink = false

function goHome() {
  setHero(heroNow())
  applyMode()
  if (backToLink && $<HTMLInputElement>('link').value) {
    backToLink = false
    return show('sent')
  }
  backToLink = false
  show('compose')
}

const owner = setupOwner({
  core: () => core,
  toast,
  ensureConnected,
  whenReady,
  net: () => ({ state: netState, pct: joinPct, error: netError }),
  retryConnect: () => {
    clearInterval(pollTimer)
    void connect()
  },
  busy: () => transferring,
  replaceCore,
  claim: claimForLinks,
  changed: (info: InboxInfo | undefined) => {
    if (info) coreUse = 'links'
    // Locked on its own screen: back to the front page.
    if (!info && view === 'inbox') leaveInbox()
    if (view === 'compose' || view === 'delivered') setHero(heroNow())
    applyMode()
    // Locked: Lock's last write may still be finishing, so count once it has.
    if (!info) setTimeout(() => void refreshKeptCount(), 600)
  },
  bookChanged: () => applyMode(),
  download: (v1, onProgress) => {
    // Not alongside a link's collection, which waits for this one if its tap came first.
    if (downloading) return undefined
    downloading = true
    return core.download(v1, onProgress).finally(() => (downloading = false))
  },
  stopDownload: () => void core.stopDownload(),
  sendReply: async (address, text, name, replyKeys, onStage) => {
    // Always from the tab's second identity: the first checks the owner's inbox.
    void core.setCover(settings().cover)
    replying++
    try {
      // A quantum-safe one in two pieces apart, as from the composer.
      return await core.sendNotice(address, pack(text), true, (stage) => onStage(stage), { name, replyKeys })
    } finally {
      replying--
      updateSendButton()
    }
  },
  uploadReply: async (bytes, onProgress) => {
    // From this tab's identity, as a link's upload goes (the 8b rules), never alongside another transfer.
    if (transferring || pendingDrop || downloading) throw new Error(inboxCopy.CHAT_BUSY)
    replying++
    try {
      return await core.upload(bytes, settings().variedBatches, onProgress)
    } finally {
      replying--
      updateSendButton()
    }
  },
  noticeReply: async (address, v1, since, name, replyKeys) => {
    // From the second identity, as every reply goes, a random 1-3 minutes after the upload.
    void core.setCover(settings().cover)
    replying++
    const body = fileNoticeBody(v1)
    try {
      return await core.sendFileNotice(address, body, since, undefined, { name, replyKeys })
    } finally {
      body.fill(0) // the worker has its own copy
      replying--
      updateSendButton()
    }
  },
  stopUpload: () => void core.stopUpload().catch(() => {}),
  stopNotice: () => core.stopFileNotice().catch(() => false),
  canSend: (upload) => (transferring || pendingDrop || (upload && downloading) ? inboxCopy.CHAT_BUSY : ''),
  warm: warmNotices,
  unreadChanged: () => renderKeptPrompt(),
  arrived: () => {
    if (settings().notify) flagTab(inboxCopy.TAB_NEW)
  },
  onScreen: () => view === 'inbox',
  writeTo: (address) => {
    void addressTo(address)
    landOnCard()
    if (matchMedia('(pointer: fine)').matches) textBox.focus({ preventScroll: true })
  },
  chatOpened: (key) => {
    if (view === 'inbox' && (history.state as Step)?.chat !== key) history.pushState({ slynk: 'inbox', chat: key }, '')
  },
  chatClosed: () => {
    if ((history.state as Step)?.chat) history.back()
  },
  pending: () => !!pendingDrop,
  includeChanged: () => applyMode(),
  openSetting: openSettingAt,
})
/**
 * An inbox has just opened: its card, above the composer, comes into sight
 * (on a phone it was off the screen), and takes the focus,
 * so screen readers hear how opening is going.
 */
function showOpenedInbox() {
  // Opened to write to an inbox with it included (the reply line): back to that composer, message kept.
  if (addressed) {
    goHome()
    reveal($('card'))
    return
  }
  showInbox()
  $('ib-status').focus({ preventScroll: true })
}
$('ib-home').addEventListener('click', leaveInbox)

owner.onOpened(showOpenedInbox)

const create = setupCreate({
  core: () => core,
  toast,
  openInbox: (words, label, remember, password, qs) => {
    owner
      .open(words, { label, keep: remember, remember, password, qs })
      .then((result) => {
        if (result === 'ok') return showOpenedInbox()
        goHome()
        if (result === 'already') toast(inboxCopy.OPEN_ALREADY)
      })
      .catch((e) => {
        goHome()
        toast(errorText(e))
      })
  },
})
leftCreate = create.reset

// "Back to the front page" on the inbox's own screens: where the visitor was, with anything
// they were writing still there. Leaving the create flow forgets the new inbox (show()).
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-home]')) {
  b.addEventListener('click', () => {
    owner.clearForm()
    goHome()
    // Not on a touch screen, where it would bring up the keyboard unasked.
    if (matchMedia('(pointer: fine)').matches) textBox.focus({ preventScroll: true })
  })
}

function openInboxRoute(route: InboxRoute) {
  if (route.kind === 'inbox') {
    void addressTo(route.address)
  } else if (route.kind === 'new-inbox') {
    // Not while an inbox is in use here: lock it, or forget the kept one, first.
    if (owner.isOpen()) {
      toast(inboxCopy.OPEN_ALREADY)
      return goHome()
    }
    void refreshKeptCount().then(() => {
      if (keptCount > 0) {
        toast(inboxCopy.CREATE_KEPT)
        return goHome()
      }
      create.start()
      setHero(inboxCopy.HERO_CREATE)
      show('new-inbox')
    })
  } else if (owner.isOpen()) {
    // Already open in this tab: straight to it.
    showInbox()
  } else {
    owner.clearForm()
    // Only offered where nothing is kept. On a device that keeps an inbox, a switch to
    // untick would look like a way to delete it: that's the card's Forget this device.
    // A kept inbox opens kept whatever the switch says; another inbox gets the card's offer.
    $('oi-keep-row').hidden = keptCount > 0
    void owner.showRemembered()
    setHero(inboxCopy.HERO_OPEN)
    show('open-inbox')
    $('oi-words').focus()
  }
}

// --- Failure ---------------------------------------------------------------------------------

let retryAction: (() => void) | undefined

function fail(title: string, message: string, retry?: () => void, canStartOver = true) {
  $('f-title').textContent = title
  $('f-msg').textContent = message
  retryAction = retry
  $('f-retry').hidden = !retry
  $('f-home').hidden = !canStartOver
  show('failed')
}

$('f-retry').addEventListener('click', () => retryAction?.())
$('f-home').addEventListener('click', () => {
  retryAction = undefined // nothing of what arrived stays held by it
  forgetReceived()
  resetCompose()
})

// The logo goes to the front page without reloading it: a reload
// closed an open inbox, so its words were needed again, and dropped the tab's
// place on the mixnet. A new tab (middle click, Ctrl or Cmd) still loads afresh.
$('brand').addEventListener('click', (e) => {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  if (view === 'inbox') return leaveInbox()
  // Never away from something that would be lost, as with Back.
  if (transferring) return toast('Wait for this to finish first')
  if (pendingDrop) return toast(inboxCopy.UPLOAD_PENDING_NAV)
  if (view === 'received' && onceShown) return toast('Save what’s here first: it can’t be opened again')
  if (view === 'new-inbox' || view === 'open-inbox') {
    owner.clearForm()
    backHome()
  } else if (view === 'compose' || view === 'delivered') backHome()
  else {
    // A link just made, waiting, collected or failed: start over, as "Send another" and "Start over" do.
    forgetReceived()
    resetCompose()
  }
  window.scrollTo({ top: 0, behavior: 'auto' })
})

// --- Settings --------------------------------------------------------------------------------

const sheet = $<HTMLDialogElement>('settings')

function syncSettingsForm(s: Settings) {
  sheet.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((r) => (r.checked = r.value === s.theme))
  $<HTMLInputElement>('s-autosave').checked = s.autoSave
  $<HTMLInputElement>('s-notify').checked = s.notify
  $<HTMLInputElement>('s-varied').checked = s.variedBatches
  $<HTMLInputElement>('s-strip').checked = s.stripMetadata
  sheet.querySelectorAll<HTMLInputElement>('input[name="shrink"]').forEach((r) => (r.checked = r.value === s.shrink))
  sheet.querySelectorAll<HTMLInputElement>('input[name="photo-level"]').forEach((r) => (r.checked = r.value === s.smallestPhotos))
  sheet.querySelectorAll<HTMLInputElement>('input[name="video-level"]').forEach((r) => (r.checked = Number(r.value) === s.smallestVideos))
  $<HTMLInputElement>('s-previews').checked = s.photoPreviews
  $<HTMLInputElement>('s-plain').checked = s.plainNames
  $<HTMLInputElement>('s-connect').checked = s.connectOnLoad
  $<HTMLInputElement>('s-cover').checked = s.cover
  $<HTMLInputElement>('s-kcover').checked = s.coverRequests
  $<HTMLInputElement>('s-remember').checked = s.remember
  $<HTMLInputElement>('s-verbose').checked = s.verbose
  $<HTMLInputElement>('s-brotli').checked = s.brotli
  $('s-connect-note').hidden = true // said once, when it happened
}

function describeConnection() {
  const el = $('s-conn')
  const which = restartable()
  if (netState === 'error') el.textContent = `Not connected: ${netError}`
  else if (netState === 'idle') el.textContent = `Not connected yet. ${SITE_NAME} joins the mixnet when you start writing, choose a file or open a link.`
  else if (netState === 'connecting') el.textContent = which ? `Joining the mixnet is taking longer than usual (${joinPct ?? 0}%).` : 'Connecting…'
  else if (netStatus && connectedAt) {
    el.textContent =
      `Registered with ${netStatus.registered} of ${netStatus.total} mixnet nodes${netStatus.healthy ? '' : ' (reconnecting)'}. ` +
      `Your identity was created at ${connectedAt.toLocaleTimeString()} and exists only in this tab’s memory.` +
      (which === 'separate' ? ' The separate identity for your message is taking longer than usual to join.' : '')
  }
  $('s-restart').hidden = !which
  $('s-restart-note').hidden = !which
}

let describing = 0
function openSettings(advanced = false) {
  syncSettingsForm(settings())
  for (const id of ABOUT_CARDS) showAbout(id, false)
  describeConnection()
  // Kept current while open: a join's progress, and Restart once it's slow.
  clearInterval(describing)
  describing = window.setInterval(describeConnection, 1000)
  sheet.querySelector('details')!.open = advanced
  sheet.showModal()
  $('settings-title').focus() // as for the comparison: the title, not the close button
}

/** Opens Settings at one switch, for a link that names it. */
function openSettingAt(id: string) {
  openSettings()
  $(id).scrollIntoView({ block: 'center' })
  // A choice of several: the one chosen.
  ;($(id).querySelector<HTMLInputElement>('input:checked') ?? $(id)).focus()
}

$('open-settings').addEventListener('click', () => openSettings())
// Link options' last line.
$('opts-settings').textContent = burnCopy.OPTIONS_MORE
$('opts-settings').addEventListener('click', () => openSettings())
sheet.addEventListener('close', () => clearInterval(describing))
$('s-restart').addEventListener('click', () => void restartConnection())
sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => sheet.close()))
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) sheet.close() // click on the backdrop
})
sheet.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((r) =>
  r.addEventListener('change', () => updateSettings({ theme: r.value as Settings['theme'] })),
)
$('s-autosave').addEventListener('change', (e) => updateSettings({ autoSave: (e.target as HTMLInputElement).checked }))
$('s-notify').addEventListener('change', (e) => updateSettings({ notify: (e.target as HTMLInputElement).checked }))
$('s-varied').addEventListener('change', (e) => updateSettings({ variedBatches: (e.target as HTMLInputElement).checked }))
$('s-strip').addEventListener('change', (e) => updateSettings({ stripMetadata: (e.target as HTMLInputElement).checked }))
sheet.querySelectorAll<HTMLInputElement>('input[name="shrink"]').forEach((r) =>
  r.addEventListener('change', () => updateSettings({ shrink: r.value as Settings['shrink'] })),
)
sheet.querySelectorAll<HTMLInputElement>('input[name="photo-level"]').forEach((r) =>
  r.addEventListener('change', () => updateSettings({ smallestPhotos: r.value as Settings['smallestPhotos'] })),
)
sheet.querySelectorAll<HTMLInputElement>('input[name="video-level"]').forEach((r) =>
  r.addEventListener('change', () => updateSettings({ smallestVideos: Number(r.value) as Settings['smallestVideos'] })),
)
/** The choices of several with an ⓘ after their title ("Shrink photos, media & docs", "Smallest photos", "Smallest videos"). */
const ABOUT_CARDS = ['s-shrink', 's-photo-level', 's-video-level']
/** The ⓘ after a title: what its choices do, on a card under it, or not. */
function showAbout(id: string, open: boolean) {
  $(`${id}-about`).hidden = !open
  $(`${id}-info`).setAttribute('aria-expanded', String(open))
}
for (const id of ABOUT_CARDS) $(`${id}-info`).addEventListener('click', () => showAbout(id, $(`${id}-about`).hidden === true))
$('s-previews').addEventListener('change', (e) => updateSettings({ photoPreviews: (e.target as HTMLInputElement).checked }))
$('s-plain').addEventListener('change', (e) => updateSettings({ plainNames: (e.target as HTMLInputElement).checked }))
/** Under "Connect when the page opens", when switching it on switched on remembering too. */
const CONNECT_REMEMBERS = 'Turned on “Remember these settings” too, so it connects next time.'
$('s-connect').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked
  // Forgotten on the next visit unless settings are remembered, so switching it on remembers
  // them too, and says so. Off leaves remembering as it is: other settings
  // may have changed since.
  const rememberToo = on && !settings().remember
  updateSettings({ connectOnLoad: on, ...(rememberToo ? { remember: true } : {}) })
  if (rememberToo) $<HTMLInputElement>('s-remember').checked = true
  $('s-connect-note').textContent = CONNECT_REMEMBERS
  $('s-connect-note').hidden = !rememberToo
  if (on) ensureConnected()
})
$('s-cover').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked
  updateSettings({ cover: on })
  // Cover runs while connected; turning it on doesn't connect by itself. The
  // core also notes it for an identity connected later (an inbox message's).
  void core.setCover(on)
  showCoverCount()
})
$('s-kcover').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked
  updateSettings({ coverRequests: on })
  if (on) startCover()
  else stopCover()
})
$('s-remember').addEventListener('change', (e) => updateSettings({ remember: (e.target as HTMLInputElement).checked }))
$('s-verbose').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked
  updateSettings({ verbose: on })
  void core.verbose(on)
})
$('s-brotli').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked
  updateSettings({ brotli: on })
  // The message, in place: Brotli's version, or deflated again (the tray does its files itself).
  const m = message
  if (!m?.stored) return
  if (on) return squeezeMessage(m)
  messageSqueeze?.abort()
  if (m.stored.method === 'brotli')
    void store(m.data).then((deflated) => {
      if (message !== m) return
      m.stored = deflated
      renderCompose()
    })
})

$('s-check').addEventListener('click', async () => {
  const out = $('s-check-out')
  const button = $<HTMLButtonElement>('s-check')
  out.hidden = false
  out.textContent = 'Downloading the xx network’s definition…\n'
  button.disabled = true
  try {
    const ndf = await fetchNdf()
    const sample = sampleGateways(ndf, 20)
    out.textContent += `${ndf.Gateways.length} gateways listed. Probing 20…\n`
    const results = await Promise.all(sample.map((g) => probe(g)))
    sample.forEach((g, i) => (out.textContent += `${results[i] ? 'ok  ' : 'FAIL'} ${g.host.slice(0, 12)}…:${g.port}\n`))
    out.textContent += `\n${results.filter(Boolean).length} of 20 answered.`
  } catch (e) {
    out.textContent += `Error: ${errorText(e)}`
  } finally {
    button.disabled = false
  }
})

// --- Start -------------------------------------------------------------------------------------

// Focus rings are for the keyboard. After a tap or click, a button the page
// focuses for screen readers (a confirmation's, say) shows none, as Safari
// otherwise rings it; after any key, every focus shows again.
document.addEventListener('pointerdown', () => (document.documentElement.dataset.input = 'pointer'), true)
document.addEventListener('keydown', () => (document.documentElement.dataset.input = 'keys'), true)

fillCopy()
wireQsWhy()
askBeforeLeaving() // the footer's link to the xx network's site
for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-copy="MESSAGES_ONLY_WHY"]')) a.href = inboxCopy.MESSAGES_ONLY_HREF
$('ni-only').hidden = INBOX_FILES

$('cancel-link').textContent = burnCopy.CANCEL_BUTTON
$('cancel-help').textContent = burnCopy.CANCEL_HELP
$('cancel-q').textContent = burnCopy.CANCEL_CONFIRM
$('cancel-yes').textContent = burnCopy.CANCEL_YES
$('cancel-no').textContent = burnCopy.CANCEL_NO
setupLinkOptions()
setNet('idle', 'Connects when needed')
// A link waits for the recipient's tap; a broken or expired one needs no identity.
// "Connect when the page opens" doesn't apply to a link: it waits for a tap,
// so a crowd opening a shared link costs the network nothing.
const openedOnLink = readLinkFromAddress()
if (!openedOnLink) show('compose')
void refreshKeptCount()
if (settings().connectOnLoad && !openedOnLink) ensureConnected()
