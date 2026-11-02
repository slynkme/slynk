// What the composer needs to know about a video the moment it's added, read
// from its index alone (demux.ts): how long it is, its size and frame rate,
// whether it has sound, and whether this browser could make it smaller. Even
// a 141 MB 4K video is known in a moment, before anything slow starts.
import { detectKind } from '../strip/sniff.ts'
import { demux } from './demux.ts'
import type { VideoShape } from './plan.ts'

export interface VideoInfo extends VideoShape {
  /** Clockwise, as it's turned when played. */
  rotation: 0 | 90 | 180 | 270
  /**
   * Whether this browser can make it smaller: 'yes'; 'browser' when it has no
   * WebCodecs (Firefox on Android, Tor Browser, older iPhones); 'open' when
   * it can't decode this video (an iPhone's HEVC where there's no decoder).
   */
  can: 'yes' | 'browser' | 'open'
}

/** Whether this browser has what making a video smaller needs at all. */
export const hasWebCodecs = () => typeof VideoDecoder !== 'undefined' && typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined'

/** A phone or camera video's details, or null if the file isn't one Slynk can read. */
export async function videoInfo(file: Blob): Promise<VideoInfo | null> {
  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())
    const kind = detectKind(head)
    if (kind !== 'mp4' && kind !== 'mov') return null
    const movie = await demux(file)
    const tracks = movie.tracks.filter((t) => t.kind === 'video' && t.samples.length)
    const v = tracks.find((t) => t.enabled) ?? tracks[0]
    if (!v || !v.width || !v.height) return null
    let end = 0
    for (const s of v.samples) end = Math.max(end, s.cts + s.duration)
    const seconds = (end - v.mediaStart) / v.timescale
    if (!(seconds > 0)) return null
    const info: VideoInfo = {
      width: v.width,
      height: v.height,
      seconds,
      fps: v.samples.length / seconds,
      sound: movie.tracks.some((t) => t.kind === 'audio' && t.samples.length),
      rotation: v.rotation,
      can: 'yes',
    }
    if (!hasWebCodecs()) info.can = 'browser'
    else if (!v.codec) info.can = 'open'
    else {
      try {
        const r = await VideoDecoder.isConfigSupported({ codec: v.codec, description: v.description, codedWidth: v.width, codedHeight: v.height })
        if (!r.supported) info.can = 'open'
      } catch {
        // iOS 26.1 throws for some: the attempt itself will tell.
      }
    }
    return info
  } catch {
    return null // not a video Slynk can read: it's treated as any other file
  }
}
