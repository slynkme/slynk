// The words a received file's row shows when the file checks (filecheck/check.ts)
// find something, and the sheet its ⓘ opens (for
// recipients only, the ones a harmful file is aimed at). The checks run in
// the visitor's own browser, so the words say "your browser" and "the app",
// never the site's name, which could sound like someone else checking; and
// they never call a file safe. What's checked, and what isn't, is on the About
// page ("Are files checked for viruses?").
import type { InsideFile, OpensIn, Warning } from './filecheck/types.ts'

/** One site, two, or the first and how many more. */
const sites = (hosts: string[]) =>
  hosts.length === 1 ? hosts[0] : hosts.length === 2 ? `${hosts[0]} and ${hosts[1]}` : `${hosts[0]} and ${hosts.length - 1} other sites`

/** A file inside that runs, or is a disk image, or an archive holding one. */
const runsInside = (f: InsideFile): boolean =>
  f.warnings.some((w) => w.kind === 'program' || w.kind === 'script' || w.kind === 'disguised' || w.kind === 'disk' || (w.kind === 'inside' && w.files.some(runsInside)))

/** The line under the file's name. */
export function LINE(w: Warning): string {
  switch (w.kind) {
    case 'program':
      return 'This is a program. Open it only if you trust who sent it.'
    case 'script':
      return 'This file can run commands when opened.'
    case 'disguised':
      return `Its name says ${w.claimed}, but it’s really ${w.real === 'program' ? 'a program' : 'a disk image'}.`
    case 'disk':
      return 'This is a disk image, which can hold programs.'
    case 'macros':
      return 'Has macros: code that runs if you allow it.'
    case 'internet':
      return `Tries to contact ${sites(w.hosts)} when opened.`
    // "Such as": the sites read from its text, never all a page could reach (the review, 2026-10-26).
    case 'web-page':
      return w.hosts.length ? `Can contact websites, such as ${sites(w.hosts)}, if opened in a browser.` : 'Can contact websites if opened in a browser.'
    case 'pdf-scripts':
      return w.onOpen ? 'Has scripts some PDF readers run when it’s opened.' : 'Has scripts some PDF readers can run.'
    case 'pdf-launch':
      return 'Can ask to open other programs.'
    case 'attachments':
      return 'Has files attached inside.'
    case 'inside':
      return w.files.some(runsInside)
        ? 'Has programs inside.'
        : w.files.length === 1
          ? 'A file inside has a warning.'
          : `${w.files.length} files inside have warnings.`
    case 'locked':
      return 'Couldn’t look inside: it’s locked with a password.'
    case 'web-scripts':
      return 'Runs scripts if opened in a browser.'
    case 'unread':
      return 'Couldn’t be checked: it took too long.'
  }
}

/** An archive's sheet lists this many of its files with warnings, then counts the rest. */
export const SHOWN_INSIDE = 12
export const MORE_INSIDE = (n: number) => (n === 1 ? 'And 1 more file.' : `And ${n} more files.`)

/** After the line, for screen readers: the ⓘ opens why. */
export const WHY_LABEL = 'Why?'

const OPENED_IN: Record<OpensIn, string> = {
  office: 'Word, Excel or PowerPoint',
  word: 'Word',
  libreoffice: 'LibreOffice',
  pdf: 'a PDF reader',
  player: 'a media player',
}

const CHECKED = 'Your browser only checked what kind of file it is, not whether it’s harmful.'

/**
 * First in every sheet, so it's seen. True of the previews: pages,
 * pictures and text drawn on canvases, sound and video played from memory, no scripts, forms or
 * links; and the page's security rules (.htaccess's CSP) let it reach only the site, its key
 * server and the xx network, whatever a file asks for. Not "harmless": the browser still reads
 * the file to show it.
 */
export const HERE = 'Nothing in it can run here.'
export const HERE_MORE = 'The app only previews files, never runs them, and a file can’t make it contact any website. It’s only a risk once you save it and open it in another program.'

/** What the sheet says about this warning, after HERE (an archive's says it under each of its files). */
export function WHY(w: Warning): string[] {
  const out: string[] = []
  if (w.kind === 'program' || w.kind === 'script') out.push(`It runs as soon as it’s opened. ${CHECKED}`)
  else if (w.kind === 'disguised') out.push(`Disguising a file’s type is a common trick. ${CHECKED}`)
  else if (w.kind === 'disk') out.push(`Opening it shows the files inside, which can include programs. ${CHECKED}`)
  else if (w.kind === 'macros') out.push('Don’t choose “Enable content” unless you trust who sent it.')
  else if (w.kind === 'unread') out.push('Your browser gave up before it could see what kind of file it is and what’s packed in it, so it may hold something it would warn about.')
  else if (w.kind === 'internet')
    out.push(
      `Opened in ${OPENED_IN[w.opensIn]}, it may fetch something from ${sites(w.hosts)}, which would see your internet address and the time. ` +
        'Opening it offline or with a VPN avoids it.',
    )
  // Any web page can, in a browser, so this is said of every one, with the sites it fetches from as it opens.
  else if (w.kind === 'web-page')
    out.push(
      `Opened in a browser, a web page can fetch things from websites${w.hosts.length ? ` (this one from ${sites(w.hosts)}, and maybe others)` : ''}, which would see your internet address and the time. ` +
        'Opening it offline or with a VPN avoids it.',
    )
  else if (w.kind === 'web-scripts') out.push('Its scripts can do what a website does, such as contact sites that aren’t named here.')
  return out
}

/** With "Save received files automatically" on, when something that arrived has a warning: nothing's saved until a tap. */
export const AUTO_SAVE_HELD = (files: number) =>
  files === 1 ? 'Not saved automatically: it has a warning.' : 'Not saved automatically: a file has a warning.'
