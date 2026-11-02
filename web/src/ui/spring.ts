// The Slynk spring: a Slinky-style coil arching across the page background.
// Each ring is drawn as an ellipse perpendicular to the arch (back half faint,
// front half bright, for depth), and compression waves travel along it:
// slowly at rest, quickly while data is moving, with a flash on completion.
// It honours prefers-reduced-motion and pauses in hidden tabs.

export type Mood = 'idle' | 'busy' | 'done'

interface Palette {
  hueFrom: number
  hueTo: number
  sat: number
  light: number
  back: number
  front: number
  blend: GlobalCompositeOperation
}

const DARK: Palette = { hueFrom: 268, hueTo: 186, sat: 90, light: 70, back: 0.09, front: 0.38, blend: 'lighter' }
const LIGHT: Palette = { hueFrom: 262, hueTo: 196, sat: 70, light: 48, back: 0.07, front: 0.3, blend: 'source-over' }

const MOODS: Record<Exclude<Mood, 'done'>, { speed: number; amp: number }> = {
  idle: { speed: 0.07, amp: 0.32 },
  busy: { speed: 0.6, amp: 0.46 },
}

type Pt = [number, number]

export interface Spring {
  setMood(mood: Mood): void
  setDark(dark: boolean): void
}

export function startSpring(canvas: HTMLCanvasElement): Spring {
  const ctx = canvas.getContext('2d')
  if (!ctx) return { setMood() {}, setDark() {} }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)')
  let w = 0
  let h = 0
  let palette = DARK
  let base: Exclude<Mood, 'done'> = 'idle'
  let speed = MOODS.idle.speed
  let amp = MOODS.idle.amp
  let flash = 0 // 1 right after a transfer completes, decaying to 0
  let phase = 0
  let clock = 0
  let last = performance.now()
  let raf = 0

  // Arch geometry, in CSS pixels, recomputed on resize.
  let p0: Pt, c1: Pt, c2: Pt, p3: Pt
  let radius = 50
  let coils = 60

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = window.innerWidth
    h = window.innerHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)

    const portrait = h > w
    p0 = portrait ? [-0.15 * w, 0.92 * h] : [0.04 * w, 1.04 * h]
    p3 = portrait ? [1.15 * w, 0.92 * h] : [0.96 * w, 1.04 * h]
    c1 = portrait ? [0.0 * w, -0.05 * h] : [0.16 * w, -0.2 * h]
    c2 = portrait ? [1.0 * w, -0.05 * h] : [0.84 * w, -0.2 * h]
    radius = Math.max(26, Math.min(82, Math.min(w, h) * 0.075))

    // Pack rings about half a radius apart along the arch, like a Slinky.
    let length = 0
    let prev = bezier(0)
    for (let i = 1; i <= 64; i++) {
      const p = bezier(i / 64)
      length += Math.hypot(p[0] - prev[0], p[1] - prev[1])
      prev = p
    }
    coils = Math.max(36, Math.min(130, Math.round(length / (radius * 0.5))))
    if (reduced.matches) draw()
  }

  function bezier(t: number, lift = 0): Pt {
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const d = t * t * t
    return [
      a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
      a * p0[1] + b * (c1[1] + lift) + c * (c2[1] + lift) + d * p3[1],
    ]
  }

  function tangentAngle(t: number, lift: number): number {
    const a = bezier(Math.max(0, t - 0.001), lift)
    const b = bezier(Math.min(1, t + 0.001), lift)
    return Math.atan2(b[1] - a[1], b[0] - a[0])
  }

  function draw() {
    const g = ctx!
    g.clearRect(0, 0, w, h)
    g.globalCompositeOperation = palette.blend
    const lift = Math.sin(clock * 0.25) * h * 0.025 // the arch gently breathes
    const glow = 1 + flash * 1.4
    const rings: { x: number; y: number; angle: number; color: string }[] = []

    for (let i = 0; i < coils; i++) {
      const u = i / (coils - 1)
      // Shift each ring along the arch by a travelling wave (less than half
      // the ring spacing, so rings never cross).
      const t = Math.min(1, Math.max(0, u + (amp * Math.sin(2 * Math.PI * (1.6 * u - phase))) / coils))
      const [x, y] = bezier(t, lift)
      const hue = palette.hueFrom + (palette.hueTo - palette.hueFrom) * u
      rings.push({ x, y, angle: tangentAngle(t, lift), color: `${hue}, ${palette.sat}%, ${palette.light}%` })
    }

    // Back halves first, then front halves, so the coil reads as 3D.
    for (const pass of [0, 1]) {
      g.lineWidth = pass ? 2.2 : 1.4
      const alpha = Math.min(1, (pass ? palette.front : palette.back) * glow)
      for (const r of rings) {
        g.strokeStyle = `hsla(${r.color}, ${alpha})`
        g.beginPath()
        g.ellipse(r.x, r.y, radius * 0.3, radius, r.angle, pass ? -Math.PI / 2 : Math.PI / 2, pass ? Math.PI / 2 : (3 * Math.PI) / 2)
        g.stroke()
      }
    }
    g.globalCompositeOperation = 'source-over'
  }

  function frame(now: number) {
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    const target = MOODS[base]
    const ease = Math.min(1, dt * 1.2)
    speed += (target.speed - speed) * ease
    amp += (target.amp - amp) * ease
    flash = Math.max(0, flash - dt * 0.6)
    phase += speed * dt
    clock += dt
    draw()
    raf = requestAnimationFrame(frame)
  }

  function run() {
    cancelAnimationFrame(raf)
    if (reduced.matches || document.hidden) {
      draw()
      return
    }
    last = performance.now()
    raf = requestAnimationFrame(frame)
  }

  window.addEventListener('resize', resize)
  // When the browser's graphics process restarts (the screen flashes; seen on a Mac while a
  // video was made smaller), it hands the canvas back reset: the scale for a sharp screen is
  // gone, and the coil would be drawn at half size in the top-left corner.
  canvas.addEventListener('contextrestored', resize)
  document.addEventListener('visibilitychange', run)
  reduced.addEventListener('change', run)
  resize()
  run()

  return {
    setMood(mood) {
      if (mood === 'done') {
        flash = 1
        base = 'idle'
      } else {
        base = mood
      }
      if (reduced.matches) draw()
    },
    setDark(dark) {
      palette = dark ? DARK : LIGHT
      draw()
    },
  }
}
