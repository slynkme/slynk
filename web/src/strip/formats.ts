// One dynamically imported module per format family, each its own chunk.
// The worker loads them all as soon as it starts (loadEveryFormat), for
// every visitor: code fetched only when a file of its kind turned up would
// tell the web host's visit logs what kind of file someone added
// (web/src/preload.ts).
import type { FormatModule, Kind } from './types.ts'

/** Every format's code, and the XML parser some of them load later. */
export function loadEveryFormat(): Promise<unknown> {
  return Promise.all([
    import('./jpeg.ts'),
    import('./png.ts'),
    import('./webp.ts'),
    import('./gif.ts'),
    import('./isobmff.ts'),
    import('./audio.ts'),
    import('./ooxml.ts'),
    import('./odf.ts'),
    import('./rtf.ts'),
    import('./pdf.ts'),
    import('./video.ts'),
    import('./archive.ts'),
    import('./svg.ts'),
    import('./xml.ts'),
    // Not a format: making PDFs and Office files smaller, in a second copy of this worker.
    import('../docshrink/session.ts'),
  ])
}

export function loadFormat(kind: Kind): Promise<FormatModule> {
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
    case 'mp3':
    case 'flac':
      return import('./audio.ts')
    case 'docx':
    case 'xlsx':
    case 'pptx':
      return import('./ooxml.ts')
    case 'odt':
    case 'ods':
    case 'odp':
      return import('./odf.ts')
    case 'rtf':
      return import('./rtf.ts')
    case 'pdf':
      return import('./pdf.ts')
    case 'mp4':
    case 'mov':
      return import('./video.ts')
    case 'zip':
      return import('./archive.ts')
    case 'svg':
      return import('./svg.ts')
  }
}
