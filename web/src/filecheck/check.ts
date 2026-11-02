// Plain checks of a file that warn whoever receives it:
// a program, macros, scripts,
// a document that fetches something from the internet when it's opened, and
// the same for each file inside a zip (by name only in a tar, a locked zip
// or a zip inside a zip). What a file is and what's packed in it, read
// from its structure, never what a photo, video or recording shows. Runs in
// the cleaner's worker (strip/stripWorker.ts), so the page stays free, and in
// Node for the tests. Never throws: a file it can't read gets no warning,
// which proves nothing, as the About page says.
import { Gunzip } from 'fflate'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, type PDFObject, PDFRef, PDFStream, PDFString } from 'pdf-lib'
import { latin1, startsWith, u32be, u32le } from '../strip/bytes.ts'
import { inflateRaw } from '../strip/inflate.ts'
import { compoundNames, describeOther } from '../strip/sniff.ts'
import { readZipDirectory, shownName, type ZipEntry } from '../strip/zipdir.ts'
import type { InsideFile, Warning, WarningKind } from './types.ts'

// Endings Windows, macOS or Linux run, or that run something, when opened: most of Outlook's
// blocked list (support.microsoft.com, "Blocked attachments in Outlook") and their Mac and Linux
// counterparts. Certificates, mailbox files and the like on that list are left out: they don't run.
const PROGRAM = new Set([
  'exe', 'com', 'scr', 'pif', 'cpl', 'dll', 'ocx', 'sys', 'drv', 'msi', 'msp', 'mst', 'msu', 'msix', 'msixbundle',
  'appx', 'appxbundle', 'application', 'gadget', 'xll', 'jar', 'apk', 'xapk', 'aab', 'ipa', 'app', 'pkg', 'mpkg',
  'deb', 'rpm', 'appimage', 'run', 'xbap',
])
// Windows runs these only if they really are programs (they start "MZ"): named so but not one,
// nothing runs, so there's nothing to say.
const PE_ONLY = new Set(['exe', 'scr', 'cpl', 'dll', 'ocx', 'sys', 'drv'])
const SCRIPT = new Set([
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'msh', 'msh1', 'msh2', 'mshxml',
  'vb', 'vbs', 'vbe', 'vbp', 'js', 'jse', 'wsf', 'wsh', 'wsc', 'ws', 'sct', 'hta', 'htc', 'sh', 'bash', 'csh', 'ksh',
  'zsh', 'command', 'tool', 'scpt', 'applescript', 'py', 'pyc', 'pyo', 'pyw', 'pyz', 'pyzw', 'pl', 'reg', 'inf', 'ins',
  'isp', 'msc', 'chm', 'hlp', 'jnlp', 'appref-ms', 'lnk', 'url', 'website', 'desktop', 'scf', 'search-ms',
  'searchconnector-ms', 'settingcontent-ms', 'library-ms', 'shb', 'shs', 'xnk', 'wsb', 'diagcab', 'mcf',
  'printerexport', 'vsmacros', 'ade', 'adp', 'mde', 'mdb', 'accde',
  // A Mac's internet, network and file locations, as .url and .website are Windows' (the review, 2026-10-26).
  'webloc', 'inetloc', 'fileloc',
])
const DISK = new Set(['iso', 'img', 'vhd', 'vhdx', 'dmg', 'udf'])
// Office's endings for files with macros, for when only a file's name can be judged.
const MACRO_ENDINGS = new Set(['docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam', 'ppsm', 'sldm'])
// Office's and LibreOffice's own endings: a file with one is a document, checked as one.
const DOCUMENT_ENDINGS = new Set([
  'docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm', 'xlam', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm',
  'ppam', 'sldx', 'sldm', 'odt', 'ods', 'odp', 'odg', 'odf', 'ott', 'ots', 'otp', 'otg',
])
// Opened in a browser: web pages and SVGs, and (the review, 2026-10-26) a gzipped SVG.
const WEB = new Set(['html', 'htm', 'xhtml', 'xht', 'shtml', 'mht', 'mhtml', 'svg', 'svgz'])
// XML and its style sheets, which Windows opens in Edge: a page only when it says it renders as one
// (a style sheet, or an XHTML or SVG root, or an entity that could name one), not a file of data.
const XML = new Set(['xml', 'xsl', 'xslt'])
const XML_PAGE = /<\?xml-stylesheet|www\.w3\.org\/(?:1999\/xhtml|2000\/svg)|<!ENTITY/

// The order lines are shown in: what runs first, then what can, then what's out of sight.
const ORDER: WarningKind[] = [
  'disguised', 'program', 'script', 'disk', 'macros', 'internet', 'web-page', 'pdf-scripts', 'pdf-launch', 'web-scripts', 'inside',
  'attachments', 'locked', 'unread',
]

/** How far any one part of a document is decompressed: real ones are far smaller. */
const PART_CAP = 8_000_000
/** How many parts of a document are read for links to outside content. */
const MAX_PARTS = 400
/** How many sites a line names; the rest are counted. */
const MAX_HOSTS = 20
// The files inside a zip are each checked as a file of their own, within these: a small zip
// can unpack to far more. Past them, files are judged by their names.
const INSIDE_FILES = 2_000
const INSIDE_BYTES = 64_000_000
const INSIDE_FILE = 25_000_000

/** The name's last ending, lower case, or '' (".tar.gz" is "gz"). */
export function endingOf(name: string): string {
  const base = name.replace(/[.\s]+$/, '').split(/[/\\]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  // ".bat" alone is a batch file to Windows too (the review, 2026-10-26: in a zip, it went unwarned).
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : ''
}

const runs = (ending: string) => PROGRAM.has(ending) || SCRIPT.has(ending)

/** The site a link to outside content points at, or null for a local path, a mail address or junk. */
export function hostOf(target: string): string | null {
  let t = target.trim().replace(/^["']+|["']+$/g, '')
  // A network share: \\server\share\file, which Windows reaches by asking the server, login and all.
  const share = /^(?:\\\\|\/\/)([^\\/\s]+)/.exec(t)
  if (share && t.startsWith('\\\\')) t = `file://${share[1]}/`
  else if (t.startsWith('//')) t = `https:${t}`
  let url: URL
  try {
    url = new URL(t)
  } catch {
    return null
  }
  if (!/^(https?|ftp|file):$/.test(url.protocol)) return null
  // URL gives the international form (xn--…) of a name written in other alphabets, so look-alikes show.
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || !/^[a-z0-9.\-[\]:]+$/.test(host)) return null
  return host
}

function addHost(hosts: string[], target: string) {
  if (hosts.length >= MAX_HOSTS) return
  // As a browser reads an address: tabs and line breaks in it ignored, and spaces, control characters
  // and quotes before it. Only one with a scheme hostOf takes, or a share or // address, can name a
  // site: a crafted page of a million others isn't parsed a million times.
  let t = /[\t\n\r]/.test(target) ? target.replace(/[\t\n\r]/g, '') : target
  const first = t.charCodeAt(0)
  if (first <= 32 || first === 34 || first === 39) t = t.replace(/^[\x00-\x20"']+/, '')
  if (!/^(?:(?:https?|ftp|file):|[\\/]{2})/i.test(t)) return
  const h = hostOf(t)
  if (h && !hosts.includes(h) && hosts.length < MAX_HOSTS) hosts.push(h)
}

const unescapeXml = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
    return Number.isFinite(n) && n < 0x110000 ? String.fromCodePoint(n) : m
  })

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag)
  return m ? unescapeXml(m[2] ?? m[3] ?? '') : undefined
}

/**
 * Each tag in XML or HTML text whose name matches (a sticky pattern tried at its "<"), with the text
 * after it up to the next tag. One pass: a tag runs to its ">" only if no "<" comes first, so tags
 * never overlap and no text, however crafted, makes it slow (patterns like <x[^>]*> could take
 * minutes on a few megabytes without a ">").
 */
function* tags(text: string, name: RegExp): Generator<{ tag: string; after: string }> {
  let gt = -1
  for (let i = text.indexOf('<'); i >= 0; ) {
    const next = text.indexOf('<', i + 1)
    if (gt < i) gt = text.indexOf('>', i)
    if (gt < 0) return
    name.lastIndex = i + 1
    if ((next < 0 || gt < next) && name.test(text)) yield { tag: text.slice(i, gt + 1), after: text.slice(gt + 1, next < 0 ? text.length : next) }
    i = next
  }
}

// A Word field that brings in a picture or text from elsewhere when the document's opened
// (INCLUDEPICTURE, INCLUDETEXT; LINK for an object), with its address.
const FIELD = /\b(?:INCLUDEPICTURE|INCLUDETEXT|LINK\s+[\w.]+)\s+(?:\\[*\w]+\s+)*"?((?:https?|ftp|file):\/\/[^"\s\\]+|\\{2,4}[^"\s\\]+)/gi

function fieldHosts(text: string, hosts: string[]) {
  // A share's backslashes come doubled in a field's code: \\\\server\\share is \\server\share.
  for (const m of text.matchAll(FIELD)) addHost(hosts, m[1].startsWith('\\') ? `\\\\${m[1].replace(/^\\+/, '')}` : m[1])
}

// A web page or SVG opens in a browser, which loads whatever it points at online and runs its
// scripts: a tracking picture, or one tucked in a script, shows the site the internet address of
// whoever opened it. So every one is warned of by its name, whatever
// is (or seems to be) in it, which tricks can't get round, with some of the sites it loads from as
// it opens where they can be read ("such as": a page can always hide one). Links aren't among
// them: they go nowhere until clicked.

/**
 * A web page's text as a browser reads it: UTF-16 by its byte-order mark, else UTF-8; and without
 * ISO-2022-JP's escapes, which a page naming that encoding can hide "<script" behind (the review).
 */
function webText(b: Uint8Array): string {
  const head = b.subarray(0, Math.min(b.length, PART_CAP))
  const utf16 = head[0] === 0xff && head[1] === 0xfe ? 'utf-16le' : head[0] === 0xfe && head[1] === 0xff ? 'utf-16be' : 'utf-8'
  const text = new TextDecoder(utf16).decode(head)
  return text.includes('\x1b') ? text.replace(/\x1b[$()]{1,2}[@-Z]/g, '') : text
}

// Character references a browser reads in an address, beside XML's: "https&colon;//" is "https://".
const HTML_NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', sol: '/', period: '.', quest: '?', num: '#', equals: '=', tab: '\t', newline: '\n' }
const unescapeHtml = (s: string) =>
  s.includes('&')
    ? s.replace(/&(?:#x([0-9a-f]{1,6});?|#(\d{1,7});?|([a-z]{2,8});)/gi, (m, hex: string, dec: string, named: string) => {
        if (named) return HTML_NAMED[named.toLowerCase()] ?? m
        const n = hex ? parseInt(hex, 16) : parseInt(dec, 10)
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
      })
    : s

/** A tag's attributes kept for looking at, at most: a crafted tag of millions isn't held in memory. */
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13
// Character codes, not one-letter strings: the reader runs over every character of a page of megabytes.
const SLASH = 47
const GT = 62
const EQ = 61
const MAX_ATTRS = 1_000

// Elements whose insides a browser reads as text, not tags: skipped to their end tag in one go.
const RAW = new Set(['style', 'script', 'textarea', 'title', 'xmp', 'noscript', 'noembed', 'noframes', 'iframe', 'plaintext'])

/**
 * Each start tag of a web page as a browser reads it, in one pass: its name, and its attributes after
 * a space, a slash or a quoted value, quoted or not, so neither <img/src=…>, src="x"onerror=…, nor a
 * "<" or ">" in quotes hides one (the review, 2026-10-26). Comments are skipped, as a browser skips
 * them, and so are the insides of a <style> or <script> (given as inside); a quote never closed ends
 * the page, as it does in a browser. scripts: an attribute that runs one (onload=…) was seen, however
 * many came before it.
 */
function* pageTags(text: string): Generator<{ name: string; attrs: [string, string][]; scripts: boolean; inside?: string }> {
  const n = text.length
  let i = 0
  while ((i = text.indexOf('<', i)) >= 0) {
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      if (close < 0) return
      i = close + 3
      continue
    }
    let j = i + 1
    const first = text.charCodeAt(j) | 32
    if (!(first >= 97 && first <= 122)) {
      i = j
      continue
    }
    while (j < n && !isSpace(text.charCodeAt(j)) && text.charCodeAt(j) !== SLASH && text.charCodeAt(j) !== GT) j++
    const name = text.slice(i + 1, j).toLowerCase()
    const attrs: [string, string][] = []
    let scripts = false
    for (;;) {
      while (j < n && (isSpace(text.charCodeAt(j)) || text.charCodeAt(j) === SLASH)) j++
      if (j >= n || text.charCodeAt(j) === GT) break
      let k = j + 1 // a name may start with "=", as a browser reads it
      while (k < n) {
        const c = text.charCodeAt(k)
        if (isSpace(c) || c === SLASH || c === GT || c === EQ) break
        k++
      }
      const key = text.slice(j, k).toLowerCase()
      j = k
      while (j < n && isSpace(text.charCodeAt(j))) j++
      let value = ''
      if (text.charCodeAt(j) === EQ) {
        j++
        while (j < n && isSpace(text.charCodeAt(j))) j++
        const q = text[j]
        if (q === '"' || q === "'") {
          const close = text.indexOf(q, j + 1)
          if (close < 0) return
          value = text.slice(j + 1, close)
          j = close + 1
        } else {
          k = j
          while (k < n && !isSpace(text.charCodeAt(k)) && text.charCodeAt(k) !== GT) k++
          value = text.slice(j, k)
          j = k
        }
      }
      if (key.length > 2 && key.startsWith('on')) scripts = true
      if (attrs.length < MAX_ATTRS) attrs.push([key, unescapeHtml(value)])
    }
    if (RAW.has(name)) {
      const end = new RegExp(`</${name}`, 'ig')
      end.lastIndex = j
      const close = end.exec(text)?.index ?? n
      yield { name, attrs, scripts, inside: text.slice(j + 1, close) }
      i = close
    } else {
      yield { name, attrs, scripts }
      i = j
    }
  }
}

// Attributes whose address a browser fetches as the page opens: pictures, frames, objects, scripts.
const LOADS = new Set(['src', 'srcset', 'imagesrcset', 'poster', 'data', 'background', 'lowsrc', 'dynsrc', 'manifest', 'archive', 'codebase'])
// Tags whose href is fetched as the page opens: an SVG's picture or script, and <base>, which the
// page's other addresses then go to. Not a link's, nor <use>'s, which browsers won't fetch from elsewhere.
const HREF_LOADS = new Set(['base', 'image', 'feimage', 'script'])
// The kinds of <link> a browser fetches; not a canonical or alternate one, which only names a page.
const LINK_LOADS = /(?:^|\s)(?:stylesheet|icon|shortcut|apple-touch-icon(?:-precomposed)?|mask-icon|preload|prefetch|preconnect|dns-prefetch|modulepreload|manifest|prerender|import)(?:\s|$)/i
// Anywhere in a page, a script tag or a javascript: address (handlers, onload= and the like, are looked for in its tags).
const RUNS = /<script[\s>/]|\bjavascript\s*:/i
// A page inside the page, as data, read as a page too.
const INNER = /^\s*data:\s*(?:text\/html|image\/svg\+xml|application\/xhtml\+xml)[^,]*,/i

/** Sites a style sheet fetches from: its url()s and @imports. A url() is never more than one, so its address stops at "(". */
function cssHosts(css: string, hosts: string[]) {
  for (const m of css.matchAll(/url\(\s*(['"]?)([^'"()\s]+)\1\s*\)|@import\s+(['"])([^'"]+)\3/gi)) addHost(hosts, m[2] ?? m[4])
}

/** A data: address's text, as far as a megabyte; '' if it can't be read. */
function dataText(address: string): string {
  const comma = address.indexOf(',')
  const body = address.slice(comma + 1, comma + 1 + 1_400_000)
  try {
    return /;\s*base64\s*,/i.test(address.slice(0, comma + 1)) ? atob(body.replace(/\s+/g, '').replace(/=+$/, '').slice(0, 1_400_000)) : decodeURIComponent(body)
  } catch {
    return ''
  }
}

/**
 * Some of the sites a web page loads from as soon as it's opened, as far as its text shows them, and
 * whether it runs scripts; a page inside it (srcdoc, or data in a frame), to a depth of two, as one.
 */
function readPage(text: string, hosts: string[] = [], depth = 0): { hosts: string[]; scripts: boolean } {
  let scripts = RUNS.test(text)
  const inner = (page: string) => {
    if (depth < 2 && readPage(page, hosts, depth + 1).scripts) scripts = true
  }
  for (const { name, attrs, scripts: runs, inside } of pageTags(text)) {
    if (runs || name === 'script') scripts = true
    const get = (key: string) => attrs.find(([k]) => k === key)?.[1]
    // <meta http-equiv="refresh" content="0; url=…">: off to another address as it opens, "url=" or not.
    if (name === 'meta' && /refresh/i.test(get('http-equiv') ?? '')) {
      const to = /^\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?['"]?([^'"\s;]+)/i.exec(get('content') ?? '')
      if (to) addHost(hosts, to[1])
    }
    const linkLoads = name === 'link' && LINK_LOADS.test(get('rel') ?? '')
    for (const [key, value] of attrs) {
      if (LOADS.has(key)) {
        // A srcset's addresses each end at a space, before their size; any other's is the whole value.
        if (key.endsWith('srcset')) for (const part of value.split(',')) addHost(hosts, part.trim().split(/\s+/)[0])
        else addHost(hosts, value)
        // Only a value starting "d" (or a space) can be data: the test isn't run for every picture.
        const c = value.charCodeAt(0) | 32
        if ((c === 100 || c <= 32) && INNER.test(value)) inner(dataText(value))
      } else if ((key === 'href' || key === 'xlink:href') && (HREF_LOADS.has(name) || linkLoads)) addHost(hosts, value)
      else if (key === 'style') cssHosts(value, hosts)
      else if (key === 'srcdoc') inner(value)
    }
    if (name === 'style' && inside) cssHosts(inside, hosts)
  }
  // <?xml-stylesheet href="…"?> before an XML page or SVG: a style sheet fetched as it opens.
  for (let at = text.indexOf('<?xml-stylesheet'), seen = 0; at >= 0 && seen < 50; at = text.indexOf('<?xml-stylesheet', at + 1), seen++) {
    const end = text.indexOf('?>', at)
    const href = /\shref\s*=\s*(["'])([^"']*)\1/i.exec(text.slice(at, end < 0 ? at + 2000 : Math.min(end, at + 2000)))
    if (href) addHost(hosts, unescapeHtml(href[2]))
  }
  return { hosts, scripts }
}

/**
 * A web page or SVG: always that it can contact websites, with some it does; and whether it has
 * scripts. An .mht page, which browsers open with only what it holds and no scripts (Chrome, Edge),
 * gets the first alone.
 */
function checkWeb(b: Uint8Array, ending: string, out: Warning[]) {
  if (ending === 'mht' || ending === 'mhtml') return void out.push({ kind: 'web-page', hosts: [] })
  const { hosts, scripts } = readPage(webText(b))
  out.push({ kind: 'web-page', hosts })
  if (scripts) out.push({ kind: 'web-scripts' })
}

// A playlist: a media player fetches the addresses in it as it opens (the review, 2026-10-26).
const PLAYLIST = new Set(['m3u', 'm3u8', 'pls', 'asx', 'wpl', 'xspf'])

/** The sites a playlist streams from, any address in it with one. */
function checkPlaylist(b: Uint8Array, out: Warning[]) {
  const hosts: string[] = []
  const text = new TextDecoder().decode(b.subarray(0, Math.min(b.length, PART_CAP)))
  for (const m of text.matchAll(/\b(?:https?|ftp|file):\/\/[^\s"'<>]+|\\\\[^\\\s"'<>]+/gi)) {
    addHost(hosts, m[0])
    if (hosts.length >= MAX_HOSTS) break
  }
  if (hosts.length) out.push({ kind: 'internet', hosts, opensIn: 'player' })
}

/** A ZIP's parts, readable one at a time with a cap; null if it isn't a ZIP the cleaner would read either. */
function zipParts(b: Uint8Array): { entries: ZipEntry[]; read: (e: ZipEntry) => string | undefined } | null {
  let entries: ZipEntry[]
  try {
    entries = readZipDirectory(b)
  } catch {
    return null
  }
  const read = (e: ZipEntry) => {
    if (e.flags & 1 || e.usize > PART_CAP) return undefined
    const raw = b.subarray(e.dataOffset, e.dataOffset + e.csize)
    try {
      const out = e.method === 0 ? raw : e.method === 8 ? inflateRaw(raw, PART_CAP) : undefined
      return out && new TextDecoder().decode(out)
    } catch {
      return undefined
    }
  }
  return { entries, read }
}

/** Word, Excel and PowerPoint (and their macro-enabled and binary kinds): macros, and outside content fetched on opening. */
function checkOoxml(entries: ZipEntry[], read: (e: ZipEntry) => string | undefined, out: Warning[]) {
  const types = entries.find((e) => e.name === '[Content_Types].xml')
  const typeText = types ? (read(types) ?? '') : ''
  if (
    entries.some((e) => /(^|\/)vbaProject\.bin$/i.test(e.name) || /^xl\/(intl-)?macrosheets\//i.test(e.name)) ||
    /macroEnabled|vbaProject/i.test(typeText)
  )
    out.push({ kind: 'macros' })
  const hosts: string[] = []
  let parts = 0
  for (const e of entries) {
    if (parts >= MAX_PARTS) break
    if (/\.rels$/i.test(e.name)) {
      parts++
      const text = read(e)
      if (!text) continue
      for (const { tag } of tags(text, /(?:\w+:)?Relationship\b/y)) {
        if (attr(tag, 'TargetMode') !== 'External') continue
        // A hyperlink goes nowhere until it's clicked; templates, linked pictures, frames and
        // objects are fetched as the file opens.
        if (/\/hyperlink$/i.test(attr(tag, 'Type') ?? '')) continue
        addHost(hosts, attr(tag, 'Target') ?? '')
      }
    } else if (/^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/i.test(e.name)) {
      parts++
      const text = read(e)
      if (!text) continue
      const fields = [...tags(text, /w:instrText\b/y)].map((t) => t.after).join('')
      const simple = [...tags(text, /w:fldSimple\b/y)].map((t) => attr(t.tag, 'w:instr') ?? '').join(' ')
      fieldHosts(unescapeXml(fields) + ' ' + simple, hosts)
    }
  }
  if (hosts.length) out.push({ kind: 'internet', hosts, opensIn: 'office' })
}

/** LibreOffice's files: macros (a Basic module, a script, or an event that calls one), and linked outside content. */
function checkOdf(entries: ZipEntry[], read: (e: ZipEntry) => string | undefined, out: Warning[]) {
  const content = entries.filter((e) => /^(content|styles)\.xml$/.test(e.name)).map((e) => read(e) ?? '')
  const module = entries.some(
    (e) => (/^Basic\/[^/]+\/[^/]+\.xml$/.test(e.name) && !/\/(script|dialog)-l[bc]\.xml$/.test(e.name)) || /^Scripts\/.+[^/]$/.test(e.name),
  )
  if (module || content.some((t) => /(?:vnd\.sun\.star\.script:|macro:\/\/)/i.test(t))) out.push({ kind: 'macros' })
  const hosts: string[] = []
  for (const text of content) {
    // Pictures, objects, frames and sections linked from elsewhere, not hyperlinks (text:a, draw:a).
    for (const { tag } of tags(text, /(?:draw:image|draw:object|draw:object-ole|draw:plugin|draw:applet|draw:floating-frame|text:section-source|table:table-source)\b/y)) {
      const href = attr(tag, 'xlink:href')
      if (href) addHost(hosts, href)
    }
  }
  if (hosts.length) out.push({ kind: 'internet', hosts, opensIn: 'libreoffice' })
}

/** Every name a zip's headers claim, local and in its index, read leniently, without reading any file. */
function looseNames(b: Uint8Array): string[] {
  const names = new Set<string>()
  for (let i = b.indexOf(0x50); i >= 0 && names.size < 65_536; i = b.indexOf(0x50, i + 1)) {
    if (b[i + 1] !== 0x4b || i + 46 > b.length) continue
    const local = b[i + 2] === 3 && b[i + 3] === 4
    if (!local && !(b[i + 2] === 1 && b[i + 3] === 2)) continue
    const at = i + (local ? 26 : 28)
    const length = b[at] | (b[at + 1] << 8)
    const start = i + (local ? 30 : 46)
    if (length && start + length <= b.length) names.add(latin1(b, start, start + length))
  }
  return [...names]
}

/** What a file's name alone says: a program, a script or a disk image, or nothing. */
function byName(name: string): Warning[] {
  const ending = endingOf(name)
  if (PROGRAM.has(ending)) return [{ kind: 'program' }]
  if (SCRIPT.has(ending)) return [{ kind: 'script' }]
  if (DISK.has(ending)) return [{ kind: 'disk' }]
  if (MACRO_ENDINGS.has(ending)) return [{ kind: 'macros' }]
  if (WEB.has(ending)) return [{ kind: 'web-page', hosts: [] }]
  return []
}

/**
 * The files in an archive that have warnings, one entry for each Mac app (a folder whose program
 * has no ending of its own) and none for the rest of its folder. read gives a file's bytes, or
 * undefined to judge it by its name.
 */
async function insideFiles(names: string[], read: (i: number) => Uint8Array | undefined): Promise<InsideFile[]> {
  const files: InsideFile[] = []
  // A real Mac app (a folder with its program in Contents/MacOS) is listed once, as a program, and
  // its own parts aren't; a folder that's only named like one is checked as any other.
  const apps = new Set(names.map((n) => /^(.*?\.app)\/Contents\/MacOS\/[^/]/i.exec(n)?.[1]).filter((a) => a !== undefined))
  const listed = new Set<string>()
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    if (name.endsWith('/')) continue
    const app = /^(.*?\.app)\//i.exec(name)?.[1]
    if (app !== undefined && apps.has(app)) {
      if (!listed.has(app)) {
        listed.add(app)
        files.push({ name: app, warnings: [{ kind: 'program' }] })
      }
      continue
    }
    // Past the first INSIDE_FILES, by name only.
    const data = i < INSIDE_FILES ? read(i) : undefined
    const warnings = data ? await checkBytes(data, name, false) : byName(name)
    if (warnings.length) files.push({ name, warnings })
  }
  return files
}

/** An ordinary ZIP: each file inside checked as a file of its own (by name when locked, or in a zip inside a zip), and whether it's locked. */
async function checkZipArchive(b: Uint8Array, entries: ZipEntry[], out: Warning[], deep: boolean) {
  let budget = INSIDE_BYTES
  const read = (i: number) => {
    const e = entries[i]
    if (!deep || e.flags & 1 || e.usize > Math.min(INSIDE_FILE, budget) || (e.method !== 0 && e.method !== 8)) return undefined
    const raw = b.subarray(e.dataOffset, e.dataOffset + e.csize)
    try {
      const data = e.method === 0 ? raw : inflateRaw(raw, e.usize)
      budget -= data.length
      return data
    } catch {
      return undefined
    }
  }
  // Each under its name as it's shown: decoded as the zip meant it. Then, by name, any file a header
  // claims that the index doesn't list (hidden between them, where a streaming unzip tool finds it).
  const listed = new Set(entries.map((e) => e.name))
  const hidden = looseNames(b).filter((n) => !listed.has(n))
  const files = await insideFiles(
    [...entries.map((e) => shownName(e.name, !!(e.flags & 0x800))), ...hidden.map((n) => shownName(n, false))],
    (i) => (i < entries.length ? read(i) : undefined),
  )
  if (files.length) out.push({ kind: 'inside', files })
  if (entries.some((e) => e.flags & 1)) out.push({ kind: 'locked' })
}

/** The names in a tar archive (plain, or gzipped and read no further than a cap). */
function tarNames(b: Uint8Array): string[] {
  const names: string[] = []
  for (let p = 0; p + 512 <= b.length && names.length < 10_000; ) {
    if (b.subarray(p, p + 512).every((v) => v === 0)) break
    if (!startsWith(b, 'ustar', p + 257)) break
    const field = (i: number, n: number) => latin1(b, p + i, p + i + n).replace(/\0.*$/s, '')
    const prefix = field(345, 155)
    names.push(prefix ? `${prefix}/${field(0, 100)}` : field(0, 100))
    const size = parseInt(field(124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) break
    p += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

function gunzipPrefix(b: Uint8Array, max: number): Uint8Array {
  const parts: Uint8Array[] = []
  let total = 0
  const stream = new Gunzip()
  const enough = new Error('enough')
  stream.ondata = (chunk: Uint8Array) => {
    parts.push(chunk)
    total += chunk.length
    if (total > max) throw enough
  }
  try {
    for (let i = 0; i < b.length; i += 4096) stream.push(b.subarray(i, i + 4096), i + 4096 >= b.length)
  } catch {
    // Damaged, or as far as we read: what came out is enough for the names.
  }
  const out = new Uint8Array(Math.min(total, max))
  let at = 0
  for (const p of parts) {
    if (at >= out.length) break
    out.set(p.subarray(0, out.length - at), at)
    at += p.length
  }
  return out
}

/** Text in the encodings Word's older files and RTF objects keep it in: plain bytes, and UTF-16 from either byte. */
function bothEncodings(b: Uint8Array): string {
  const wide = new TextDecoder('utf-16le')
  const even = b.subarray(0, b.length & ~1)
  const odd = b.subarray(1, 1 + ((b.length - 1) & ~1))
  return `${latin1(b)}\n${wide.decode(even)}\n${wide.decode(odd)}`
}

/** RTF: a template, a picture or text, or a linked object fetched from elsewhere when it opens. */
function checkRtf(b: Uint8Array, out: Warning[]) {
  const text = latin1(b, 0, Math.min(b.length, 20_000_000))
  const hosts: string[] = []
  for (const m of text.matchAll(/\\\*\\template\s*([^}\s]+)/g)) addHost(hosts, m[1])
  fieldHosts(text.replace(/\\\\/g, '\\'), hosts)
  // A linked object (OLE2Link, the route of CVE-2017-0199) carries its address inside its hex data.
  for (const m of text.matchAll(/\\objdata\s*([0-9a-fA-F\s]{16,})/g)) {
    const hex = m[1].replace(/\s+/g, '').slice(0, 131_072)
    const data = new Uint8Array(hex.length >> 1)
    for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16)
    const all = bothEncodings(data)
    if (!/OLE2Link/i.test(all)) continue
    for (const u of all.matchAll(/(?:https?|ftp|file):\/\/[\x21-\x7e]+/g)) addHost(hosts, u[0])
  }
  if (hosts.length) out.push({ kind: 'internet', hosts, opensIn: 'word' })
}

/** Office's older files (and password-protected new ones), from their Compound File directory. */
function checkCompound(b: Uint8Array, out: Warning[]) {
  const names = compoundNames(b)
  if (!names) return
  if (names.includes('EncryptionInfo') || names.includes('EncryptedPackage')) {
    out.push({ kind: 'locked' })
    return
  }
  if (names.some((n) => n === 'VBA' || n === '_VBA_PROJECT' || n === '_VBA_PROJECT_CUR' || n === 'Macros')) out.push({ kind: 'macros' })
  if (names.includes('WordDocument')) {
    const hosts: string[] = []
    fieldHosts(bothEncodings(b.subarray(0, Math.min(b.length, 8_000_000))), hosts)
    if (hosts.length) out.push({ kind: 'internet', hosts, opensIn: 'word' })
  }
}

const N = (s: string) => PDFName.of(s)
const named = (o: PDFObject | undefined, name: string) => o instanceof PDFName && o.decodeText() === name

function pdfText(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined
}

/** PDFs: scripts (and whether they run on opening), files attached, launching programs, and the internet on opening. */
async function checkPdf(b: Uint8Array, out: Warning[]) {
  let doc: PDFDocument
  try {
    // As the cleaner reads PDFs: a damaged object stops it (pdf-lib would otherwise log each one).
    doc = await PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: true, parseSpeed: Infinity })
  } catch {
    return
  }
  const ctx = doc.context
  const look = (o: PDFObject | undefined) => (o instanceof PDFRef ? ctx.lookup(o) : o)
  let scripts = false
  let launch = false
  let attached = false
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    const stack: PDFObject[] = [obj]
    for (let guard = 0; stack.length && guard < 100_000; guard++) {
      const o = stack.pop()!
      if (o instanceof PDFStream) stack.push(o.dict)
      else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) stack.push(o.get(i))
      else if (o instanceof PDFDict) {
        const s = o.get(N('S'))
        if (o.has(N('JS')) || named(s, 'JavaScript')) scripts = true
        if (named(s, 'Launch')) launch = true
        if (named(o.get(N('Type')), 'EmbeddedFile') || o.has(N('EmbeddedFiles')) || named(o.get(N('Subtype')), 'FileAttachment')) attached = true
        for (const [, v] of o.entries()) if (!(v instanceof PDFRef)) stack.push(v)
      }
    }
  }
  // What runs as it opens: the open action, the first page's, and document-level scripts.
  const catalog = doc.catalog
  const names = look(catalog.get(N('Names')))
  let onOpen = names instanceof PDFDict && names.has(N('JavaScript'))
  const first = doc.getPageCount() ? doc.getPage(0).node : undefined
  const firstAA = look(first?.get(N('AA')))
  const openers = [look(catalog.get(N('OpenAction'))), firstAA instanceof PDFDict ? look(firstAA.get(N('O'))) : undefined]
  const hosts: string[] = []
  const encrypted = doc.isEncrypted // its strings can't be read, so neither can its addresses
  for (let action of openers) {
    for (let hops = 0; action instanceof PDFDict && hops < 50; hops++) {
      const s = action.get(N('S'))
      if (named(s, 'JavaScript')) onOpen = true
      if (!encrypted) {
        if (named(s, 'URI')) addHost(hosts, pdfText(look(action.get(N('URI')))) ?? '')
        if (named(s, 'SubmitForm') || named(s, 'ImportData') || named(s, 'GoToR') || named(s, 'GoToE') || named(s, 'Launch')) {
          const f = look(action.get(N('F')))
          addHost(hosts, pdfText(f) ?? (f instanceof PDFDict ? (pdfText(look(f.get(N('F')))) ?? pdfText(look(f.get(N('UF')))) ?? '') : ''))
        }
      }
      const next = look(action.get(N('Next')))
      action = next instanceof PDFArray ? look(next.get(0)) : next
    }
  }
  if (hosts.length) out.push({ kind: 'internet', hosts, opensIn: 'pdf' })
  if (scripts || onOpen) out.push({ kind: 'pdf-scripts', onOpen })
  if (launch) out.push({ kind: 'pdf-launch' })
  if (attached) out.push({ kind: 'attachments' })
}

/** What the first bytes say a file runs as: a program, a script or shortcut, a disk image, or nothing. */
function realKind(b: Uint8Array, ending: string): 'program' | 'script' | 'disk' | null {
  if (startsWith(b, 'MZ') && b.length >= 64) {
    const pe = u32le(b, 0x3c)
    if (pe + 4 <= b.length && startsWith(b, 'PE\0\0', pe)) return 'program'
  }
  if (startsWith(b, '\x7fELF')) return 'program'
  const magic = b.length >= 8 ? u32be(b, 0) : 0
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xbebafeca].includes(magic)) return 'program'
  // A Mac "fat" program and a Java class both start CAFEBABE: a program lists a few
  // processor types next, a class its version, which is 45 or more.
  if (magic === 0xcafebabe && u32be(b, 4) > 0 && u32be(b, 4) < 30) return 'program'
  // A script with no ending runs as one where it's marked to; one called notes.txt opens in a
  // text editor. (Shortcuts and scripts with their own endings are known by those.)
  if (startsWith(b, '#!') && !ending) return 'script'
  if ([0x8001, 0x8801, 0x9001].some((i) => startsWith(b, 'CD001', i))) return 'disk'
  if (startsWith(b, 'vhdxfile') || (b.length >= 512 && (startsWith(b, 'conectix', b.length - 512) || startsWith(b, 'koly', b.length - 512)))) return 'disk'
  return null
}

/**
 * The warnings for a file, most important first: none if there's nothing to say, or it can't be
 * read. deep: a zip's files are read and checked too (not for a zip inside a zip).
 */
export async function checkBytes(b: Uint8Array, name: string, deep = true): Promise<Warning[]> {
  const out: Warning[] = []
  try {
    await checkInto(b, name, out, deep)
  } catch {
    // A file that trips a reader gets what was found before it.
  }
  const seen = new Set<WarningKind>()
  return out.filter((w) => !seen.has(w.kind) && seen.add(w.kind)).sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind))
}

async function checkInto(b: Uint8Array, name: string, out: Warning[], deep: boolean) {
  const ending = endingOf(name)
  const claimed = ending ? `.${ending}` : ''
  let real = realKind(b, ending)
  const zip = startsWith(b, 'PK\x03\x04') || startsWith(b, 'PK\x05\x06') ? zipParts(b) : null
  if (zip) {
    const names = new Set(zip.entries.map((e) => e.name))
    // Android apps and Java programs are ZIPs too.
    if ((names.has('AndroidManifest.xml') && names.has('classes.dex')) || (names.has('META-INF/MANIFEST.MF') && zip.entries.some((e) => e.name.endsWith('.class'))))
      real = 'program'
  }
  if (real === 'program' || real === 'disk') {
    const fits = real === 'program' ? runs(ending) : DISK.has(ending)
    out.push(claimed && !fits ? { kind: 'disguised', claimed, real } : { kind: real })
  } else if (real === 'script') out.push({ kind: 'script' })
  else if (PROGRAM.has(ending) && !PE_ONLY.has(ending)) out.push({ kind: 'program' })
  else if (SCRIPT.has(ending)) out.push({ kind: 'script' })
  else if (DISK.has(ending)) out.push({ kind: 'disk' })
  if (real === 'program') return
  if (WEB.has(ending)) checkWeb(b, ending, out)
  else if (XML.has(ending) && XML_PAGE.test(webText(b))) checkWeb(b, ending, out)
  if (PLAYLIST.has(ending)) checkPlaylist(b, out)

  if (zip) {
    const names = new Set(zip.entries.map((e) => e.name))
    const mime = zip.entries[0]?.name === 'mimetype' ? (zip.read(zip.entries[0]) ?? '') : ''
    const office = names.has('[Content_Types].xml')
    const odf = /^application\/vnd\.oasis\.opendocument\./.test(mime)
    if (office) checkOoxml(zip.entries, zip.read, out)
    else if (odf) checkOdf(zip.entries, zip.read, out)
    // A zip that isn't named as a document has its files checked, whatever parts it has.
    if ((!office && !odf) || !DOCUMENT_ENDINGS.has(ending)) await checkZipArchive(b, zip.entries, out, deep)
    return
  }
  // A zip the strict reader refuses (names twice over, entries that overlap, ZIP64): its files by
  // their names, read from every header that claims one, as an unzip tool might find them.
  if (startsWith(b, 'PK\x03\x04')) {
    const files = await insideFiles(looseNames(b).map((n) => shownName(n, false)), () => undefined)
    if (files.length) out.push({ kind: 'inside', files })
    return
  }
  if (startsWith(b, '{\\rtf')) return checkRtf(b, out)
  if (b.length >= 8 && u32le(b, 0) === 0xe011cfd0 && u32le(b, 4) === 0xe11ab1a1) return checkCompound(b, out)
  const head = latin1(b, 0, Math.min(b.length, 1024))
  if (head.includes('%PDF-')) return checkPdf(b, out)
  const other = describeOther(b)
  if (other === 'tar' || other === 'gzip') {
    // Inside a zip, a gzipped tar isn't unpacked (a hundred of them would be gigabytes): by name, as a zip in a zip is.
    if (other === 'gzip' && !deep) return
    const tar = other === 'gzip' ? gunzipPrefix(b, 64_000_000) : b
    const files = await insideFiles(startsWith(tar, 'ustar', 257) ? tarNames(tar).map((n) => shownName(n, false)) : [], () => undefined)
    if (files.length) out.push({ kind: 'inside', files })
    return
  }
}

