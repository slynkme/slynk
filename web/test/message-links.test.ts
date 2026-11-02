// Web links in a message: an address pasted
// into an inbox message (a Slynk link "attaching" files, say) becomes a link,
// made from text, never markup; a tap first says where it goes, and every one
// opens in a new tab, so a Slynk link is never collected by the identity that
// checks the inbox. Finding them is ui/links.ts; making them and the popup,
// ui/linkWarn.ts. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import * as copy from '../src/inbox/inboxCopy.ts'
import { MAX_LINKS, MAX_LINK_LENGTH, findLinks } from '../src/ui/links.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const SITE = 'https://slynk.me'
const written = (text: string) => findLinks(text, SITE).map((l) => text.slice(l.start, l.end))
/** A one-time link as the site makes them: 183 bytes, base64url after the #. */
const slynkLink = () => `${SITE}/#${randomBytes(183).toString('base64url')}`
const ch = (...codes: number[]) => String.fromCodePoint(...codes)

describe('finding links', () => {
  test('an address in a sentence, without what ends the sentence', () => {
    assert.deepEqual(written('See https://example.com/a. Or http://example.org/b, then https://example.net/c!'), [
      'https://example.com/a',
      'http://example.org/b',
      'https://example.net/c',
    ])
    assert.deepEqual(written('“https://example.com/q?x=1&y=2#top”'), ['https://example.com/q?x=1&y=2#top'])
    assert.deepEqual(written("'https://example.com/it's'"), ["https://example.com/it's"])
    assert.deepEqual(written('HTTPS://EXAMPLE.COM/Path'), ['HTTPS://EXAMPLE.COM/Path'])
    assert.equal(findLinks('HTTPS://EXAMPLE.COM/Path', SITE)[0].host, 'example.com')
  })

  test('brackets: kept when the address opens them, dropped when they are the sentence’s', () => {
    assert.deepEqual(written('(see https://en.wikipedia.org/wiki/Mix_network_(protocol))'), ['https://en.wikipedia.org/wiki/Mix_network_(protocol)'])
    assert.deepEqual(written('[https://example.com/a]'), ['https://example.com/a'])
    assert.deepEqual(written('(https://example.com/a).'), ['https://example.com/a'])
  })

  test('a Slynk link, whole: its key may end in - or _', () => {
    for (let i = 0; i < 50; i++) {
      const link = slynkLink()
      const [found] = findLinks(`Here are the files: ${link}\nThanks`, SITE)
      assert.equal(found.href, link)
      assert.ok(found.slynk && found.hash)
      assert.equal(found.host, 'slynk.me')
    }
    for (const end of ['-', '_', '--', '__']) assert.deepEqual(written(`${SITE}/#abc${end}`), [`${SITE}/#abc${end}`])
  })

  test('this site’s own: a link or inbox address (with a #), a page (without), and http:// made https://', () => {
    const [page] = findLinks(`${SITE}/about/#inbox-reading`, SITE)
    assert.ok(page.slynk && page.hash)
    const [about] = findLinks(`${SITE}/about/`, SITE)
    assert.ok(about.slynk && !about.hash)
    const [plain] = findLinks('http://slynk.me/#abc', SITE)
    assert.ok(plain.slynk)
    assert.equal(plain.href, 'https://slynk.me/#abc')
    // Elsewhere (a developer's copy, or a fork), slynk.me is another site.
    assert.ok(!findLinks('https://slynk.me/#abc', 'http://localhost:5173')[0].slynk)
    assert.ok(findLinks('http://localhost:5173/#abc', 'http://localhost:5173')[0].slynk)
    // A copy run from one's own computer: the site's links and its own address are both its own.
    const local = 'http://127.0.0.1:8293'
    for (const text of ['https://slynk.me/#abc', 'http://slynk.me/#abc', `${local}/#abc`]) {
      const [found] = findLinks(text, SITE, local)
      assert.ok(found.slynk && found.hash, text)
    }
    assert.equal(findLinks('http://slynk.me/#abc', SITE, local)[0].href, 'https://slynk.me/#abc')
    assert.equal(findLinks(`${local}/#abc`, SITE, local)[0].href, `${local}/#abc`)
    assert.ok(!findLinks('https://example.com/#abc', SITE, local)[0].slynk)
    assert.ok(!findLinks('http://127.0.0.1:8294/#abc', SITE, local)[0].slynk)
  })

  test('only http:// and https://: never javascript:, data:, file: or any other', () => {
    for (const text of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(document.domain)',
      'javascript://example.com/%0Aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'mailto:someone@example.com',
      'ftp://example.com/file',
      'ws://example.com/',
      'about:blank',
      'xhttps://example.com/',
      'https:example.com',
      'https:/example.com',
      'https:\\\\example.com',
      'https://',
      'https:// example.com',
    ])
      assert.deepEqual(findLinks(text, SITE), [], text)
    // An https address after another scheme: only the address is a link.
    assert.equal(findLinks('javascript:https://example.com/', SITE)[0].href, 'https://example.com/')
    assert.equal(findLinks('blob:https://slynk.me/0b7e', SITE)[0].href, 'https://slynk.me/0b7e')
  })

  test('never with a name or password before the host, which hides where it really goes', () => {
    for (const text of ['https://slynk.me@example.com/#abc', 'https://slynk.me:443@example.com/', 'https://user:pass@example.com/', 'http://a@b.example'])
      assert.deepEqual(findLinks(text, SITE), [], text)
  })

  test('look-alikes show where they really go, and are never this site', () => {
    // A Cyrillic у in place of y: the host as the browser reads it, xn--…
    const [cyrillic] = findLinks(`https://sl${ch(0x443)}nk.me/#abc`, SITE)
    assert.ok(!cyrillic.slynk)
    assert.match(cyrillic.host, /^xn--/)
    assert.ok(/^[\x21-\x7e]+$/.test(cyrillic.href), 'nothing but plain characters in where it goes')
    for (const [text, host] of [
      ['https://slynk.me.example.com/#abc', 'slynk.me.example.com'],
      ['https://slynk-me.example/#abc', 'slynk-me.example'],
      ['https://example.com/https://slynk.me/#abc', 'example.com'],
      ['https://example.com#https://slynk.me/', 'example.com'],
      ['https://slynk.me:8443/#abc', 'slynk.me:8443'],
      ['https://slynk.me./#abc', 'slynk.me.'],
      // A backslash ends the address as written: what's before it is all that's linked.
      ['https://example.com\\@slynk.me/', 'example.com'],
    ]) {
      const [found] = findLinks(text, SITE)
      assert.equal(found.host, host, text)
      assert.ok(!found.slynk, text)
    }
    // Written in disguise but really slynk.me: the browser would go there, so it's this site.
    assert.ok(findLinks('https://%73lynk.me/#abc', SITE)[0].slynk)
    assert.ok(findLinks('https://SLYNK.ME/#abc', SITE)[0].slynk)
  })

  test('invisible, control and bidi characters end an address', () => {
    for (const c of [0x202e, 0x2066, 0x200b, 0x200f, 0xfeff, 0x00ad, 0x0000, 0x0007, 0x2028, 0x00a0, 0x3000]) {
      const text = `https://example.com/a${ch(c)}gpj.exe`
      assert.deepEqual(written(text), ['https://example.com/a'], c.toString(16))
    }
    // What a link goes to never holds them either: the rest of it is escaped.
    const [found] = findLinks(`https://example.com/caf${ch(0xe9)}`, SITE)
    assert.equal(found.href, 'https://example.com/caf%C3%A9')
  })

  test('where each is in the text, so the text around them is kept as it was', () => {
    const text = `a https://one.example b\nhttps://two.example/x)c ${slynkLink()} d`
    let at = 0
    for (const l of findLinks(text, SITE)) {
      assert.ok(l.start >= at && l.end > l.start)
      at = l.end
    }
    assert.equal(findLinks(text, SITE).length, 3)
  })

  test('very long text: quick, at most MAX_LINKS links, none longer than MAX_LINK_LENGTH', () => {
    const big = 2_000_000
    const time = (f: () => void) => {
      const t = performance.now()
      f()
      return performance.now() - t
    }
    assert.ok(time(() => assert.deepEqual(findLinks('a'.repeat(big), SITE), [])) < 1000)
    const many = 'https://a.example/ '.repeat(big / 19)
    assert.ok(time(() => assert.equal(findLinks(many, SITE).length, MAX_LINKS)) < 1000)
    assert.deepEqual(findLinks(`https://example.com/${'a'.repeat(MAX_LINK_LENGTH)}`, SITE), [])
    assert.equal(findLinks(`https://example.com/${'a'.repeat(MAX_LINK_LENGTH - 40)}`, SITE).length, 1)
    // Brackets to trim, a long run of them in every address.
    const brackets = `http://a.example/${')'.repeat(4000)} `.repeat(big / 4020)
    assert.ok(time(() => findLinks(brackets, SITE)) < 1000)
    // Near-misses that are never links (a name before the host) stop being looked at.
    const near = 'https://u@a.example '.repeat(big / 20)
    assert.ok(time(() => assert.deepEqual(findLinks(near, SITE), [])) < 1000)
    // One unbroken run: never a link, never slow.
    assert.ok(time(() => assert.deepEqual(findLinks(`https://${'x'.repeat(big)}`, SITE), [])) < 1000)
    assert.ok(time(() => findLinks('http://'.repeat(big / 7), SITE)) < 1000)
  })
})

// --- Making them, and the popup: a small stand-in for the page --------------------------------

type Listener = (e: { preventDefault?: () => void; button?: number; target?: unknown }) => void

class El {
  className = ''
  href = ''
  target = ''
  rel = ''
  textContent = ''
  hidden = false
  tabIndex = 0
  title = ''
  open = false
  dataset: Record<string, string> = {}
  attrs = new Map<string, string>()
  children: (El | { text: string })[] = []
  listeners: Record<string, Listener[]> = {}
  tag: string
  constructor(tag: string) {
    this.tag = tag
  }
  addEventListener(type: string, f: Listener) {
    ;(this.listeners[type] ??= []).push(f)
  }
  fire(type: string, e: Parameters<Listener>[0] = {}) {
    for (const f of this.listeners[type] ?? []) f(e)
  }
  append(...nodes: (El | { text: string })[]) {
    this.children.push(...nodes)
  }
  removeAttribute(name: string) {
    if (name === 'href') this.href = ''
    else this.attrs.delete(name)
  }
  setAttribute(name: string, value: string) {
    if (name === 'href') this.href = value
    else this.attrs.set(name, value)
  }
  getAttribute(name: string) {
    return name === 'href' ? this.href || null : (this.attrs.get(name) ?? null)
  }
  querySelectorAll() {
    return [] as El[]
  }
  showModal() {
    this.open = true
  }
  close() {
    this.open = false
    this.fire('close')
  }
  focus() {}
}

const page = new Map<string, El>()
for (const id of ['link-warn', 'link-warn-title', 'link-warn-host', 'link-warn-full', 'link-warn-text', 'link-warn-careful', 'link-warn-go', 'link-warn-copy', 'link-warn-said'])
  page.set(id, new El(id))
Object.assign(globalThis, {
  location: { origin: SITE },
  document: {
    createDocumentFragment: () => new El('#fragment'),
    createElement: (tag: string) => new El(tag),
    createTextNode: (text: string) => ({ text }),
    getElementById: (id: string) => page.get(id),
  },
})
const { askBeforeLeaving, linkedText } = await import('../src/ui/linkWarn.ts')
const made = (text: string, place: 'inbox' | 'link' = 'inbox') => (linkedText(text, place) as unknown as El).children
const said = (nodes: ReturnType<typeof made>) => nodes.map((n) => ('text' in n ? n.text : n.textContent)).join('')
const anchors = (nodes: ReturnType<typeof made>) => nodes.filter((n): n is El => n instanceof El)

describe('making them', () => {
  test('from text: the message reads exactly as it was written, with nothing of it parsed as markup', () => {
    const text = `<img src=x onerror=alert(1)> <a href="javascript:alert(1)">tap</a> https://example.com/a?b=<b>& ${slynkLink()} end`
    const nodes = made(text)
    assert.equal(said(nodes), text)
    const links = anchors(nodes)
    assert.deepEqual(
      links.map((a) => a.textContent),
      ['https://example.com/a?b=', text.match(/https:\/\/slynk\.me\/#\S+/)![0]],
    )
    for (const a of links) {
      assert.equal(a.tag, 'a')
      assert.equal(a.className, 'msg-link')
      assert.equal(a.target, '_blank')
      assert.equal(a.rel, 'noopener noreferrer')
      assert.match(a.href, /^https:\/\//)
    }
    assert.deepEqual(made(''), [])
    assert.equal(said(made('no links here')), 'no links here')
  })

  test('a tap asks first, saying where it goes; Open is a new tab, and the popup forgets the address', async () => {
    const link = slynkLink()
    const [a] = anchors(made(`Files: ${link}`))
    let stopped = false
    a.fire('click', { preventDefault: () => (stopped = true) })
    assert.ok(stopped, 'the tap itself opens nothing')
    const d = page.get('link-warn')!
    assert.ok(d.open)
    assert.equal(page.get('link-warn-title')!.textContent, copy.LINK_SLYNK_TITLE)
    assert.equal(page.get('link-warn-host')!.textContent, 'slynk.me')
    assert.ok(page.get('link-warn-full')!.hidden, 'a Slynk link’s address is only its key')
    assert.equal(page.get('link-warn-text')!.textContent, copy.LINK_SLYNK_INBOX)
    assert.ok(!page.get('link-warn-careful')!.hidden, 'from an inbox: to protect whoever sent it, another network')
    const go = page.get('link-warn-go')!
    assert.equal(go.href, link)
    // A second tap while it's open changes nothing.
    anchors(made('https://example.com/'))[0].fire('click', { preventDefault() {} })
    assert.equal(go.href, link)
    go.fire('click')
    await new Promise((r) => setTimeout(r))
    assert.ok(!d.open)
    assert.equal(go.href, '')

    // Another site: its full address too, and what it sees.
    anchors(made('https://example.com/login?next=1', 'link'))[0].fire('auxclick', { button: 1, preventDefault() {} })
    assert.ok(d.open)
    assert.equal(page.get('link-warn-title')!.textContent, copy.LINK_OTHER_TITLE)
    assert.equal(page.get('link-warn-host')!.textContent, 'example.com')
    assert.equal(page.get('link-warn-full')!.textContent, 'https://example.com/login?next=1')
    assert.ok(!page.get('link-warn-full')!.hidden)
    assert.equal(page.get('link-warn-text')!.textContent, copy.LINK_OTHER)
    assert.ok(page.get('link-warn-careful')!.hidden)
    d.close()
    assert.equal(page.get('link-warn-full')!.textContent, '')

    // A Slynk link from a message that came by link; one of Slynk's pages.
    anchors(made(link, 'link'))[0].fire('click', { preventDefault() {} })
    assert.equal(page.get('link-warn-text')!.textContent, copy.LINK_SLYNK_TAB)
    assert.ok(page.get('link-warn-careful')!.hidden, 'only from an inbox')
    d.close()
    anchors(made(`${SITE}/about/`))[0].fire('click', { preventDefault() {} })
    assert.equal(page.get('link-warn-text')!.textContent, copy.LINK_PAGE)
    assert.ok(page.get('link-warn-careful')!.hidden, 'not for one of Slynk’s pages')
    d.close()
    // A right click (2) leaves the browser's own menu alone.
    anchors(made('https://example.com/'))[0].fire('auxclick', { button: 2, preventDefault() {} })
    assert.ok(!d.open)
  })
})

describe('Slynk’s own links that leave slynk.me', () => {
  test('ask first in the same popup, saying it’s another website; links to Slynk’s own pages just open', () => {
    const a = (href: string, id = '', className = '') =>
      Object.assign(new El('a'), { href, id, classList: { contains: (c: string) => className.split(' ').includes(c) } })
    const out = a('https://xx.network/')
    const own = a(`${SITE}/licenses.txt`)
    const go = a('https://example.com/', 'link-warn-go')
    const msg = a('https://example.com/', '', 'msg-link')
    askBeforeLeaving({ querySelectorAll: () => [out, own, go, msg] } as unknown as ParentNode)
    for (const el of [own, go, msg]) assert.deepEqual(el.listeners, {}, el.href)
    let stopped = false
    out.fire('click', { preventDefault: () => (stopped = true) })
    assert.ok(stopped, 'the tap itself opens nothing')
    const d = page.get('link-warn')!
    assert.ok(d.open)
    assert.equal(page.get('link-warn-title')!.textContent, copy.LINK_LEAVE_TITLE)
    assert.equal(page.get('link-warn-host')!.textContent, 'xx.network')
    assert.equal(page.get('link-warn-text')!.textContent, copy.LINK_LEAVE)
    assert.ok(page.get('link-warn-careful')!.hidden)
    assert.equal(page.get('link-warn-go')!.href, 'https://xx.network/')
    d.close()
    out.fire('auxclick', { button: 1, preventDefault() {} })
    assert.ok(d.open, 'a middle click asks too')
    d.close()
    assert.equal(copy.LINK_LEAVE_TITLE, 'Leave Slynk?')
    assert.match(copy.LINK_LEAVE, /another website in a new tab\. Like any website, it will see your internet address/)
  })
})

describe('Copy, inside the address box', () => {
  test('puts where it goes on the clipboard, with a tick for a moment; refused, shows it in full to copy by hand', async () => {
    const written: string[] = []
    let refuse = false
    const clipboard = {
      writeText: async (text: string) => {
        if (refuse) throw new Error('not allowed')
        written.push(text)
      },
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } })
    const later = () => new Promise((r) => setTimeout(r))
    const d = page.get('link-warn')!
    const button = page.get('link-warn-copy')!
    const full = page.get('link-warn-full')!
    const link = slynkLink()
    anchors(made(`Files: ${link}.`))[0].fire('click', { preventDefault() {} })
    button.fire('click')
    await later()
    assert.deepEqual(written, [link])
    assert.equal(button.dataset.copied, 'true')
    assert.equal(button.getAttribute('aria-label'), copy.LINK_COPIED)
    assert.equal(page.get('link-warn-said')!.textContent, copy.LINK_COPIED)
    assert.ok(full.hidden, 'a Slynk link still isn’t shown in full')
    d.close()
    assert.equal(button.dataset.copied, 'false')
    assert.equal(button.getAttribute('aria-label'), copy.LINK_COPY)
    assert.equal(page.get('link-warn-said')!.textContent, '')
    // What it really goes to, not what was written: a look-alike copies as xn--…
    anchors(made(`https://sl${ch(0x443)}nk.me/#abc`))[0].fire('click', { preventDefault() {} })
    button.fire('click')
    await later()
    assert.match(written[1], /^https:\/\/xn--/)
    d.close()
    refuse = true
    anchors(made(link))[0].fire('click', { preventDefault() {} })
    button.fire('click')
    await later()
    assert.equal(full.textContent, link)
    assert.ok(!full.hidden)
    assert.equal(button.dataset.copied, 'false')
    d.close()
    assert.equal(full.textContent, '')
  })
})

describe('where they are', () => {
  const links = read('../src/ui/links.ts')
  const warn = read('../src/ui/linkWarn.ts')
  const owner = read('../src/inbox/owner.ts')
  const items = read('../src/ui/items.ts')
  const html = read('../index.html')
  const css = read('../src/style.css')

  test('closing on its own buttons forgets the address at once, not only on the close event', () => {
    assert.match(warn, /d\.querySelectorAll\('\[data-close\]'\)\.forEach\(\(b\) => b\.addEventListener\('click', shut\)\)/)
    assert.match(warn, /if \(e\.target === d\) shut\(\)/)
    assert.match(warn, /go\.addEventListener\('click', \(\) => setTimeout\(shut\)\)/)
    assert.match(warn, /const shut = \(\) => \{\n {4}d\.close\(\)\n {4}forget\(\)\n {2}\}/)
    assert.match(warn, /d\.addEventListener\('close', \(\) => \{\n {4}if \(!d\.open\) forget\(\)\n {2}\}\)/)
  })

  test('a close event that arrives late never empties the popup opened again since', () => {
    const d = page.get('link-warn')!
    const go = page.get('link-warn-go')!
    anchors(made('https://example.com/a'))[0].fire('click', { preventDefault() {} })
    d.fire('close') // the last one's, held until the browser drew again
    assert.ok(d.open)
    assert.equal(go.href, 'https://example.com/a')
    assert.equal(page.get('link-warn-full')!.textContent, 'https://example.com/a')
    d.close()
    assert.equal(go.href, '')
  })

  test('never markup, and nothing fetched or previewed', () => {
    for (const src of [links, warn]) {
      assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|document\.write/.test(src))
      assert.ok(!/fetch\(|new Image|XMLHttpRequest|prefetch|preload|sendBeacon|window\.open/.test(src))
    }
  })

  test('every message the owner reads: their messages, their own, and what was collected', () => {
    assert.equal(owner.match(/linkedText\(/g)?.length, 6)
    assert.match(owner, /pre\.append\(linkedText\(shownText\(i\.body\), 'inbox'\)\)/)
    assert.match(owner, /msg\.append\(linkedText\(text, 'inbox'\)\)/)
    assert.match(owner, /itemMessageRow\(item, \(text\) => void copyText\(text, 'Copied', deps\.toast\), 'inbox'\)/)
    assert.match(owner, /setHidden\(li\.querySelector<HTMLElement>\('\[data-part="secret"\]'\)!, false\)/)
    assert.ok(!/textContent: text \}/.test(owner), 'no message text set straight in')
    // A blurred message's links can't be reached with the Tab key until it's revealed.
    assert.match(items, /setHidden\(secret, true\)\n {2}part\(li, 'reveal'\)\.addEventListener\('click', \(\) => setHidden\(secret, false\)\)/)
    assert.match(items, /linksReachable\(secret, !hidden\)/)
  })

  test('a message that came by link too: one alone, or in a list', () => {
    const main = read('../src/main.ts')
    assert.match(main, /\$\('secret-text'\)\.replaceChildren\(linkedText\(new TextDecoder\(\)\.decode\(single\.data\), 'link'\)\)\n {4}setHidden\(\$\('secret'\), true\)/)
    assert.match(main, /messageRow\(item, \(text\) => void copySecret\(text\), 'link'\)/)
    assert.match(main, /\$\('reveal'\)\.addEventListener\('click', \(\) => setHidden\(\$\('secret'\), false\)\)/)
    assert.match(main, /\$\('hide-secret'\)\.addEventListener\('click', \(\) => setHidden\(\$\('secret'\), true\)\)/)
    assert.ok(!/secret'\)\.dataset\.hidden =/.test(main), 'blurred and revealed only with setHidden')
  })

  test('a link that lands in the tab with the inbox open anyway is never collected there', () => {
    const main = read('../src/main.ts')
    const reading = main.slice(main.indexOf('function readLinkFromAddress('), main.indexOf('function sameLink('))
    const guard = reading.indexOf("if (owner.isOpen() && !inboxRoute(fragment)) {\n    toast(inboxCopy.LINK_NOT_HERE)\n    return true\n  }")
    assert.ok(guard > 0)
    // Before anything about the link is read or the screen changes, and after the # is cleared.
    assert.ok(guard > reading.indexOf("history.replaceState(null, '', location.pathname + location.search)"))
    assert.ok(guard < reading.indexOf('forgetSentLink()'))
    assert.ok(guard < reading.indexOf('parseLinkFragment(fragment)'))
    // Lock gives the tab a new identity, so the toast's "or lock your inbox first" is true.
    assert.match(read('../src/inbox/owner.ts'), /deps\.replaceCore\(\)\n {4}deps\.changed\(undefined\)/)
    assert.match(main, /function replaceCore\(\) \{\n {2}core\.close\(\)\n {2}core = new Core\(\)/)
  })

  test('the popup: its Open is a link of its own to a new tab, with the arrow every new tab has', () => {
    assert.match(
      html,
      /<dialog id="link-warn" class="sheet"[^>]*>[\s\S]*?<div class="sheet-foot row link-warn-foot">\s*<a class="btn grad-btn" id="link-warn-go" target="_blank" rel="noopener noreferrer" data-copy="LINK_GO"><\/a>\s*<button class="btn" type="button" data-close data-copy="LINK_CANCEL"><\/button>/,
    )
    // Copy inside the address box's right edge, like the scanner's camera and the words' eye.
    assert.match(
      html,
      /<div class="link-warn-box">\s*<p class="link-warn-host" id="link-warn-host"><\/p>\s*<button class="field-btn link-warn-copy" id="link-warn-copy" type="button" data-copy-label="LINK_COPY" data-copied="false">/,
    )
    assert.match(html, /<p class="sr-only" id="link-warn-said" role="status" aria-live="polite"><\/p>/)
    assert.match(css, /a\[target='_blank'\]::after \{/)
    assert.match(css, /\.msg-link \{\n {2}color: inherit;\n {2}text-underline-offset: 2px;\n {2}unicode-bidi: isolate;\n\}/)
  })

  test('the About page says what the popup leaves out: the shared internet address, and what a sender can tell', () => {
    const about = read('../about/index.html').replace(/\s+/g, ' ')
    const answer = about.slice(about.indexOf('<details id="inbox-links">'), about.indexOf('</details>', about.indexOf('<details id="inbox-links">')))
    assert.match(answer, /What happens when I open a link in a message\?/)
    assert.match(answer, /new tab, so your inbox stays open/)
    assert.match(answer, /never the one your inbox uses/)
    assert.match(answer, /same internet address/)
    assert.match(answer, /find out whether it has been opened/)
    assert.match(about, /Senders never learn whether their message was read, unless you open a link they put in it: a website of theirs would see the visit, and a Slynk link they sent would show as used if they tried it themselves\./)
  })

  test('wording: short and plain', () => {
    for (const [k, v] of Object.entries(copy)) {
      if (!k.startsWith('LINK_') || typeof v !== 'string') continue
      assert.ok(v.length <= 160, `${k} is short`)
      assert.ok(!/\b(we|us|our|server|hide|hidden|gateway|cMix|mixnet)\b/i.test(v), `${k}: ${v}`)
    }
    assert.match(copy.LINK_SLYNK_TITLE, /\?$/)
    assert.match(copy.LINK_OTHER_TITLE, /\?$/)
    assert.match(copy.LINK_OTHER, /internet address/)
    // The network, not the device: another device on the same Wi-Fi shares the internet address.
    assert.match(copy.LINK_CAREFUL, /another network, or with a VPN/)
    assert.ok(!/device/.test(copy.LINK_CAREFUL))
    // Looking after whoever sent it, not what it holds (never a hint of anything shady).
    assert.match(copy.LINK_CAREFUL, /^To better protect whoever sent it/)
    assert.ok(!/sensitive|secret|illegal/i.test(copy.LINK_CAREFUL))
    assert.match(read('../index.html'), /<p id="link-warn-text"><\/p>\s*<p class="link-warn-careful" id="link-warn-careful" data-copy="LINK_CAREFUL" hidden><\/p>/)
    for (const text of [copy.LINK_SLYNK_INBOX, copy.LINK_SLYNK_TAB, copy.LINK_PAGE, copy.LINK_OTHER, copy.LINK_GO]) assert.match(text, /new tab/)
  })
})
