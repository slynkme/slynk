// Web links in a message, made from its text (links.ts finds them), and the
// popup a tap on one opens first: where it goes, then "Open in a new tab".
// Every one opens in a new tab, which is a fresh
// page: a Slynk link opened from an inbox gets a new identity on the network
// of its own, never the one checking the inbox, and the inbox stays open
// here. "noopener noreferrer": the new tab can't reach this one, and isn't
// told where it was opened from. A Slynk link's key, after its #, never
// leaves the browser. Message text comes from anyone: it goes in as text
// nodes, never markup.
import { homeOrigins } from '../home.ts'
import * as copy from '../inbox/inboxCopy.ts'
import { findLinks, type FoundLink } from './links.ts'

/**
 * Where the link is: in a message shown in an inbox (the owner's screen) or that came by link (the received
 * screen), or one of Slynk's own pages that leads off slynk.me ('site').
 */
export type LinkPlace = 'inbox' | 'link' | 'site'

const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** text, with each web link in it a link that asks first. */
export function linkedText(text: string, place: LinkPlace): DocumentFragment {
  const out = document.createDocumentFragment()
  let at = 0
  for (const link of findLinks(text, ...homeOrigins())) {
    if (link.start > at) out.append(document.createTextNode(text.slice(at, link.start)))
    const a = document.createElement('a')
    a.className = 'msg-link'
    a.href = link.href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = text.slice(link.start, link.end)
    const ask = (e: MouseEvent) => {
      e.preventDefault()
      askToOpen(link, place)
    }
    a.addEventListener('click', ask)
    // A middle click would open it without asking.
    a.addEventListener('auxclick', (e) => e.button === 1 && ask(e))
    out.append(a)
    at = link.end
  }
  if (at < text.length) out.append(document.createTextNode(text.slice(at)))
  return out
}

/** The links in a blurred message are out of the Tab key's reach until it's revealed. */
export function linksReachable(root: Element, reachable: boolean) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a.msg-link')) a.tabIndex = reachable ? 0 : -1
}

/**
 * Every link already in the page that opens another site in a new tab (the footer's xx network link, the
 * About page's write-ups) asks first, in the same popup. Links to Slynk's own
 * pages (the About page, the licences) just open.
 */
export function askBeforeLeaving(root: ParentNode = document) {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[target="_blank"][href]')) {
    if (a.id === 'link-warn-go' || a.classList.contains('msg-link')) continue
    const to = new URL(a.href)
    if (homeOrigins().includes(to.origin)) continue
    const ask = (e: MouseEvent) => {
      e.preventDefault()
      askToOpen({ start: 0, end: 0, href: to.href, host: to.host, slynk: false, hash: false }, 'site')
    }
    a.addEventListener('click', ask)
    a.addEventListener('auxclick', (e) => e.button === 1 && ask(e))
  }
}

let wired = false

/** Where it goes, and what opening it means, before it opens in a new tab. */
export function askToOpen(link: FoundLink, place: LinkPlace) {
  const d = byId<HTMLDialogElement>('link-warn')
  if (d.open) return
  wire(d)
  const title = byId('link-warn-title')
  title.textContent = place === 'site' ? copy.LINK_LEAVE_TITLE : link.slynk ? copy.LINK_SLYNK_TITLE : copy.LINK_OTHER_TITLE
  byId('link-warn-host').textContent = link.host
  // Another site's full address, to check; a Slynk link's is only its key.
  const full = byId('link-warn-full')
  full.textContent = link.slynk ? '' : link.href
  full.hidden = link.slynk
  byId('link-warn-text').textContent = place === 'site'
    ? copy.LINK_LEAVE
    : !link.slynk
    ? copy.LINK_OTHER
    : !link.hash
      ? copy.LINK_PAGE
      : place === 'inbox'
        ? copy.LINK_SLYNK_INBOX
        : copy.LINK_SLYNK_TAB
  // A Slynk link from an inbox: to protect whoever sent it, another network or a VPN, and Copy is right there.
  byId('link-warn-careful').hidden = !(link.slynk && link.hash && place === 'inbox')
  byId<HTMLAnchorElement>('link-warn-go').href = link.href
  d.showModal()
  // The title takes the focus, not a button: Safari rings a button focused on opening.
  title.focus()
}

function wire(d: HTMLDialogElement) {
  if (wired) return
  wired = true
  const go = byId<HTMLAnchorElement>('link-warn-go')
  const copyButton = byId<HTMLButtonElement>('link-warn-copy')
  let ticked: ReturnType<typeof setTimeout> | undefined
  const untick = () => {
    clearTimeout(ticked)
    copyButton.dataset.copied = 'false'
    copyButton.setAttribute('aria-label', copy.LINK_COPY)
    copyButton.title = copy.LINK_COPY
    byId('link-warn-said').textContent = ''
  }
  // The address it goes to, to open elsewhere (another device, say): said with a tick on the button
  // and to a screen reader, since a toast would sit behind the popup.
  copyButton.addEventListener('click', async () => {
    const href = go.getAttribute('href')
    if (!href) return
    try {
      await navigator.clipboard.writeText(href)
      untick()
      copyButton.dataset.copied = 'true'
      copyButton.setAttribute('aria-label', copy.LINK_COPIED)
      copyButton.title = copy.LINK_COPIED
      byId('link-warn-said').textContent = copy.LINK_COPIED
      ticked = setTimeout(untick, 1500)
    } catch {
      // Shown in full and selected instead, to copy by hand.
      const full = byId('link-warn-full')
      full.textContent = href
      full.hidden = false
      document.getSelection?.()?.selectAllChildren(full)
    }
  })
  // The address (for a Slynk link, its key) isn't left in the page once it closes: at once on its own
  // buttons, and on the close event for Escape. A browser may hold that event until it next draws, so
  // a late one never empties the popup opened again since.
  const forget = () => {
    go.removeAttribute('href')
    byId('link-warn-full').textContent = ''
    untick()
  }
  const shut = () => {
    d.close()
    forget()
  }
  d.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', shut))
  d.addEventListener('click', (e) => {
    if (e.target === d) shut() // click on the backdrop
  })
  // A link of its own, so the browser opens the tab itself (nothing blocks it), then the popup closes.
  go.addEventListener('click', () => setTimeout(shut))
  d.addEventListener('close', () => {
    if (!d.open) forget()
  })
}
