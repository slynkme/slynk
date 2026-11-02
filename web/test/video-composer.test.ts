// "Make photos and videos smaller to fit" in the composer: how a
// video shares the space with photos, when it's made again, what the sender
// reads, and that a video too big to go as it is is never read. The encoding
// needs a browser; the tray's wiring is read from its source, and its
// behaviour checked in the browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { allocate, weight } from '../src/shrink/plan.ts'
import * as copy from '../src/shrinkCopy.ts'
import { avcC } from '../src/video/avc.ts'
import { videoInfo } from '../src/video/info.ts'
import { mux } from '../src/video/mux.ts'
import { LADDER, goodBytes, leastBytes, planVideo, videoWeight, type VideoShape } from '../src/video/plan.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
const fn = (name: string) => {
  const start = tray.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  return tray.slice(start, tray.indexOf('\n  }\n', start))
}
const minute: VideoShape = { width: 3840, height: 2160, seconds: 60, fps: 30, sound: true }

test('a video’s good size and smallest size come from its shape alone', () => {
  // A minute of 4K: at a good quality far over 2 MB, at its smallest well under.
  assert.ok(goodBytes(minute) > 5_000_000)
  assert.ok(leastBytes(minute) < 600_000)
  assert.ok(leastBytes(minute) < goodBytes(minute))
  // Five minutes' smallest is over the space: too long, said before anything is made.
  assert.ok(leastBytes({ ...minute, seconds: 300 }) > 1_950_000)
  // A planned video at its share really fits that share.
  const share = 1_400_000
  const plan = planVideo(minute, 60, 30, share, (48_000 * 60) / 8, 47)!
  assert.ok((plan.bitrate * 60) / 8 + (48_000 * 60) / 8 < share)
})

test('a minute of video and six photos share 2 MB; ten don’t fit even at their smallest, which is said at once', () => {
  // 12-megapixel photos, measured at about 150 KB smallest, 1.2 MB as they are.
  const photo = { full: 1_200_000, least: 150_000, weight: weight({ width: 4032, height: 3024 }) }
  const video = { full: goodBytes(minute), least: leastBytes(minute), weight: videoWeight(minute) }
  const plan = allocate(1_950_000 - 8_000, [video, ...Array(6).fill(photo)])
  assert.ok(plan.fits)
  if (!plan.fits) return
  const [v, ...photos] = plan.sizes
  assert.ok(v >= leastBytes(minute), 'the video gets at least its smallest')
  for (const p of photos) assert.ok(p >= 150_000, `a photo gets ${p}`)
  assert.ok(v + photos.reduce((a, b) => a + b, 0) <= 1_950_000 - 8_000)
  // Ten photos at 150 KB and a minute's smallest (mostly its sound) come to over 2 MB.
  assert.equal(allocate(1_950_000 - 8_000, [video, ...Array(10).fill(photo)]).fits, false)
})

test('a short video lets photos keep a good size; a clip already small goes as it is', () => {
  const short: VideoShape = { width: 1920, height: 1080, seconds: 10, fps: 30, sound: true }
  const photo = { full: 1_200_000, least: 150_000, weight: weight({ width: 4032, height: 3024 }) }
  const plan = allocate(1_942_000, [{ full: goodBytes(short), least: leastBytes(short), weight: videoWeight(short) }, photo, photo])
  assert.ok(plan.fits && plan.sizes[1] > 400_000, 'two photos beside 10 s keep about 500 KB each')
  // A 3 s clip of 200 KB, under what a good quality would take: it goes as it is when there's room.
  const clip: VideoShape = { width: 1920, height: 1080, seconds: 3, fps: 30, sound: true }
  assert.ok(goodBytes(clip) > 200_000)
  const both = allocate(1_900_000, [{ full: 200_000, least: leastBytes(clip), weight: videoWeight(clip) }, { full: 900_000, least: 150_000, weight: 3_000_000 }])
  assert.ok(both.fits && both.sizes[0] === 200_000 && both.sizes[1] === 900_000)
})

test('what the sender reads about videos', () => {
  assert.equal(copy.whatSmaller({ videos: 1 }), 'your video')
  assert.equal(copy.whatSmaller({ photos: 3, videos: 1 }), 'your photos and video')
  assert.equal(copy.whatSmaller({ photos: 1, videos: 2 }), 'your photo and videos')
  assert.equal(copy.OFFER_MIXED({ videos: 1 }), 'Slynk can make your video smaller to help it fit. Only the smaller version is sent.')
  assert.equal(copy.OFFER_MIXED({ photos: 2, videos: 1 }), 'Slynk can make your photos and video smaller to help them fit. Only the smaller versions are sent.')
  assert.equal(copy.OFFER_BUTTON_MIXED({ videos: 1 }), 'Make it smaller')
  assert.equal(copy.AUTO_MIXED({ photos: 2, videos: 1 }), 'Slynk made your photos and video smaller to fit.')
  assert.equal(copy.AUTO_MIXED({ photos: 2, videos: 1 }, true), 'Slynk made your photos and video smaller to fit, and there’s room for more.')
  assert.equal(copy.AUTO_MIXED({ videos: 1 }, true), 'Slynk made your video smaller to fit, and there’s room for more.')
  assert.equal(copy.NO_FIT_VIDEO({ videos: 1 }), 'This video is too long to fit, even made smaller.')
  assert.equal(copy.NO_FIT_VIDEO({ photos: 4, videos: 1 }), 'Too much to fit, even made smaller. Remove the video or some photos.')
  assert.equal(copy.NO_FIT_VIDEO({ videos: 2 }), 'Too much to fit, even made smaller. Remove a video.')
  assert.equal(copy.WORKING_VIDEO(0.4, 1, 1), 'Making your video smaller… 40%')
  assert.equal(copy.WORKING_VIDEO(1, 2, 3), 'Making your videos smaller… 2 of 3, 99%', 'never 100% until it’s done')
  // Each size stays on one line, so a phone breaks before "(was".
  const note = copy.VIDEO_NOTE({ width: 288, height: 512 }, { width: 2160, height: 3840 })
  assert.deepEqual(note.split(' '), ['Made', 'smaller:', '288 × 512 pixels', '(was 2160 × 3840)'])
  assert.match(copy.VIDEO_NOTE({ width: 320, height: 180 }, { width: 1920, height: 1080 }, 15), /pixels, 15 frames a second \(was/)
})

test('a video’s details are read from its index; anything else isn’t a video', async () => {
  const sps = new Uint8Array([0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40])
  const pps = new Uint8Array([0x68, 0xeb, 0xe3, 0xcb])
  const frames = Array.from({ length: 60 }, (_, i) => ({ data: new Uint8Array(100), pts: Math.round((i * 1e6) / 30), duration: 33_333, key: i % 30 === 0 }))
  const sound = Array.from({ length: 94 }, (_, i) => ({ data: new Uint8Array(50), pts: Math.round((i * 1024e6) / 48000), duration: 21_333, key: true }))
  const file = mux({ width: 640, height: 360, rotation: 90, description: avcC([sps], [pps]), samples: frames }, { codec: 'aac', sampleRate: 48000, channels: 1, description: new Uint8Array([0x11, 0x88]), samples: sound })
  const info = await videoInfo(new Blob([file as BlobPart]))
  assert.ok(info)
  assert.deepEqual([info.width, info.height, info.rotation, info.sound], [640, 360, 90, true])
  assert.ok(Math.abs(info.seconds - 2) < 0.05 && Math.abs(info.fps - 30) < 1)
  assert.equal(info.can, 'browser', 'Node has no WebCodecs: the row would say this browser can’t')
  assert.equal(await videoInfo(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])])), null)
  assert.equal(await videoInfo(new Blob([new Uint8Array(200)])), null)
})

test('a video too big to go as it is is never read: only its index, then a smaller version', () => {
  const place = fn('place')
  assert.match(place, /const v = \(row\.video = await videoInfo\(row\.file\)\)/)
  assert.match(place, /if \(v && wireAs\(row, row\.name, row\.file\.type, row\.file\.size\) > o\.limit\(\)\) \{\n\s+row\.state = 'video'/)
  // Too long even at its smallest: said at once, before anything slow.
  assert.match(place, /least > o\.planLimit\(\) \? 'long' : undefined/)
  assert.ok(place.indexOf("row.state = 'video'") < place.indexOf('processRow(row)'))
  // The meter counts it as over until it's made smaller.
  assert.match(fn('compose'), /else if \(row\.state === 'video' && !s\) \{\n[^\n]*\n\s+extra \+= row\.file\.size/)
})

test('videos are made last, once additions settle, and only once', () => {
  const run = fn('makeSmallerCopies')
  assert.ok(run.indexOf('makeCopy(') < run.indexOf('makeVideo('), 'photos first')
  assert.match(run, /await settledAdds\(\)/)
  // A video made smaller keeps that version; photos added or taken
  // away later share what it leaves. Only when nothing else could make room is it planned again,
  // and then made again only if it no longer fits.
  assert.match(tray, /const kept = \(row: Row\) => !!row\.video && !!row\.vcopy && !row\.useFull/)
  assert.match(tray, /return loose\.length \|\| !items\.some\(kept\) \? loose : items/)
  assert.match(run, /const shared = sharing\(items\)\n\s+let plan = planCopies\(c, shared, lower\)/)
  assert.match(run, /const target = \(row: Row\) => targets\[shared\.indexOf\(row\)\]/)
  assert.match(run, /const videos = shared\.filter\(\(row\) => row\.video && target\(row\) !== null && \(!row\.vcopy \|\| row\.vcopy\.data\.length > target\(row\)!\)\)/)
  // Never "improved" by itself when photos are taken away, and the room left is counted beside it as it is.
  assert.match(tray, /const improvable = \(row: Row\) =>\n\s+row\.dcopy\n[^\n]*\n\s+: row\.acopy\n[^\n]*\n\s+: !row\.video && inCopy\(row\)/)
  assert.match(fn('roomForMore'), /const known = items\.filter\(\(row\) => \(row\.video \|\| row\.audio \|\| row\.measured \|\| row\.dmeasured\) && !kept\(row\)\)/)
  // Beside it, too many photos are told how many to remove (only the photos are counted).
  assert.match(fn('offer'), /const shared = sharing\(items\)\n\s+const left = kinds\(shared\)/)
  // Taken away, cleared, or the setting turned off: the worker stops.
  assert.match(fn('remove'), /if \(job\?\.row === row\) job\.stop\.abort\(\)/)
  assert.match(fn('clear'), /job\?\.stop\.abort\(\)/)
  assert.match(fn('fullSize'), /job\?\.stop\.abort\(\)/)
  assert.match(fn('fullSize'), /row\.vcopy = undefined/)
  // A video made smaller is a new file: it never holds the original's hidden details, and the recipient is told it was made smaller.
  assert.match(read('../src/ui/cleaning.ts'), /export const VIDEO_HOLDS_NONE = 'A video made smaller never contains hidden data\.'/)
  assert.match(fn('compose'), /smaller: newPicture\(row\)/)
})

test('on iPhones only, a line while the picker is still handing files over', () => {
  const main = read('../src/main.ts')
  assert.match(main, /fileInput\.addEventListener\('click', \(\) => \{\n\s+if \(!isAppleTouch\(\)\) return/)
  assert.match(main, /fileInput\.addEventListener\('change', pickDone\)\nfileInput\.addEventListener\('cancel', pickDone\)/)
  assert.match(read('../index.html'), /<p class="note pick-wait" id="pick-wait" role="status" hidden><\/p>/)
})

test('the setting and the About page say videos too', () => {
  // Three choices, a short line each, on a card behind the title's ⓘ.
  assert.match(read('../index.html'), /<div class="info-card" id="s-shrink-about" hidden>\n\s+<p id="s-shrink-smallest"><b>Smallest:<\/b> whatever their size, to send faster, at a lower quality\.<\/p>\n\s+<p id="s-shrink-fit"><b>To fit:<\/b> only when it’s all over 2 MB\.<\/p>\n\s+<p id="s-shrink-ask"><b>Ask first:<\/b> only when you say\.<\/p>\n\s+<p>Smaller photos and media files hold no hidden details\.<\/p>/)
  const about = read('../about/index.html').replace(/\s+/g, ' ')
  // Videos and audio in one answer, "media".
  assert.match(about, /<details id="smaller-media"> <summary>Can I send videos and audio\?<\/summary>/)
  assert.match(about, /With “To fit”, it’s made at most 640 × 360 pixels, and smaller for longer videos, up to about 3½ minutes;/)
  // True of a tall screen recording too, and of how photos and a video share the space.
  assert.match(about, /with photos too, they share the space: the longer the video, the smaller the photos are made, though never below about 1,280 pixels on their long side\./)
  // "Smallest" (2026-10-26): the ladder's last step, unless "Smallest videos" says otherwise (2026-10-27), and down
  // to that last step when it doesn't fit (2026-11-01).
  assert.match(about, /With “Smallest”, the first choice under “Shrink photos, media &amp; docs” in Settings, a video is made at about 426 × 240 pixels at most \(240p\)/)
  assert.match(about, /as far as 320 × 180 pixels \(180p\) at 15 frames a second and a lower quality, which fits up to about 3½ minutes/)
  assert.deepEqual(LADDER[LADDER.length - 1], { short: 180, fps: 15 })
  // How long it takes isn't on the About page: the screen shows its progress, and says to keep the page open.
  assert.doesNotMatch(about, /as long as the video itself/)
  assert.equal(copy.KEEP_OPEN, 'Keep this page open until it’s done.')
  // About 3½ minutes is where even the last step runs out with Safari's sound (47 kbit/s).
  const at = (seconds: number) => planVideo({ width: 1920, height: 1080 }, seconds, 30, 1_950_000, (seconds * 47_000) / 8, 47)
  assert.ok(at(200) && !at(240))
})

// From the independent review (2026-10-19).
test('only files actually read count against the read budget: a video made smaller never was', () => {
  const place = fn('place')
  assert.match(place, /r !== row && r\.read && r\.state !== 'too-big' \? r\.file\.size : 0/)
  assert.ok(place.indexOf('row.read = true') < place.indexOf('track(processRow(row))'))
  assert.ok(!/row\.read = true/.test(place.slice(0, place.indexOf("row.state = 'video'"))), 'not a video left unread')
})

test('a file added while copies are made stops that run (and its video), so nothing is made for a plan that’s gone', () => {
  assert.match(fn('add'), /if \(shrinking\) \{\n\s+shrinkRun\+\+\n\s+shrinking = undefined\n\s+job\?\.stop\.abort\(\)/)
  assert.match(fn('makeVideo'), /if \(!live\(\) \|\| !rows\.includes\(row\)\) throw new Error\('stopped'\)/)
  // A throw while looking at one file doesn't stop the next ones.
  assert.match(tray, /placing = placing\.then\(\(\) => place\(row\)\)\.catch\(/)
})

test('a video this browser can’t do, or that failed, isn’t tried again by itself; one too long for its share is, when the space changes', () => {
  assert.match(tray, /\(!row\.videoProblem \|\| row\.videoProblem === 'tight'\)/)
  assert.match(fn('videoProblem'), /if \(why === 'stopped'\) return undefined/)
  assert.match(fn('videoProblem'), /if \(\/too-long\/\.test\(why\)\) return 'tight'/)
  assert.equal(copy.VIDEO_PROBLEM.tight, 'Too much to fit with everything else, even made smaller.')
  // The row says the problem even beside an older smaller version; the box doesn't offer the button again.
  assert.match(fn('updateRow'), /: row\.videoProblem\n\s+\? shrinkCopy\.VIDEO_PROBLEM\[row\.videoProblem\]/)
  assert.match(fn('offer'), /if \(items\.some\(\(r\) => r\.videoProblem === 'tight' \|\| r\.docProblem === 'tight' \|\| r\.audioProblem === 'tight'\)\) \{\n\s+return \{ kind: 'no-fit', says: \[shrinkCopy\.NO_FIT_VIDEO\(counts\)\] \}/)
})

test('if Safari’s big AAC sound is what makes a video too long, or takes it a step down, Opus is tried, and kept only if it does better', () => {
  const shrink = read('../src/video/shrink.ts')
  assert.match(shrink, /if \(\(!made\.plan \|\| made\.at > 0\) && made\.audio\?\.codec === 'aac'\) \{\n\s+const aac = made\n\s+const opus = await soundOf\('opus'\)\n\s+if \(opus\.plan && \(!aac\.plan \|\| opus\.at < aac\.at\)\) made = opus\n\s+report\.sound = \{ \.\.\.made\.sound, tries: \[\.\.\.aac\.sound\.tries, \.\.\.opus\.sound\.tries\] \}/)
  // "To fit" has no steps: at is 0, so only a video too long with AAC tries Opus, as before.
  assert.match(shrink, /if \(!o\.steps\) return \{ audio, sound: report\.sound, at: 0, plan: planVideo\(video, seconds, report\.source\.fps, target, bytes, fps\) \}/)
})

test('a worker that dies, or says nothing for a minute while the page is in sight, fails the job instead of hanging it', () => {
  const client = read('../src/video/client.ts')
  assert.match(client, /const SILENT_MS = 60_000/)
  assert.match(client, /w\.addEventListener\('messageerror', broke\)/)
  assert.match(client, /reject\(new ShrinkFailed\(signal\.aborted \? 'stopped' : 'the worker ended unexpectedly'\)\)/)
  assert.match(client, /if \(document\.visibilityState === 'visible'\) heard = Date\.now\(\)/)
})

test('progress never goes back on a second try', () => {
  assert.match(fn('makeVideo'), /row\.vmaking = Math\.max\(row\.vmaking \?\? 0, done\)/)
})

test('a video lined up to be made smaller says it’s waiting, not "too large to send" (which read as "remove it")', () => {
  assert.equal(copy.QUEUED, 'waiting to shrink')
  // So does a zip whose files are (it's made from them once they're done).
  assert.match(fn('rowSize'), /if \(\(row\.vqueued \|\| row\.zip\?\.members\.some\(queued\)\) && !s\) return `\$\{size\(row\.file\.size\)\} · \$\{shrinkCopy\.QUEUED\}`/)
  const run = fn('makeSmallerCopies')
  assert.match(run, /if \(row\.video && !row\.vcopy\) row\.vqueued = true\n\s+if \(row\.doc && !row\.dcopy\) row\.dqueued = true\n\s+if \(row\.audio && !row\.acopy\) row\.aqueued = true\n\s+if \(isPhoto\(row\) && !row\.copy\) row\.pqueued = true/)
  assert.match(run, /shrinking = undefined\n\s+unqueue\(\)/)
  assert.match(fn('makeVideo'), /row\.vqueued = false\n\s+row\.vmaking = 0/)
  assert.match(fn('fullSize'), /unqueue\(\)/)
})

test('each file’s row shows how far it is on its way: lavender working, green ready, red refused, amber asking', () => {
  const stage = fn('stageOf')
  // A video by its real progress; a photo's copy and the reading, cleaning and packing in steps.
  // One bar for a file that's made smaller: its first pass takes the first part, the making
  // smaller the rest, never filling, turning green and starting again.
  assert.match(read('../src/prep/list.ts'), /export const barAt = \(made: number\) => FIRST_PART \+ \(1 - FIRST_PART\) \* made/)
  assert.match(stage, /if \(row\.vmaking !== undefined\) return \{ stage: 'working', p: barAt\(row\.vmaking\) \}/)
  assert.match(stage, /if \(row\.vqueued \|\| row\.pqueued \|\| row\.dqueued \|\| row\.aqueued\) return \{ stage: 'working', p: FIRST_PART \}/)
  assert.match(stage, /const first = mayShrink\(row\) \? FIRST_PART : 1/)
  assert.match(stage, /if \(first < 1\) return \{ stage: 'working', p: FIRST_PART \}/)
  assert.match(read('../src/prep/list.ts'), /export const FIRST_PART = 0\.25/)
  assert.match(stage, /if \(row\.state === 'too-big' \|\| row\.videoProblem \|\| \(row\.state === 'video' && !row\.sending\)\) return \{ stage: 'blocked', p: 1 \}/)
  assert.match(stage, /if \(asking\(row\)\) return \{ stage: 'asking', p: 1 \}/)
  assert.match(stage, /return \{ stage: 'ready', p: 1 \}/)
  assert.match(fn('updateRow'), /paintStage\(row\)/)
  assert.match(fn('paintStage'), /row\.li\.dataset\.stage = stage\n\s+row\.li\.style\.setProperty\('--p', String\(p\)\)/)
  // Redrawn when copies become about to be made, or what goes changes size (the offer's verdict).
  assert.match(fn('showOffer'), /if \(ahead === shrinkAhead && c\.wire === lastWire\) return/)
  // Drawn as a background behind the row (CSSOM, not a style attribute, so the CSP is untouched).
  const css = read('../src/style.css')
  assert.match(css, /\.item\[data-stage\] \{\n\s+--p: 0;\n\s+background-image: linear-gradient\(var\(--stage\), var\(--stage\)\);/)
  for (const [state, token] of [['working', 'accent'], ['ready', 'ok'], ['blocked', 'bad'], ['asking', 'warn']])
    assert.match(css, new RegExp(`\\.item\\[data-stage='${state}'\\] \\{\\n\\s+--stage: color-mix\\(in srgb, var\\(--${token}\\) var\\(--tint\\), transparent\\);`))
  // Lined up photos come off as soon as the plan says they fit as they are.
  assert.match(fn('makeSmallerCopies'), /row\.pqueued = false \/\/ fits as it is, or its copy already does/)
})

test('"What’s happening?" beside "Working out the size…": made smaller here, nothing sent, keep the page open', () => {
  const html = read('../index.html')
  assert.match(html, /<button class="soft-link meter-why" id="meter-working" type="button" aria-haspopup="dialog" hidden>What’s happening\?<\/button>/)
  assert.match(html, /<button class="soft-link meter-why" id="ib-c-meter-working" type="button" aria-haspopup="dialog" hidden>What’s happening\?<\/button>/)
  const sheet = html.slice(html.indexOf('<dialog id="working-why"'), html.indexOf('</dialog>', html.indexOf('<dialog id="working-why"'))).replace(/\s+/g, ' ')
  assert.match(sheet, /Nothing has been sent: your files haven’t left this device, and your originals stay untouched\./)
  assert.match(sheet, /each link carries 2 MB at most\./)
  // Not an upload: sending comes later, at the sender's tap.
  assert.match(sheet, /When it has finished and you click the button to send your files, they will be sent across the mixnet, in small pieces mixed with everyone else’s traffic\./)
  assert.match(sheet, /Keep this page open until it’s done\./)
  const main = read('../src/main.ts')
  assert.match(main, /\$\('meter-working'\)\.hidden = !m\.working/)
  assert.match(main, /infoSheet\('working-why', 'meter-working', 'ib-c-meter-working'\)/)
  assert.match(read('../src/inbox/owner.ts'), /\$\('ib-c-meter-working'\)\.hidden = !m\.working/)
})

test('an encoder that can’t get low enough: a smaller picture next, not a failure (Android, 2026-10-19)', () => {
  const shrink = read('../src/video/shrink.ts')
  assert.match(shrink, /const far = \(videoBytes \* 8\) \/ seconds > asked \* 1\.25/)
  assert.match(shrink, /const step = \(far \|\| overs >= 2\) && smaller < 2 \? smallerStep\(plan, video, report\.source\.fps\) : undefined/)
  assert.match(shrink, /const last = pass >= MAX_PASSES \+ \(stalled \? 1 : 0\) \+ smaller/)
  assert.match(shrink, /if \(!short \|\| raised \|\| last \|\| smaller \|\| o\.steps\) return done\(best!\)/)
  // The bar spends most of itself on the first try, so a second doesn't sit at 97%.
  assert.match(tray, /const pictures = p\.pass <= 1 \? \[0\.12, 0\.8\] : p\.pass === 2 \? \[0\.82, 0\.92\]/)
})

test('the sound moves the bar too, so it doesn’t sit at 26% while a phone makes it', () => {
  const shrink = read('../src/video/shrink.ts')
  // Decoding is the sound's first half; each try at making it reports as it's fed.
  assert.match(shrink, /const pcm = await decodeMono\(read, track, \{ \.\.\.o, onProgress: \(p\) => say\(p\.done \/ 2\) \}\)/)
  assert.match(shrink, /encodePcm\(half \? halve\(pcm\.data\) : pcm\.data, rate, kind, bitrate, \(done\) => say\(from \+ \(to - from\) \* done\)\)/)
  assert.match(shrink, /if \(\(i \/ block\) % 8 === 0\) onDone\?\.\(i \/ pcm\.length\)/)
  // On the bar, between reading and the pictures.
  assert.match(tray, /: p\.stage === 'sound' \? 0\.02 \+ 0\.1 \* p\.done/)
})

test('a drawing way that doesn’t give back what was drawn (Safari’s private windows) isn’t used; with none, the row says so', () => {
  const shrink = read('../src/video/shrink.ts')
  assert.match(shrink, /const scaler = await drawingWay\(o\.scaler \?\? \(ctx \? 'canvas' : 'bitmap'\), report\)/)
  assert.match(shrink, /throw new VideoError\('canvas-blocked'\)/)
  // A red half and a blue half, in whatever layout comes back: video-drawing-check.test.ts.
  assert.match(shrink, /return \{ ok: redAndBlue\(back\.left, back\.right\)/)
  assert.match(fn('videoProblem'), /if \(\/canvas-blocked\/\.test\(why\)\) return 'blocked'/)
  assert.equal(copy.VIDEO_PROBLEM.blocked, 'Your browser stopped Slynk from making it smaller, as some privacy settings and private windows do.')
})
