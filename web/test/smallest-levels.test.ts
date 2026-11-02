// What "Smallest" makes photos and videos: "Smallest photos" and "Smallest
// videos" in Settings → Advanced (to let people say
// what smallest means). The sizes are planned here; the tray and the page are
// read from their source, and checked in the browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FLOOR_EDGE, MAX_EDGE, PHOTO_LEVELS, Q_FLOOR, Q_LOWEST, Q_MAX, allocate, atLevel, giveRoom, levelBytes, searchCopy, smallestShare, type Share, type Sizes } from '../src/shrink/plan.ts'
import { BPP_FLOOR, BPP_OK, FPS_MAX, LADDER, VIDEO_LEVELS, fitShort, goodBytes, leastBytes, leastTarget, levelSteps, overhead, planStep, planVideo, videoWeight, type VideoLevel, type VideoStep } from '../src/video/plan.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('the levels, least first; photos at the least by default, videos at 240p (180p looked poor)', () => {
  assert.deepEqual(PHOTO_LEVELS, ['least', 'medium', 'good'])
  assert.deepEqual(VIDEO_LEVELS, [180, 240, 360])
  const settings = read('../src/ui/settings.ts')
  assert.match(settings, /\n  smallestPhotos: 'least',\n  smallestVideos: 240,\n/)
  // One kept by a later version that this page doesn't offer goes back to the default.
  assert.match(settings, /if \(!PHOTO_LEVELS\.includes\(current\.smallestPhotos\)\) current\.smallestPhotos = DEFAULTS\.smallestPhotos/)
  assert.match(settings, /if \(!VIDEO_LEVELS\.includes\(current\.smallestVideos\)\) current\.smallestVideos = DEFAULTS\.smallestVideos/)
})

// A 4032 × 3024 photo measured at its floor size (1,280 pixels): sizes made up, in the right order.
const photo: Sizes = { dims: { width: 4032, height: 3024 }, least: 120_000, lowest: 60_000, hint: { edge: FLOOR_EDGE, quality: Q_MAX, size: 180_000 } }

test('a photo’s size at each level: its lowest, its least, its top size (guessed until measured)', () => {
  assert.equal(levelBytes(photo, 'least'), photo.lowest)
  assert.equal(levelBytes(photo, 'medium'), photo.least)
  assert.equal(levelBytes({ ...photo, top: { edge: MAX_EDGE, quality: Q_MAX, size: 470_000 } }, 'good'), 470_000)
  // Unmeasured: the floor size's, grown as the square of the side.
  assert.equal(levelBytes(photo, 'good'), Math.ceil(180_000 * (MAX_EDGE / FLOOR_EDGE) ** 2))
  // A photo no bigger than the floor size: its top size is its own, as measured.
  const small = { ...photo, dims: { width: 1000, height: 750 }, hint: { edge: 1000, quality: Q_MAX, size: 90_000 } }
  assert.equal(levelBytes(small, 'good'), 90_000)
})

// "Smallest" before the levels (tray.ts shares(), 2026-10-26), to hold the defaults to.
function before(share: Share, full: number, video: boolean): { share: Share; asIs: boolean } {
  if (share.least >= full * 0.95) return { share: { ...share, full, least: full }, asIs: true }
  return { share: video ? share : { ...share, full: share.least }, asIs: false }
}
const random = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo))

test('at the least, a photo’s claim is as before the levels; at any level it’s fixed: never smaller', () => {
  for (let k = 0; k < 2000; k++) {
    const full = random(20_000, 3_000_000)
    const share = { full, least: random(10_000, 4_000_000), weight: random(1, 4_000_000) }
    const aim = Math.min(full, share.least)
    assert.deepEqual(smallestShare(share, full, aim, 0.05), before(share, full, false), JSON.stringify(share))
  }
  // Good would save under 5%: as it is, never made smaller for room, though its least would save plenty (the
  // level chosen is what smallest means).
  const share = { full: 300_000, least: 90_000, weight: 3_000_000 }
  assert.deepEqual(smallestShare(share, 300_000, 295_000, 0.05), { share: { ...share, full: 300_000, least: 300_000 }, asIs: true })
  // Good saves plenty: claimed at Good, and no less.
  assert.deepEqual(smallestShare(share, 1_000_000, 480_000, 0.05), { share: { ...share, full: 480_000, least: 480_000 }, asIs: false })
  // Good and its least would both save under 5%: as it is, whatever the room, as at the least (the review, 2026-10-27).
  const close = { full: 300_000, least: 290_000, weight: 3_000_000 }
  assert.deepEqual(smallestShare(close, 300_000, 298_000, 0.05), { share: { ...close, full: 300_000, least: 300_000 }, asIs: true })
  assert.deepEqual(smallestShare(close, 300_000, 290_000, 0.05), before(close, 300_000, false))
})

test('a video claims its level and has the room nobody claims, as its ceiling did before the levels', () => {
  const minute = { width: 1920, height: 1080, seconds: 60, fps: 30, sound: true }
  for (let k = 0; k < 500; k++) {
    const space = random(1_500_000, 2_000_000)
    // Photos at the least (their claim fixed), beside a video at 180p.
    const photos = Array.from({ length: random(0, 8) }, () => ({ full: random(60_000, 150_000), least: 0, weight: random(1_000_000, 4_000_000) }))
    for (const p of photos) p.least = p.full
    const video: Share = { full: goodBytes(minute), least: leastBytes(minute), weight: videoWeight(minute) }
    const old = allocate(space, [...photos, before(video, 10_000_000, true).share])
    const now = allocate(space, [...photos, smallestShare(video, 10_000_000, leastBytes(minute), 0.05).share])
    assert.equal(now.fits, old.fits)
    if (!now.fits || !old.fits) continue
    const ceilings = [...photos.map(() => undefined), video.full]
    const given = giveRoom(space, now.sizes, ceilings)
    assert.ok(Math.abs(given[photos.length] - old.sizes[photos.length]) <= photos.length + 2, `${given[photos.length]} for ${old.sizes[photos.length]}`)
    assert.ok(given.reduce((a, b) => a + b, 0) <= space)
    assert.deepEqual(given.slice(0, -1), now.sizes.slice(0, -1), 'the photos keep theirs')
  }
  // A Good photo beside a 30-second video at 360p, with room for both: the photo isn't squeezed for room the
  // video never uses (it was, with a quarter spare on the video's claim: the review, 2026-10-27).
  const clip = { width: 1920, height: 1080, seconds: 30, fps: 30, sound: true }
  const v = smallestShare({ full: goodBytes(clip), least: leastBytes(clip), weight: videoWeight(clip) }, 6_000_000, leastBytes(clip, levelSteps(360)[0]), 0.05).share
  const photo = { full: 400_000, least: 90_000, weight: 3_000_000 }
  const plan = allocate(1_990_000, [v, photo])
  assert.ok(plan.fits && plan.sizes[1] === 400_000, JSON.stringify(plan))
})

test('Good photos that don’t all fit aren’t made smaller: the sender is told how many fit', () => {
  // Seven 4032 × 3024 photos at about 470 KB each at Good come to 3.3 MB.
  const good = smallestShare({ full: 3_000_000, least: 90_000, weight: 3_000_000 }, 3_000_000, 470_000, 0.05).share
  const plan = allocate(1_990_000, Array.from({ length: 7 }, () => good))
  assert.deepEqual(plan, { fits: false, count: 4 })
  // Four do fit, each at Good.
  const four = allocate(1_990_000, Array.from({ length: 4 }, () => good))
  assert.ok(four.fits && four.sizes.every((s) => s === 470_000), JSON.stringify(four))
})

test('room nobody claimed goes to the ceilings in turn, never past them or the space', () => {
  assert.deepEqual(giveRoom(1000, [100, 200, 300], [undefined, 450, undefined]), [100, 450, 300])
  assert.deepEqual(giveRoom(1000, [100, 200, 300], [undefined, 900, undefined]), [100, 600, 300])
  assert.deepEqual(giveRoom(1000, [100, 200, 300], [150, 900, undefined]), [150, 550, 300])
  assert.deepEqual(giveRoom(600, [100, 200, 300], [undefined, 900, undefined]), [100, 200, 300])
  assert.deepEqual(giveRoom(1000, [100, 200], [undefined, 150]), [100, 200], 'a ceiling below its size takes nothing')
})

test('a copy is at its level, or made again when there’s room', () => {
  const d = photo.dims
  const at = (quality: number, width: number, height: number) => ({ quality, dims: { width, height } })
  // "Least": any copy will do, as before the levels.
  assert.ok(atLevel(at(Q_LOWEST, 1280, 960), d, 'least'))
  assert.ok(atLevel(at(Q_MAX, 2048, 1536), d, 'least'))
  // "Medium": no lower than Q_FLOOR; a PNG (no quality setting, counted as 1) too.
  assert.ok(atLevel(at(Q_FLOOR, 1280, 960), d, 'medium'))
  assert.ok(atLevel(at(1, 1280, 960), d, 'medium'))
  assert.ok(!atLevel(at(0.6, 1280, 960), d, 'medium'))
  // "Good": Q_MAX at the top size, and nothing less.
  assert.ok(atLevel(at(Q_MAX, 2048, 1536), d, 'good'))
  assert.ok(atLevel(at(1, 2048, 1536), d, 'good'))
  assert.ok(!atLevel(at(Q_MAX, 1900, 1425), d, 'good'))
  assert.ok(!atLevel(at(0.8, 2048, 1536), d, 'good'))
  // A photo under 2,048 pixels: its own size is its top.
  assert.ok(atLevel(at(Q_MAX, 1600, 1200), { width: 1600, height: 1200 }, 'good'))
})

const said = (steps: readonly VideoStep[]) => steps.map((s) => `${s.short}p${s.fps}${s.bpp === BPP_FLOOR ? ' floor' : ''}`)

test('“Smallest videos”: each level’s steps, best first: its size at 30 frames a second, then 15, then the next size down, 180p at 15 last', () => {
  // Too long for its level, a video steps down rather than being refused.
  assert.deepEqual(said(levelSteps(180)), ['180p15 floor'])
  assert.deepEqual(said(levelSteps(240)), ['240p30', '240p15', '180p30', '180p15 floor'])
  assert.deepEqual(said(levelSteps(360)), ['360p30', '360p15', '240p30', '240p15', '180p30', '180p15 floor'])
  // Each at BPP_OK but the last, which is "To fit"'s last step at BPP_FLOOR, as small as Slynk goes: the least a
  // video can take, as before.
  for (const level of VIDEO_LEVELS) {
    const steps = levelSteps(level)
    assert.ok(steps.slice(0, -1).every((s) => s.bpp === BPP_OK))
    assert.deepEqual(steps[steps.length - 1], { ...LADDER[LADDER.length - 1], bpp: BPP_FLOOR })
  }
  const v = { width: 1920, height: 1080, seconds: 60, fps: 30, sound: true }
  assert.equal(leastBytes(v), leastBytes(v, levelSteps(180)[0]))
  // Each step down takes less, but one: at 30 frames a second, 180p (57,600 pixels) takes more than 240p at 15
  // (426 × 240 at half the frames), so a video too long at 240p 15 is too long there too, and goes on to the last.
  for (const level of [240, 360] as const) {
    const sizes = levelSteps(level).map((s) => leastBytes(v, s))
    sizes.forEach((n, i) => i && assert.ok(n < sizes[i - 1] === !(levelSteps(level)[i].short === 180 && levelSteps(level)[i].fps === 30), `${level}: step ${i}`))
  }
  // Filmed at 24 frames, 180p at 24 takes less than 240p at 15: there it's a step of its own.
  const film = { ...v, fps: 24 }
  assert.ok(levelSteps(240).every((s, i, all) => !i || leastBytes(film, s) < leastBytes(film, all[i - 1])))
  assert.ok(BPP_FLOOR < BPP_OK)
})

test('“Smallest videos”: at a step, a video is made at just its size and frame rate, a little above its bits per pixel', () => {
  for (const [src, seconds, fps, sound, soundFps] of [
    [{ width: 1920, height: 1080 }, 10, 30, 40_000, 50],
    [{ width: 1080, height: 1920 }, 75, 60, 290_000, 47],
    [{ width: 3840, height: 2160 }, 20, 30, 0, 0],
    [{ width: 1280, height: 720 }, 20, 24, 80_000, 50],
    [{ width: 2560, height: 1440 }, 120, 30, 480_000, 50],
  ] as const) {
    for (const step of levelSteps(360)) {
      const plan = planStep(src, seconds, fps, sound, soundFps, step)
      assert.deepEqual({ width: plan.width, height: plan.height }, fitShort(src, step.short))
      assert.equal(plan.fps, Math.min(step.fps, fps), 'its own frame rate when that’s fewer')
      assert.ok(plan.bpp >= step.bpp && plan.bpp < step.bpp * 1.01, `${plan.bpp} just above ${step.bpp}`)
      // All of it, sound and index too, within what the step takes.
      assert.ok(Math.ceil((plan.bitrate * seconds) / 8) + sound + overhead(seconds, plan.fps, soundFps) <= leastTarget(src, seconds, fps, sound, soundFps, step))
    }
    // The last step is the ladder's last at BPP_FLOOR, as "Smallest" was before the levels (worked out here afresh).
    const last = fitShort(src, 180)
    const f = Math.min(15, fps)
    const before = Math.ceil((last.width * last.height * f * BPP_FLOOR * seconds) / 8) + 1 + sound + overhead(seconds, f, soundFps)
    assert.equal(leastTarget(src, seconds, fps, sound, soundFps), before)
  }
  // The tray's estimate is the same sum with the sound guessed.
  const v = { width: 1920, height: 1080, seconds: 60, fps: 30, sound: true }
  const first = levelSteps(360)[0]
  assert.equal(leastBytes(v, first), leastTarget(v, 60, 30, Math.ceil((48_000 * 60) / 8), 47, first))
})

test('“Smallest videos”: a video that fits its level is made just as before the steps; every shape, frame rate and length plans at every step', () => {
  const shapes = [[640, 480], [1440, 1080], [1080, 1440], [1920, 1080], [1080, 1350], [3840, 2160], [64, 48], [48, 48]]
  let plans = 0
  for (const [width, height] of shapes)
    for (const fps of [5, 10, 15, 24, 25, 30, 60])
      for (let frames = 1; frames <= 900; frames += 7) {
        const seconds = frames / fps
        for (const [sound, soundFps] of [[0, 0], [Math.ceil(seconds * 4000), 50]]) {
          const src = { width, height }
          for (const step of levelSteps(360)) {
            const plan = planStep(src, seconds, fps, sound, soundFps, step)
            assert.ok(plan.bpp >= step.bpp, `${step.short}p${step.fps}: ${width}×${height}, ${frames} frames at ${fps}`)
            assert.deepEqual({ width: plan.width, height: plan.height }, fitShort(src, step.short))
            plans++
          }
          // Before the steps, a level was planned by "To fit"'s ladder from what it took (2026-10-27): the same plan.
          for (const level of [240, 360] as const) {
            const first = levelSteps(level)[0]
            assert.deepEqual(planStep(src, seconds, fps, sound, soundFps, first), planVideo(src, seconds, fps, leastTarget(src, seconds, fps, sound, soundFps, first), sound, soundFps))
          }
        }
      }
  assert.equal(plans, shapes.length * 7 * Math.ceil(900 / 7) * 2 * 6)
})

test('too long for its level, a video steps down to the first step that fits; only one too long even at 180p 15 is refused', () => {
  // A 1080p video filmed at 30 frames a second, with the sound most browsers make (32 kbit/s), as the worker
  // counts it: the first of its level's steps that fits a link's 2 MB, less what the rest of the link takes.
  const src = { width: 1920, height: 1080 }
  const step = (level: VideoLevel, seconds: number, fps = 30) => {
    const steps = levelSteps(level)
    const sound = Math.ceil((32_000 * seconds) / 8)
    const at = steps.findIndex((s) => leastTarget(src, seconds, fps, sound, 50, s) <= 1_990_000)
    return at < 0 ? 'too long' : said([{ ...steps[at], fps: Math.min(steps[at].fps, fps) }])[0]
  }
  // At 240p: up to about 1½ minutes at 30 frames a second, 2½ at 15, then 180p at 15 to about 4½ (with sound
  // counted as the page guesses it, 48 kbit/s, a little less: the tray says too long from about 3 min 40 s).
  assert.deepEqual([60, 90, 92, 120, 152, 153, 280, 281].map((s) => step(240, s)), ['240p30', '240p30', '240p15', '240p15', '240p15', '180p15 floor', '180p15 floor', 'too long'])
  assert.deepEqual([45, 46, 83, 84, 91, 92, 152, 153].map((s) => step(360, s)), ['360p30', '360p15', '360p15', '240p30', '240p30', '240p15', '240p15', '180p15 floor'])
  assert.deepEqual([60, 280, 281].map((s) => step(180, s)), ['180p15 floor', '180p15 floor', 'too long'])
  // Filmed at 24 frames a second, 180p at 24 is reached, between 240p 15 and the last.
  assert.deepEqual([108, 109, 152, 153, 162, 163].map((s) => step(240, s, 24)), ['240p24', '240p15', '240p15', '180p24', '180p24', '180p15 floor'])
  // The worker goes on down from the step the page planned, never above it, if the real sound takes more than
  // counted (Opus, smaller than Safari's AAC, gets a try before a step down).
  const shrink = read('../src/video/shrink.ts')
  assert.match(shrink, /const at = o\.steps\.findIndex\(\(step\) => leastTarget\(video, seconds, report\.source\.fps, bytes, fps, step\) <= target\)\n\s+return \{ audio, sound: report\.sound, at, plan: at < 0 \? undefined : planStep\(video, seconds, report\.source\.fps, bytes, fps, o\.steps\[at\]\) \}/)
  assert.match(shrink, /if \(!planned\) throw new VideoError\('too-long'\)/)
  // So the line saying a video is too long has nothing to point to: 180p is the last step already (the "choose 180p"
  // link, 2026-10-27, is gone).
  assert.doesNotMatch(read('../src/prep/list.ts') + read('../src/tray.ts') + read('../src/shrinkCopy.ts'), /VIDEO_180|VIDEO_LINK|at180|videoLink/)
  // The page plans the first step at which everything fits, all videos at the same one, from "Smallest videos"' own.
  const list = read('../src/prep/list.ts')
  assert.match(list, /const videoSteps = \(\) => \(settings\(\)\.shrink === 'smallest' \? levelSteps\(settings\(\)\.smallestVideos\) : undefined\)/)
  assert.match(list, /function planCopies\(c: Compose<Row>, items: Row\[\], lower: boolean, steps = videoSteps\(\)\): Plan \{\n\s+for \(let i = 0; ; i\+\+\) \{\n\s+const plan = planAt\(c, items, lower, steps\?\.\[i\]\)\n\s+if \(plan\.fits \|\| !steps \|\| i >= steps\.length - 1 \|\| !items\.some\(\(r\) => r\.video\)\) return \{ \.\.\.plan, steps: steps\?\.slice\(i\) \}/)
})

test('the Settings cards say what each video level takes, about', () => {
  const html = read('../index.html')
  const card = html.slice(html.indexOf('<div class="info-card" id="s-video-level-about" hidden>'))
  const said = (level: number) => Number(new RegExp(`<b>${level}p:</b> [^<]*About ([0-9.]+) MB a minute`).exec(card)![1]) * 1e6
  const src = { width: 1920, height: 1080 }
  for (const level of VIDEO_LEVELS) {
    // Sound at 32 kbit/s (most browsers) or 48 (Safari's AAC, about): the card is within 15% of either.
    for (const rate of [32_000, 48_000]) {
      const minute = leastTarget(src, 60, 30, Math.ceil((rate * 60) / 8), 50, levelSteps(level)[0])
      assert.ok(Math.abs(minute / said(level) - 1) <= 0.15, `${level}p at ${rate}: ${minute} for ${said(level)}`)
    }
  }
  // "So about 45 seconds fit" at 360p, in a link's 2 MB (a little less, for the rest of the link).
  assert.match(card, /<b>360p:<\/b> [^<]*so about 45 seconds fit\./)
  for (const rate of [32_000, 48_000]) {
    let s = 1
    while (leastTarget(src, s + 1, 30, Math.ceil((rate * (s + 1)) / 8), 50, levelSteps(360)[0]) <= 1_950_000) s++
    assert.ok(s >= 40 && s <= 50, `${s} s at ${rate}`)
  }
})

test('both choices sit in Advanced, each with its ⓘ card, and are wired to the settings', () => {
  const html = read('../index.html')
  const advanced = html.slice(html.indexOf('<details class="advanced">'), html.indexOf('</details>', html.indexOf('<details class="advanced">')))
  for (const [id, name, title, values, labels] of [
    ['s-photo-level', 'photo-level', 'Smallest photos', ['least', 'medium', 'good'], ['Least', 'Medium', 'Good']],
    ['s-video-level', 'video-level', 'Smallest videos', ['180', '240', '360'], ['180p', '240p', '360p']],
  ] as const) {
    assert.ok(advanced.includes(`<strong id="${id}-title">${title}</strong>`), title)
    assert.ok(advanced.includes(`<button class="info-btn" id="${id}-info" type="button" aria-expanded="false" aria-controls="${id}-about" aria-label="What these choices do">`))
    assert.ok(advanced.includes(`<div class="info-card" id="${id}-about" hidden>`))
    assert.ok(advanced.includes(`<div class="seg" id="${id}" role="radiogroup" aria-labelledby="${id}-title">`))
    values.forEach((v, i) => {
      const described = id === 's-photo-level' ? `s-photo-${v}` : `s-video-${v}`
      assert.ok(advanced.includes(`<label><input type="radio" name="${name}" value="${v}" aria-describedby="${described}" /><span>${labels[i]}</span></label>`), v)
      assert.ok(advanced.includes(`<p id="${described}"><b>${labels[i]}:</b> `), described)
    })
  }
  // Only with "Smallest", and photos never smaller; videos step down until they fit
  // (2026-11-01), down to 180p, the last step.
  assert.equal(advanced.split('<p>What “Smallest” makes them, never smaller: if they don’t all fit, Slynk says so.</p>').length - 1, 1)
  assert.equal(advanced.split('<p>What “Smallest” makes them. If they don’t all fit, they’re made at 15 frames a second, then a size smaller, until they do. Too long even at 180p, Slynk says so.</p>').length - 1, 1)
  // A clip filmed at fewer frames a second keeps them: "up to".
  for (const level of VIDEO_LEVELS) assert.match(advanced, new RegExp(`<b>${level}p:</b> up to ${level === 180 ? 15 : 30} frames a second\\.`))
  const main = read('../src/main.ts')
  assert.match(main, /input\[name="photo-level"\]'\)\.forEach\(\(r\) => \(r\.checked = r\.value === s\.smallestPhotos\)\)/)
  assert.match(main, /input\[name="video-level"\]'\)\.forEach\(\(r\) => \(r\.checked = Number\(r\.value\) === s\.smallestVideos\)\)/)
  assert.match(main, /updateSettings\(\{ smallestPhotos: r\.value as Settings\['smallestPhotos'\] \}\)/)
  assert.match(main, /updateSettings\(\{ smallestVideos: Number\(r\.value\) as Settings\['smallestVideos'\] \}\)/)
})

test('a new level makes those it’s for again, only with “Smallest”, keeping the rest and each “Send full size instead”', () => {
  const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
  assert.match(tray, /if \(s\.smallestPhotos !== photoLevelWas \|\| s\.smallestVideos !== videoLevelWas\) \{/)
  assert.match(tray, /const only = \(row: Row\) => \(photosToo && isPhoto\(row\)\) \|\| \(videosToo && !!row\.video\) \|\| !!was\?\.\(row\)\n\s+if \(job && !only\(job\.row\)\) levelPending = only\n\s+else track\(fullSize\(true, only\)\)/)
  // A video or document being made that the change isn't for goes on; what it's for is made again once its
  // run ends, or when new files stop that run (the review, 2026-10-27).
  const ends = tray.slice(tray.indexOf('const after = o.runEnding?.()'))
  assert.match(ends, /^const after = [^\n]*\n\s+\/\/ [^\n]*\n\s+if \(levelPending\) track\(fullSize\(true, levelPending\)\)/)
  assert.match(tray, /job\?\.stop\.abort\(\)\n\s+unqueue\(\)\n\s+if \(levelPending\) track\(fullSize\(true, levelPending\)\)/)
  assert.match(tray, /async function fullSize\(keepChoices = false, only\?: \(row: Row\) => boolean\) \{\n\s+levelPending = undefined/)
  assert.match(tray, /function clear\(\) \{\n\s+levelPending = undefined/)
  assert.match(tray, /for \(const row of rows\) \{\n\s+if \(only && !only\(row\)\) continue\n\s+\/\/ [^\n]*\n\s+if \(keepChoices && row\.useFull\) continue/)
  // "As small as it can" only where each kind made is at its least.
  assert.match(tray, /const least = \(!made\.photos \|\| settings\(\)\.smallestPhotos === 'least'\) && \(!made\.videos \|\| settings\(\)\.smallestVideos === 180\)/)
})

test('a copy with room for its measured top size is made at it, in one try (it was guessed a little under: 2,027 of 2,048)', async () => {
  const calls: number[] = []
  const encode = async (edge: number, quality: number) => {
    calls.push(edge)
    return Math.round(400_000 * (edge / MAX_EDGE) ** 2 * (quality / Q_MAX) ** 3)
  }
  const top = { edge: MAX_EDGE, quality: Q_MAX, size: 400_000 }
  for (const target of [400_000, 408_000, 2_000_000]) {
    calls.length = 0
    const r = await searchCopy(photo.dims, target, encode, top, true)
    assert.deepEqual(r && [r.edge, r.quality], [MAX_EDGE, Q_MAX], `target ${target}`)
    assert.deepEqual(calls, [MAX_EDGE])
  }
  // Short of room for it, it still finds the largest that fits below.
  const r = await searchCopy(photo.dims, 300_000, encode, top, true)
  assert.ok(r && r.edge < MAX_EDGE && r.size <= 300_000)
})

test('“Good” measures the top size, and a copy with room for it tries that first', () => {
  const draw = read('../src/shrink/draw.ts')
  assert.match(draw, /export async function measure\(bytes: Uint8Array, info: PhotoInfo, o: MeasureOptions = \{\}\): Promise<Measured>/)
  assert.match(draw, /const top = o\.top \|\| o\.keep === 'good'/)
  assert.match(draw, /const atTop = top \? await measureTop\(base, atMax, hint\) : undefined/)
  assert.match(draw, /hint, top: atTop\?\.top \}/)
  assert.match(draw, /const found = await searchCopy\(base, target, encode, m\.top && m\.top\.size <= target \? m\.top : m\.hint, lower\)/)
})

test('the About page says what each choice does', () => {
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  assert.match(about, /Under Advanced \(“Smallest photos”\), “Medium” keeps 1,280 pixels at a better quality, and “Good” goes up to 2,048 pixels at a good quality/)
  assert.match(about, /With “Smallest”, the first choice under “Shrink photos, media &amp; docs” in Settings, a video is made at about 426 × 240 pixels at most \(240p\), at up to 30 frames a second\. If it doesn’t fit that way beside everything else, it’s made at 15 frames a second, then a size smaller, until it fits, as far as 320 × 180 pixels \(180p\) at 15 frames a second and a lower quality, which fits up to about 3½ minutes; if it’s too long even for that, Slynk says so\. Several videos step down together\. In Settings, under Advanced \(“Smallest videos”\), you can start at 360p \(640 × 360\) instead, or at 180p, as small as it goes\./)
  // About 3½ minutes at the last step, as the tray counts a 1080p video with sound (beside nothing else).
  let s = 1
  while (leastBytes({ width: 1920, height: 1080, seconds: s + 1, fps: 30, sound: true }) <= 1_990_000) s++
  assert.ok(s >= 200 && s <= 225, `${s} s`)
  assert.match(about, /They’re never made smaller than you choose: if they don’t all fit, Slynk says how many do\./)
  assert.deepEqual(fitShort({ width: 1920, height: 1080 }, 240), { width: 426, height: 240 })
  assert.deepEqual(fitShort({ width: 1920, height: 1080 }, 360), { width: 640, height: 360 })
  assert.deepEqual(fitShort({ width: 1920, height: 1080 }, 180), { width: 320, height: 180 })
})
