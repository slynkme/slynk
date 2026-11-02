// The wording for smaller copies of photos (shrinkCopy.ts) stays plain, and
// the About page keeps explaining how copies are made, with numbers that
// match the code.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FLOOR_EDGE, MAX_EDGE, Q_FLOOR, Q_LOWEST } from '../src/shrink/plan.ts'
import * as copy from '../src/shrinkCopy.ts'

const about = readFileSync(new URL('../about/index.html', import.meta.url), 'utf8').replace(/\s+/g, ' ')

const PROBLEMS: copy.DocProblem[] = ['signed', 'locked', 'unreadable', 'none', 'big', 'tight', 'blocked', 'failed']
const all: Array<[string, string]> = Object.entries(copy).flatMap(([name, v]): Array<[string, string]> =>
  name === 'DOC_PROBLEM'
    ? PROBLEMS.flatMap((p): Array<[string, string]> => [
        [`DOC_PROBLEM ${p}, PDF`, copy.DOC_PROBLEM(p, true)],
        [`DOC_PROBLEM ${p}, document`, copy.DOC_PROBLEM(p, false)],
      ])
    : [[name, typeof v === 'function' ? (v as (...a: unknown[]) => string)(3, 5, false) : String(v)]],
)

test('plain words on the screens: no mechanics, no “server”, no “hide”', () => {
  for (const [name, s] of all) {
    assert.doesNotMatch(s, /canvas|encod|re-?draw|resolution|jpeg|webp|metadata|server|\bhid(e|den)\b|slynk\.me/i, name)
  }
})

test('the offer promises no fit before anything is measured, and says only the copies go', () => {
  assert.equal(copy.OFFER(1), 'Slynk can make your photo smaller to help it fit. Only the smaller version is sent.')
  assert.equal(copy.OFFER(4), 'Slynk can make your photos smaller to help them fit. Only the smaller versions are sent.')
  assert.equal(copy.OFFER_BUTTON(1), 'Make it smaller')
  assert.equal(copy.OFFER_BUTTON(4), 'Make them smaller')
  assert.equal(copy.WORKING(0, 1), 'Making your photo smaller…')
  assert.equal(copy.WORKING(0, 3), 'Making your photos smaller…')
  assert.equal(copy.WORKING(2, 3), 'Making your photos smaller… 2 of 3')
})

test('when they can’t all fit, it says how many can', () => {
  // Not "remove 2": the count assumes the smallest stay, and the sender chooses.
  assert.equal(copy.NO_FIT(3, 5), 'Even at their smallest, only 3 of these 5 photos fit. Remove some to make room.')
  assert.equal(copy.NO_FIT(3, 5, 3), copy.NO_FIT(3, 5))
  assert.equal(copy.NO_FIT(2, 6, 4), 'Even at their smallest, only 2 of these 6 photos fit, or 4 at a lower quality. Remove some to make room.')
  assert.equal(copy.NO_FIT(0, 6, 1), 'Even at their smallest, none of these 6 photos fit, or 1 at a lower quality. Remove some to make room.')
  assert.equal(copy.NO_FIT(0, 5), 'Even at their smallest, these photos don’t fit with everything else. Remove something to make room.')
  assert.equal(copy.NO_FIT(0, 1), 'Even at its smallest, this photo doesn’t fit with everything else. Remove something to make room.')
})

test('with the setting on, it says how many to remove (the lower quality is already its call)', () => {
  assert.equal(copy.NO_FIT_AUTO(16, 18), 'Even at their smallest, only 16 of these 18 photos fit. Remove at least 2 to make room.')
  assert.equal(copy.NO_FIT_AUTO(0, 5), copy.NO_FIT(0, 5))
  assert.equal(copy.NO_FIT_AUTO(0, 1), copy.NO_FIT(0, 1))
})

test('with the setting off, a lower quality is offered, never just used', () => {
  assert.equal(copy.LOWER(3, 5), 'Even at their smallest, only 3 of these 5 photos fit. At a lower quality all 5 can, though they may look a little blocky up close.')
  assert.equal(copy.LOWER(0, 5), 'Even at their smallest, these photos don’t fit with everything else. At a lower quality all 5 can, though they may look a little blocky up close.')
  assert.match(copy.LOWER(0, 1), /^Even at its smallest, this photo doesn’t fit with everything else\. At a lower quality it can/)
  assert.equal(copy.LOWER_BUTTON, 'Lower the quality')
  assert.match(copy.COPY_NOTE({ width: 1280, height: 960 }, { width: 4032, height: 3024 }, true), /^Made smaller, lower quality: 1280/)
  // A photo that keeps its size doesn't read "(was the same)".
  assert.equal(copy.COPY_NOTE({ width: 900, height: 600 }, { width: 900, height: 600 }).replace(/\u00a0/g, ' '), 'Made smaller: 900 × 600 pixels, saved at a lower quality')
})

test('once copies fit, a quiet line says more photos are welcome', () => {
  assert.equal(copy.ROOM, 'Add more photos if you like: Slynk will fit them in.')
})

test('copies made by themselves are owned up to, with the way to full size', () => {
  // The link (AUTO_OFF) ends the sentence: "… For full size, choose “Ask first” in Settings."
  assert.equal(`${copy.AUTO(true)} ${copy.AUTO_OFF}.`, 'Slynk made your photos smaller to fit, and there’s room for more. For full size, choose “Ask first” in Settings.')
  assert.equal(`${copy.AUTO(false)} ${copy.AUTO_OFF}.`, 'Slynk made your photos smaller to fit. For full size, choose “Ask first” in Settings.')
  // A lower quality (the setting's call) is owned up to as well; each row says which photos.
  assert.equal(`${copy.AUTO(true, true)} ${copy.AUTO_OFF}.`, 'Slynk made your photos smaller and lowered the quality to fit. For full size, choose “Ask first” in Settings.')
})

test('with “Smallest”, it says they were made as small as they go, and the way to a better quality', () => {
  assert.equal(copy.SMALLEST({ photos: 1 }), 'Slynk made your photo as small as it can, so it sends faster.')
  assert.equal(copy.SMALLEST({ photos: 2, audio: 1 }), 'Slynk made your photos and audio file as small as it can, so they send faster.')
  assert.equal(copy.SMALLEST({ photos: 1 }, { photos: 3 }), 'Slynk made 1 of your photos as small as it can, so it sends faster.')
  // Photos or videos made at a better level ("Smallest photos" or "Smallest videos"): not as small as it can.
  assert.equal(copy.SMALLEST({ photos: 2 }, undefined, false), 'Slynk made your photos smaller, so they send faster.')
  assert.equal(copy.SMALLEST_FIT, 'For better quality, choose “To fit” in Settings.')
})

test('a photo going as it is reads “full size”, not as if Slynk had squeezed it', () => {
  assert.equal(copy.SIZE_FULL, 'full size')
})

test('each copy shows its size, and the photo’s', () => {
  const note = copy.COPY_NOTE({ width: 2048, height: 1536 }, { width: 4032, height: 3024 })
  assert.equal(note.replace(/\u00a0/g, ' '), 'Made smaller: 2048 × 1536 pixels (was 4032 × 3024)')
  assert.deepEqual(note.split(' '), ['Made', 'smaller:', '2048\u00a0×\u00a01536\u00a0pixels', '(was\u00a04032\u00a0×\u00a03024)']) // breaks only between these
})

test('the About page explains it, with the same numbers as the code', () => {
  assert.match(about, /<details id="smaller-copies"> <summary>How does Slynk make photos smaller\?<\/summary>/)
  assert.match(about, /and can make photos, videos and documents smaller\./) // in "Why only 2 MB?"
  // "Smallest", the default (2026-10-26): the floor size at the lowest quality.
  assert.match(about, /Slynk makes each photo as small as it can, or as you choose in Settings, so it sends faster, and says so\./)
  assert.ok(about.includes(`each is redrawn at ${FLOOR_EDGE.toLocaleString('en')} pixels on the long side (a smaller photo keeps its own size), at a low quality`))
  assert.ok(Q_LOWEST <= 0.5, '“a low quality … a little blocky up close”')
  assert.match(about, /With “Smallest”, the first choice under “Shrink photos, media &amp; docs” in Settings, each is redrawn at/)
  assert.match(about, /With “To fit”, Slynk makes photos smaller only when what you’ve added is over 2 MB:/)
  assert.match(about, /To keep your photos at full size, choose “Ask first”: Slynk then asks before making them smaller, when they don’t fit, and again before lowering the quality further\. Once you’ve said yes, photos you add afterwards are made smaller too\./)
  assert.ok(about.includes(`about ${FLOOR_EDGE.toLocaleString('en')} pixels on the long side`))
  assert.ok(Q_FLOOR >= 0.7, '“a slightly lower quality”')
  assert.match(about, /If the photos still don’t fit, it lowers the quality further, though they may look a little blocky up close[.;]/)
  assert.match(about, /Only the smaller versions are sent; your originals stay on your device\./)
  assert.match(about, /none of the original’s hidden details \(metadata\), like where it was taken or the camera, go with it/)
  assert.match(about, /Animations are left as they are, since only their first frame would be kept/)
  assert.match(about, /with fewer pixels if needed/)
  assert.ok(about.includes(`at up to ${MAX_EDGE.toLocaleString('en')} pixels on the long side (about 4 megapixels`))
  assert.match(about, /so Slynk doesn’t make them bigger just because there’s room/)
  assert.match(about, /Once you’ve said yes, photos you add afterwards are made smaller too\./)
  assert.match(about, /HDR and very vivid photos may look a little flatter/)
  assert.match(about, /HEIC photos, which iPhones and some Android phones take, can be made smaller in Safari, and in other browsers where the device can decode HEVC video, as Chrome and Brave can on many phones\. Firefox on Android can’t yet\./)
})
