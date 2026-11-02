// Session settings. They live in memory and die with the tab, unless the
// visitor opts in to remembering them on this device (localStorage). Nothing
// about transfers is ever stored.
import { PHOTO_LEVELS, type PhotoLevel } from '../shrink/plan.ts'
import { VIDEO_LEVELS, type VideoLevel } from '../video/plan.ts'

export type Shrink = 'smallest' | 'fit' | 'ask'

export interface Settings {
  theme: 'system' | 'dark' | 'light'
  autoSave: boolean
  notify: boolean
  /** 1-11 part batches instead of 9-11: fewer of an upload's parts per round, slower. */
  variedBatches: boolean
  /** "Remove hidden details from files": location, device, dates, authors. */
  stripMetadata: boolean
  /**
   * "Shrink photos, media & docs" (tray.ts; it was "Make photos, media files and documents smaller"): 'smallest' makes each as small as
   * Slynk goes, whether or not it fits (the default since 2026-10-26: a photo made smaller only to
   * fit could still take 500 KB of the mixnet); 'fit' only when they don't fit, and only as much as
   * that needs; 'ask' only once the sender says so.
   */
  shrink: Shrink
  /** "Smallest photos" (Advanced): what 'smallest' makes a photo (shrink/plan.ts, PhotoLevel). */
  smallestPhotos: PhotoLevel
  /** "Smallest videos" (Advanced): what 'smallest' makes a video (video/plan.ts, VideoLevel); 240p by default (180p looks awful). */
  smallestVideos: VideoLevel
  /** "Show photo, media and document previews": a small picture of each photo, video or audio file in the list, which opens it as it will be sent (ui/photoView.ts). */
  photoPreviews: boolean
  /** "Plain file names": a name that gives away a date or a device goes as photo.jpg and the like (tray.ts). */
  plainNames: boolean
  /** Join the mixnet on page load instead of on the first sign of sending. */
  connectOnLoad: boolean
  /** Occasional blank messages while connected (core/transfer/cover.go). */
  cover: boolean
  /** Empty requests to slynk.me's key server now and then, so nobody watching can tell which visitors sent or opened a link (burnCover.ts). On by default. */
  coverRequests: boolean
  /** "Stronger compression": Brotli instead of deflate where it makes what's sent smaller (squeeze/). On by default. */
  brotli: boolean
  remember: boolean
  verbose: boolean
}

const KEY = 'slynk.settings'
const DEFAULTS: Settings = {
  theme: 'system',
  autoSave: false,
  notify: true,
  variedBatches: false,
  stripMetadata: true,
  shrink: 'smallest',
  smallestPhotos: 'least',
  smallestVideos: 240,
  photoPreviews: true,
  plainNames: false,
  connectOnLoad: false,
  cover: false,
  coverRequests: true,
  brotli: true,
  remember: false,
  verbose: false,
}

type Listener = (s: Settings) => void

let current: Settings = { ...DEFAULTS }
const listeners: Listener[] = []

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const { shrinkPhotos, ...kept } = JSON.parse(raw)
      // Before the three choices, a switch: off was "Ask first"; on was the default, and gets today's.
      current = { ...DEFAULTS, ...(shrinkPhotos === false ? { shrink: 'ask' } : {}), ...kept, remember: true }
      // A level this page doesn't offer (kept by a later version, say): the default, which the tray can plan for.
      if (!PHOTO_LEVELS.includes(current.smallestPhotos)) current.smallestPhotos = DEFAULTS.smallestPhotos
      if (!VIDEO_LEVELS.includes(current.smallestVideos)) current.smallestVideos = DEFAULTS.smallestVideos
    }
  } catch {
    // Storage blocked or unreadable: keep defaults.
  }
  return current
}

export function settings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch }
  try {
    if (current.remember) localStorage.setItem(KEY, JSON.stringify(current))
    else localStorage.removeItem(KEY)
  } catch {
    // Storage blocked: settings still apply for this session.
  }
  listeners.forEach((l) => l(current))
}

/** Hears every change of settings; returns a way to stop hearing them. */
export function onSettings(l: Listener): () => void {
  listeners.push(l)
  return () => {
    const i = listeners.indexOf(l)
    if (i >= 0) listeners.splice(i, 1)
  }
}

/** Applies the theme to <html data-theme> and reports whether it's dark. */
export function applyTheme(onDark: (dark: boolean) => void) {
  const media = matchMedia('(prefers-color-scheme: dark)')
  const apply = () => {
    const dark = current.theme === 'dark' || (current.theme === 'system' && media.matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    onDark(dark)
  }
  media.addEventListener('change', apply)
  onSettings(apply)
  apply()
}
