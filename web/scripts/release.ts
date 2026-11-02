// The downloadable copy's parts of the pages (the footer's "Run locally
// (download)" and its popup, the About page's downloads), filled in at build
// time from src/site.ts RELEASE (vite.config.ts). Each part is written between
//   <!-- release -->   and   <!-- /release -->
// and is left out, markers and all, while there's no release to describe or no
// published code to download it from, so a page never offers what doesn't exist
// yet. With a release, inside a part:
//   data-release-href="SYSTEM"                becomes href="its download address"
//   <span data-release-size="SYSTEM"></span>  its size, e.g. "13.4 MB"
//   <code data-release-sum="SYSTEM"></code>   its SHA-256
//   <span data-release-date></span>           when it was built, e.g. "22 October 2026"
// SYSTEM is one of ReleaseFile's systems.
import type { Release, ReleaseFile } from '../src/site.ts'

const BLOCK = /[ \t]*<!-- release -->\n?([\s\S]*?)[ \t]*<!-- \/release -->\n?/g
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "2026-10-22" as "22 October 2026". */
export function releaseDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) throw new Error(`release date isn’t YYYY-MM-DD: ${date}`)
  return `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}`
}

/** A size as the page writes it: megabytes of a million bytes, one decimal. */
export const releaseSize = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`

/** Every value a page will hold, checked first: a bad one stops the build rather than reach a page. */
function check(release: Release) {
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag)) throw new Error(`release tag isn’t vN.N.N: ${release.tag}`)
  releaseDate(release.date)
  const seen = new Set<string>()
  for (const f of release.files) {
    if (seen.has(f.system)) throw new Error(`two release files for ${f.system}`)
    seen.add(f.system)
    // Windows runs the program as it comes (a zip would only add a step); a Mac's app needs one, and Linux's keeps it runnable.
    const ext = f.system === 'windows' ? 'exe' : 'zip'
    if (!new RegExp(`^[a-z0-9][a-z0-9.-]*\\.${ext}$`).test(f.name)) throw new Error(`release file name: ${f.name}`)
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) throw new Error(`release checksum for ${f.system}`)
    if (!Number.isSafeInteger(f.bytes) || f.bytes <= 0) throw new Error(`release size for ${f.system}`)
  }
}

/**
 * html with each release part filled in from release, or left out while there's
 * none or link gives no address (the code isn't published yet).
 */
export function fillRelease(html: string, release: Release | undefined, link: (file: ReleaseFile) => string): string {
  if (release) check(release)
  const live = release !== undefined && release.files.length > 0 && release.files.every((f) => link(f) !== '')
  const file = (system: string) => {
    const f = release!.files.find((x) => x.system === system)
    if (!f) throw new Error(`no release file for ${system}`)
    return f
  }
  const out = html.replace(BLOCK, (_whole, inner: string) => {
    if (inner.includes('<!-- release -->')) throw new Error('release parts can’t be nested')
    if (!live) return ''
    return inner
      .replace(/data-release-href="([a-z-]+)"/g, (_, s: string) => `href="${link(file(s))}"`)
      .replace(/<span data-release-size="([a-z-]+)"><\/span>/g, (_, s: string) => releaseSize(file(s).bytes))
      .replace(/<code data-release-sum="([a-z-]+)"><\/code>/g, (_, s: string) => `<code>${file(s).sha256}</code>`)
      .replace(/<span data-release-date><\/span>/g, () => releaseDate(release!.date))
  })
  // Anything written another way would reach the page unfilled, or describe a release that isn't there.
  if (/data-release-|<!-- \/?release -->/.test(out)) throw new Error('a release part isn’t written as scripts/release.ts expects')
  return out
}
