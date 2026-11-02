// Pictures inside documents (Office media folders, OpenDocument Pictures/,
// JPEG images in PDFs) carry their own EXIF: a photo pasted into a report
// still holds its GPS location. They go through the same image cleaners.
import { IN_PICTURES } from './labels.ts'
import { detectKind } from './sniff.ts'
import type { FormatModule, Found, Kind } from './types.ts'

function load(kind: Kind): Promise<FormatModule> | null {
  switch (kind) {
    case 'jpeg':
      return import('./jpeg.ts')
    case 'png':
      return import('./png.ts')
    case 'webp':
      return import('./webp.ts')
    case 'gif':
      return import('./gif.ts')
    case 'heic':
    case 'avif':
      return import('./isobmff.ts')
  }
  return null
}

/** The cleaned picture and what was removed (and said), or null if there was nothing to do. */
export async function stripPicture(data: Uint8Array): Promise<{ bytes: Uint8Array; removed: string[]; values: Found[] } | null> {
  const kind = detectKind(data)
  const loading = kind && load(kind)
  if (!kind || !loading) return null
  const mod = await loading
  const out = await mod.strip(data, kind, {})
  if (out.status !== 'cleaned') return null
  await mod.verify(out.bytes, kind)
  return {
    bytes: out.bytes,
    removed: out.removed.map((l) => l + IN_PICTURES),
    values: (out.values ?? []).map((v) => ({ label: v.label + IN_PICTURES, value: v.value })),
  }
}
