// Makes a video smaller away from the page (shrink.ts), so the page stays
// responsive on a phone while the pictures are decoded and encoded again; and
// audio files too (audio/shrink.ts), in the same worker, which every
// visit fetches already (preload.ts).
import type { AudioKind } from '../audio/read.ts'
import { CantDecode, outlineOf, shrinkAudio, type AudioInput, type AudioProgress, type AudioReport } from '../audio/shrink.ts'
import { shrinkVideo, snapshots, type Options, type Progress, type Report } from './shrink.ts'

export type ToWorker =
  | { op: 'shrink'; file: Blob; target: number; steps?: Options['steps']; scaler?: Options['scaler']; audioBitrate?: number; soundAs?: Options['soundAs']; decoderHw?: Options['decoderHw']; encoderHw?: Options['encoderHw'] }
  | { op: 'stop' }
  | { op: 'snapshots'; file: Blob; points: number[]; which: string; edge?: number; decoderHw?: Options['decoderHw'] }
  | { op: 'audio'; input: AudioInput; target: number }
  | { op: 'outline'; file: Blob; kind: AudioKind; seconds: number; which: string }

export type FromWorker =
  | ({ op: 'progress' } & Progress)
  | { op: 'done'; data: Uint8Array; report: Report }
  | { op: 'failed'; message: string; report?: Report }
  | { op: 'snapshots'; which: string; bitmaps: ImageBitmap[] }
  | ({ op: 'audio-progress' } & AudioProgress)
  | { op: 'audio-done'; data: Uint8Array; report: AudioReport }
  | { op: 'outline'; which: string; levels: number[] | null }

let stop: AbortController | undefined
const post = (m: FromWorker, transfer: Transferable[] = []) => self.postMessage(m, { transfer })

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.op === 'stop') stop?.abort()
  else if (m.op === 'shrink') {
    stop = new AbortController()
    try {
      const r = await shrinkVideo(m.file, m.target, {
        steps: m.steps,
        scaler: m.scaler,
        audioBitrate: m.audioBitrate,
        soundAs: m.soundAs,
        decoderHw: m.decoderHw,
        encoderHw: m.encoderHw,
        signal: stop.signal,
        onProgress: (p) => post({ op: 'progress', ...p }),
      })
      post({ op: 'done', data: r.data, report: r.report }, [r.data.buffer])
    } catch (err) {
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      post({ op: 'failed', message, report: (err as { report?: Report }).report })
    }
  } else if (m.op === 'audio') {
    stop = new AbortController()
    try {
      const r = await shrinkAudio(m.input, m.target, { signal: stop.signal, onProgress: (p) => post({ op: 'audio-progress', ...p }) })
      post({ op: 'audio-done', data: r.data, report: r.report }, [r.data.buffer])
    } catch (err) {
      // "cant-decode": this browser's decoder won't take it, so the page decodes it instead (audio/page.ts).
      const message = err instanceof CantDecode ? `cant-decode: ${err.message}` : err instanceof Error ? err.message : String(err)
      post({ op: 'failed', message })
    }
  } else if (m.op === 'outline') {
    post({ op: 'outline', which: m.which, levels: await outlineOf(m.file, m.kind, m.seconds) })
  } else if (m.op === 'snapshots') {
    let bitmaps: ImageBitmap[] = []
    try {
      bitmaps = await snapshots(m.file, m.points, m.edge, m.decoderHw)
    } catch {
      // No pictures to compare: the page says so.
    }
    post({ op: 'snapshots', which: m.which, bitmaps }, bitmaps)
  }
}
