// Plain zips: every file inside that Slynk can clean goes through its own
// cleaner, and the zip is written afresh (zip.ts) without the dates, owners
// and comments a zip keeps for each file, or the files a computer adds by
// itself (.DS_Store, Thumbs.db, __MACOSX). One level only: a zip inside goes
// as it is. Names keep their own bytes, and files their kind (a folder, a
// link, or a file that runs or doesn't), so the zip unpacks as it did. What
// goes unchecked is counted by kind, for the composer to say so.
import { u32be } from './bytes.ts'
import { MAX_INPUT } from './engine.ts'
import { loadFormat } from './formats.ts'
import { IN_FILES, IN_PICTURES, LABEL } from './labels.ts'
import { describeOther, detectKind } from './sniff.ts'
import { type FormatOutcome, type Found, type Kind, SKIP, type StripOptions, type Unchecked, fail } from './types.ts'
import { addAll, addFound } from './values.ts'
import { type OutEntry, type Package, ZIP_CAP, modeOf, openPackage, rawName, readEntry, systemName, writePackage } from './zip.ts'
import { type ZipEntry, readZipDirectory } from './zipdir.ts'

/** More entries than this are left alone, as a file too large to check. */
const MAX_FILES = 10_000

const S_IFMT = 0o170000

// macOS's "._" companions (AppleDouble) hold a file's extended attributes,
// such as the address it was downloaded from and its Finder tags.
const APPLE_DOUBLE = 0x00051607

/** What a computer added by itself, under the name shown for it, or null. */
function systemFile(pkg: Package, e: ZipEntry): string | null {
  const named = systemName(e.name, e.usize)
  if (named) return named
  const base = e.name.slice(e.name.lastIndexOf('/') + 1)
  if (!base.startsWith('._') || (e.method !== 0 && e.method !== 8) || e.usize < 26) return null
  try {
    return u32be(readEntry(pkg, e), 0) === APPLE_DOUBLE ? '._ files' : null
  } catch {
    return null
  }
}

function inside(label: string): string {
  return (label.endsWith(IN_PICTURES) ? label.slice(0, -IN_PICTURES.length) : label) + IN_FILES
}

type Inner = { data: Uint8Array; removed: string[]; values: Found[] } | { unchecked: string } | null

/** One file inside: cleaned, counted as unchecked, or null when there's nothing to do or say. */
// What describes a photo or video in a file of its own: Lightroom's and darktable's XMP sidecars
// (place, camera, creator), Google Takeout's JSON beside each photo (place, people's names).
const SIDECAR = /(\.xmp|\.(jpe?g|png|heic|heif|gif|webp|dng|mp4|mov|m4v|3gp)(\(\d+\))?\.json|supplemental-metadata(\(\d+\))?\.json)$/i

async function cleanInner(pkg: Package, e: ZipEntry, mode: number): Promise<Inner> {
  // A link holds only the path it points to, which may name a home folder.
  if ((mode & S_IFMT) === 0o120000) return { unchecked: 'link' }
  // A few bytes are too few to tell what they are, or to hide anything in.
  if ((mode & S_IFMT) !== 0o100000 || e.usize < 8) return null
  if (e.method !== 0 && e.method !== 8) return { unchecked: 'failed' }
  let data: Uint8Array
  let kind: Kind | null
  try {
    data = readEntry(pkg, e)
    kind = detectKind(data)
  } catch {
    return { unchecked: 'failed' }
  }
  // A zip's PDFs are cleaned only as rows of their own in the composer (tray.ts), never here.
  if (!kind || kind === 'zip' || kind === 'pdf') {
    let other: string | null = kind
    try {
      other ??= describeOther(data)
    } catch {
      other = null
    }
    // Plain text has nowhere to keep hidden data, unless it's a file of a photo's details.
    if (other === 'text' || other === 'svg') return SIDECAR.test(e.name) ? { unchecked: 'sidecar' } : other === 'svg' ? { unchecked: 'svg' } : null
    return { unchecked: other ?? 'other' }
  }
  if (data.length > MAX_INPUT) return { unchecked: 'failed' }
  try {
    const mod = await loadFormat(kind)
    const out = await mod.strip(data, kind, {})
    if (out.status === 'unsupported') return { unchecked: kind }
    if (out.status === 'skipped') {
      const why = out.reason === SKIP.encrypted ? 'locked' : out.reason === SKIP.signed || out.reason === SKIP.signedDocument ? 'signed' : 'failed'
      return { unchecked: why }
    }
    if (out.status === 'unchanged' || !out.removed.length) return null
    if (detectKind(out.bytes) !== kind) fail('a cleaned file no longer reads as the same type')
    await mod.verify(out.bytes, kind)
    return { data: out.bytes, removed: out.removed.map(inside), values: (out.values ?? []).map((v) => ({ label: inside(v.label), value: v.value })) }
  } catch {
    // It goes as it is, and the composer says so.
    return { unchecked: 'failed' }
  }
}

export async function strip(bytes: Uint8Array, _kind?: Kind, opts: StripOptions = {}): Promise<FormatOutcome> {
  const skip = new Set(opts.skip)
  const entries = readZipDirectory(bytes)
  if (entries.length > MAX_FILES || entries.reduce((n, e) => n + e.usize, 0) > ZIP_CAP) return { status: 'skipped', reason: SKIP.tooLarge }
  const pkg = openPackage(bytes, true)
  if (pkg.encrypted) return { status: 'skipped', reason: SKIP.encrypted }
  const labels = new Set(pkg.labels)
  const values: Found[] = []
  const unchecked: Unchecked = {}
  const list: OutEntry[] = []
  for (const e of pkg.entries) {
    const added = systemFile(pkg, e)
    if (added) {
      labels.add(LABEL.systemFiles)
      addFound(values, LABEL.systemFiles, added)
      continue
    }
    const mode = modeOf(e)
    const kept = { name: e.name, raw: rawName(bytes, e), mode }
    const inner = skip.has(e.name) ? null : await cleanInner(pkg, e, mode)
    if (inner && 'data' in inner) {
      inner.removed.forEach((l) => labels.add(l))
      addAll(values, inner.values)
      list.push({ ...kept, data: inner.data, store: e.method === 0 })
      continue
    }
    if (inner) unchecked[inner.unchecked] = (unchecked[inner.unchecked] ?? 0) + 1
    list.push({ ...kept, from: e })
  }
  if (!labels.size) return { status: 'unchanged', unchecked }
  if (!list.length) fail('nothing would be left in the zip')
  return { status: 'cleaned', bytes: writePackage(pkg, list), removed: [...labels], values, unchecked }
}

/** Reads every entry again (each checked against its CRC) and checks nothing is left to remove. */
export async function verify(bytes: Uint8Array, kind?: Kind, opts?: StripOptions): Promise<void> {
  const again = await strip(bytes, kind, opts)
  if (again.status !== 'unchanged') fail('something is still left to remove')
}
