// "Make a smaller copy" in the tray (tray.ts): with "Smallest" (the default
// since 2026-10-26) every photo is made as small as it goes, fitting or not;
// with "To fit", copies are made by themselves when they don't fit; either
// way the box says so, with a link to the setting. With "Ask first", once the
// sender has asked, photos added later get copies without asking again. While there's room the box says
// more are welcome. The tray needs a page, so these read its source; the
// behaviour is checked in the browser.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
// The composer's screen and the file list it draws (prep/list.ts), which plans for it.
const tray = read('../src/tray.ts') + read('../src/prep/list.ts')
const fn = (name: string) => {
  const start = tray.indexOf(`function ${name}(`)
  assert.ok(start >= 0, name)
  return tray.slice(start, tray.indexOf('\n  }\n', start))
}

test('asking once covers photos added later, until the tray is emptied', () => {
  assert.match(fn('makeSmallerCopies'), /if \(!auto\) copiesChosen = true/)
  assert.match(fn('clear'), /copiesChosen = false/)
  assert.match(fn('remove'), /if \(!rows\.length\) copiesChosen = false/)
})

test('a later photo gets its copy without a tap, and without taking the focus', () => {
  const offer = fn('offer')
  // Whenever the photos or their space change (one taken away, a message cut), but never
  // twice for the same situation, so a copy that failed isn't retried in a loop.
  assert.match(offer, /if \(\(auto \|\| copiesChosen\) && situation\(c, items\) !== lastAuto\) \{/)
  assert.match(fn('makeSmallerCopies'), /lastPhotos = photoSet\(items\)\n\s+lastAuto = situation\(o\.compose\(\), items\)/)
  // With the setting on, photos taken away let the others' copies get better.
  assert.match(offer, /if \(!over && settled && auto && photoSet\(items\) !== lastPhotos && items\.some\(improvable\)\) \{/)
  // The box says to start; the page starts the run once it has drawn it.
  assert.equal(offer.split('start: true').length - 1, 3)
  assert.match(fn('renderOffer'), /if \(offer\.start\) queueMicrotask\(\(\) => void makeSmallerCopies\(false, true\)\)/)
  // A lower quality without a tap only with the setting on, and only when the usual one can't fit.
  const run = fn('makeSmallerCopies')
  assert.match(run, /if \(!plan\.fits && !lower && settings\(\)\.shrink !== 'ask'\) \{\n\s+const low = planCopies\(c, shared, true\)/)
  assert.match(fn('renderOffer'), /queueMicrotask\(\(\) => void makeSmallerCopies\(false, true\)\)/) // never asks for lower itself
  assert.match(fn('makeSmallerCopies'), /o\.changed\(\)\n\s+o\.runStarted\?\.\(auto\)/)
  assert.match(tray, /runStarted: \(auto\) => \{\n\s+if \(!auto\) o\.fitText\.focus\(\)/)
  // While measuring, it counts only the new photos, so one added photo reads "Making a smaller copy…" throughout
  // (and those without the top size "Good" plans with).
  assert.match(fn('makeSmallerCopies'), /total: photos\.filter\(toMeasure\)\.length \|\| photos\.length/)
  assert.match(tray, /const toMeasure = \(row: Row\) => !row\.measured \|\| \(wantTop\(\) && !row\.measured\.top\)/)
})

test('“room for more” shows only when it fits, after copies, with space for another photo at its smallest', () => {
  const offer = fn('offer')
  assert.match(offer, /if \(!over && settled && roomForMore\(c, items\)\) return \{ kind: 'room', look: 'room', says: \[shrinkCopy\.ROOM\] \}/)
  const room = fn('roomForMore')
  assert.match(room, /if \(!items\.some\(inCopy\) \|\| c\.files >= MAX_FILES\) return false/)
  assert.match(room, /return least \+ another <= space/)
  // Beside videos too: everything at its smallest, and one more photo.
  assert.doesNotMatch(room, /row\.video\)\) return false/)
})

test('“Shrink photos, media & docs” is “Smallest” by default, first in Settings, and owned up to with a link', () => {
  const settings = read('../src/ui/settings.ts')
  assert.match(settings, /\n  shrink: 'smallest',\n/)
  // A switch before the three choices: off was "Ask first"; on, the default then, gets today's.
  assert.match(settings, /const \{ shrinkPhotos, \.\.\.kept \} = JSON\.parse\(raw\)\n[^\n]*\n\s+current = \{ \.\.\.DEFAULTS, \.\.\.\(shrinkPhotos === false \? \{ shrink: 'ask' \} : \{\}\), \.\.\.kept, remember: true \}/)
  const html = read('../index.html')
  const sheet = html.slice(html.indexOf('<p class="sheet-note">These apply'))
  // The first setting, its title one line on a phone with an ⓘ after it that
  // shows what the choices do, and its three choices in the order of how small they make things.
  assert.match(sheet, /^<p class="sheet-note">[^\n]*\n\n\s+<h3 class="setting-group">Files and photos<\/h3>\n\s+<!--[^\n]*-->\n\s+<div class="setting stacked">\n\s+<div class="setting-head">\n\s+<strong id="s-shrink-title">Shrink photos, media &amp; docs<\/strong>\n\s+<button class="info-btn" id="s-shrink-info" type="button" aria-expanded="false" aria-controls="s-shrink-about" aria-label="What these choices do">/)
  const main = read('../src/main.ts')
  assert.match(main, /\$\(`\$\{id\}-about`\)\.hidden = !open\n\s+\$\(`\$\{id\}-info`\)\.setAttribute\('aria-expanded', String\(open\)\)/)
  assert.match(main, /const ABOUT_CARDS = \['s-shrink', 's-photo-level', 's-video-level'\]/)
  assert.match(main, /syncSettingsForm\(settings\(\)\)\n\s+for \(const id of ABOUT_CARDS\) showAbout\(id, false\)/) // closed each time Settings opens
  // The choice made in the switches' "on" colour.
  assert.match(read('../src/style.css'), /\.seg input:checked \+ span \{\n[^\n]*\n\s+background: #7c5cff;\n\s+color: #fff;/)
  // Each choice described by its own line, for screen readers (the review, 2026-10-26).
  assert.match(sheet, /<div class="seg" id="s-shrink" role="radiogroup" aria-labelledby="s-shrink-title">\n\s+<label><input type="radio" name="shrink" value="smallest" aria-describedby="s-shrink-smallest" \/><span>Smallest<\/span><\/label>\n\s+<label><input type="radio" name="shrink" value="fit" aria-describedby="s-shrink-fit" \/><span>To fit<\/span><\/label>\n\s+<label><input type="radio" name="shrink" value="ask" aria-describedby="s-shrink-ask" \/><span>Ask first<\/span><\/label>/)
  // Said where the choice is made: a copy is a new picture, so the photo's details never go with it.
  // Only photos and media files (videos and audio): a document made smaller keeps whatever details it still had.
  assert.match(html, /Smaller photos and media files hold no hidden details\./)
  // A link to it opens Settings at the choice made.
  assert.match(read('../src/main.ts'), /;\(\$\(id\)\.querySelector<HTMLInputElement>\('input:checked'\) \?\? \$\(id\)\)\.focus\(\)/)
  const offer = fn('offer')
  assert.match(offer, /if \(!over && settled && auto && items\.some\(inCopy\)\) \{/)
  assert.match(offer, /says: \[`\$\{shrinkCopy\.AUTO\(room, lowered\)\} `, OFF_LINK, '\.'\]/)
  assert.match(tray, /const links: Record<keyof typeof LINK_TEXT, HTMLButtonElement> = \{ off: offLink, fit: fitLink \}/)
  assert.match(tray, /offLink\.addEventListener\('click', \(\) => o\.openSetting\('s-shrink'\)\)/)
  // Both trays open Settings at the switch.
  assert.match(read('../src/main.ts'), /openSetting: openSettingAt,/)
  assert.match(read('../src/inbox/owner.ts'), /openSetting: \(id\) => deps\.openSetting\(id\),/)
})

test('the Cleaned list links to the setting, except for a smaller copy, which holds none whatever it says', () => {
  const html = read('../index.html')
  assert.match(html, /<p class="pop-title" data-part="pop-title"><\/p>\s+<!--[^>]*-->\s+<button class="soft-link" type="button" data-part="pop-set" hidden><\/button>/)
  assert.match(tray, /popSet\.addEventListener\('click', \(\) => o\.openSetting\('s-strip'\)\)/)
  // A photo or video made smaller is a new picture; a document made smaller keeps what it had.
  assert.match(tray, /part\(li, 'pop-set'\)\.hidden = fresh\n\s+part\(li, 'pop-copy'\)\.hidden = !fresh/)
  assert.match(tray, /const newPicture = \(row: Row\) => inCopy\(row\) && !row\.dcopy/)
  const words = read('../src/ui/cleaning.ts')
  assert.match(words, /export const CHANGE_SETTING = 'Change in Settings'/)
  assert.match(words, /export const COPY_HOLDS_NONE = 'A photo made smaller never contains hidden data\.'/)
})

test('a photo going as it is says "full size", and copies in progress or done show as an info card', () => {
  assert.match(tray, /if \(row\.photo\) return `\$\{size\(s\.data\.length\)\} · \$\{shrinkCopy\.SIZE_FULL\}`/)
  const render = fn('renderOffer')
  assert.match(render, /box\.classList\.remove\('room', 'busy'\)/)
  assert.match(render, /if \(offer\.look\) box\.classList\.add\(offer\.look\)/)
  assert.match(render, /'br' in p \? document\.createElement\('br'\) : links\[p\.link\]/)
  // Every "Making smaller copies…" (or a video's progress), and the wait for stronger compression, is the busy card.
  const offer = fn('offer')
  assert.equal(offer.split("look: 'busy'").length - 1, 5)
  assert.match(offer, /return \{ kind: 'working', look: 'busy', says: \[workingText\(\), \.\.\.\(shrinking\.video \? \[BR, shrinkCopy\.KEEP_OPEN\] : \[\]\)\] \}/)
  assert.match(offer, /const better = items\.filter\(improvable\)\n[^\n]*\n[^\n]*\n\s+const says = betterPhotos\n\s+\? shrinkCopy\.WORKING\(0, betterPhotos\)\n\s+: betterDocs\n\s+\? shrinkCopy\.WORKING_DOC\(0, 1, betterDocs\)\n\s+: shrinkCopy\.WORKING_AUDIO\(0, 1, better\.length\)\n\s+return \{ kind: 'start', look: 'busy', says: \[says\], start: true \}/)
  assert.match(tray, /o\.fit\.prepend\(badge\)/)
})

test('with the setting on, too many photos are told how many to remove', () => {
  const offer = fn('offer')
  assert.match(offer, /\? shrinkCopy\.NO_FIT_AUTO\(lower\.fits \? left\.photos : lower\.count, left\.photos\)\n\s+: shrinkCopy\.NO_FIT\(plan\.count, left\.photos, lower\.fits \? left\.photos : lower\.count\)/)
  // With a video still to be made among them, which kind to remove (a video bends furthest, so
  // there's no count); beside one already made smaller, only the photos are counted.
  assert.match(offer, /if \(left\.videos \|\| left\.docs \|\| left\.audio\) return \{ kind: 'no-fit', says: \[shrinkCopy\.NO_FIT_VIDEO\(left\)\] \}/)
})

test('“Smallest”: each claims only what it makes it, whatever the room, unless that would hardly save anything', () => {
  const s = fn('shares')
  assert.match(s, /const smallest = settings\(\)\.shrink === 'smallest'\n\s+if \(smallest\) lower = true\n\s+const \{ smallestPhotos \} = settings\(\)\n\s+const videoStep = step \?\? levelSteps\(settings\(\)\.smallestVideos\)\[0\]/)
  // Its least, or a photo at the level chosen in Settings → Advanced, or a video at the
  // step planned (planCopies); a photo above its least with the leeway its copy may use, so it fits what's planned (the
  // review, 2026-10-27).
  assert.match(s, /const aim = row\.video\n\s+\? Math\.min\(share\.full, overheads\[i\] \+ leastBytes\(row\.video, videoStep\)\)\n\s+: m\n\s+\? Math\.min\(share\.full, overheads\[i\] \+ \(smallestPhotos === 'least' \? m\.lowest : Math\.ceil\(levelBytes\(m, smallestPhotos\) \* SMALLEST_LEEWAY\)\)\)\n\s+: share\.least/)
  // As it is when that would hardly save anything (smallestShare, tested in smallest-levels.test.ts).
  assert.match(s, /const made = smallestShare\(share, full, aim, SMALLEST_SAVES\)\n\s+asIs\[i\] = made\.asIs/)
  // A video claims its step's size; the room nobody claims is its ceiling (giveRoom), as before the levels.
  assert.match(s, /if \(row\.video && !made\.asIs\) ceilings\[i\] = share\.full\n\s+return made\.share/)
  assert.match(fn('planAt'), /const sizes = giveRoom\(space, plan\.sizes, ceilings\)\n\s+return \{ fits: true, targets: sizes\.map/)
  assert.doesNotMatch(tray, /SOUND_SPARE/)
  assert.match(tray, /const SMALLEST_SAVES = 0\.05/)
  assert.match(fn('makeVideo'), /stop\.signal,\n\s+\/\/ [^\n]*\n\s+steps,\n\s+\)/)
  assert.match(read('../src/video/shrink.ts'), /const at = o\.steps\.findIndex\(\(step\) => leastTarget\(video, seconds, report\.source\.fps, bytes, fps, step\) <= target\)/)
  // The lowest quality from the start, Brotli not waited for, and a copy made at its level is done.
  const run = fn('makeSmallerCopies')
  // A photo's copy may come out a little over what it measured at its least (the review, 2026-10-26); a level above
  // has the leeway in its claim.
  assert.match(tray, /const SMALLEST_LEEWAY = 1\.02/)
  assert.match(run, /const aimFor = \(row: Row\) => \(smallest \? Math\.max\(target\(row\)!, Math\.ceil\(row\.measured!\.lowest \* SMALLEST_LEEWAY\)\) : target\(row\)!\)/)
  assert.match(run, /copy \?\?= await makeCopy\(row\.data!, row\.photo!, row\.measured!, aimFor\(row\), lower, \(done\) => \{/)
  // "Good" needs each photo's top size: measured then, and only then.
  assert.match(run, /if \(!toMeasure\(row\) \|\| !rows\.includes\(row\)\) continue\n\s+row\.pmaking = 0\n\s+updateRow\(row\)\n\s+try \{\n\s+row\.measured = await measure\(row\.data!, row\.photo!, \{\n\s+top: wantTop\(\),/)
  assert.match(tray, /const wantTop = \(\) => settings\(\)\.shrink === 'smallest' && settings\(\)\.smallestPhotos === 'good'/)
  // Something still being packed (as when a change of choice puts files back): planned again once it's done.
  assert.match(run, /if \(c\.pending \|\| c\.asking\) \{\n\s+lastPhotos = lastAuto = undefined\n\s+return\n\s+\}/)
  assert.match(run, /let lower = lowerAsked \|\| smallest/)
  assert.match(run, /!!row\.copy &&\n\s+\(smallest \? atLevel\(row\.copy, row\.measured!\.dims, level\) : row\.copy\.quality === Q_MAX/)
  // Files lined up and then left as they are get their stronger compression back.
  assert.match(run, /for \(const row of rows\) if \(!inCopy\(row\)\) track\(squeezeRow\(row\)\)/)
})

test('“Smallest”: a run whenever files come or go, fitting or not, and a line owning up to it with a greyed way to “To fit”', () => {
  const offer = fn('offer')
  // And again when their space changes after a run that couldn't fit them (a long message cut: the review, 2026-10-26).
  assert.match(offer, /if \(smallest && settled && items\.length && \(photoSet\(items\) !== lastPhotos \|\| \(unfit && situation\(c, items\) !== lastAuto\)\)\) \{/)
  assert.match(fn('makeSmallerCopies'), /unfit = !plan\.fits\n/)
  assert.match(offer, /if \(smallest\) \{\n\s+\/\/ [^\n]*\n\s+const least = [^\n]*\n\s+return \{ kind: 'made', look: 'room', says: \[`\$\{shrinkCopy\.SMALLEST\(made, all, least\)\} `, FIT_LINK\] \}/)
  assert.match(tray, /className: 'soft-link quiet', textContent: shrinkCopy\.SMALLEST_FIT/)
  assert.match(tray, /fitLink\.addEventListener\('click', \(\) => o\.openSetting\('s-shrink'\)\)/)
  assert.match(read('../src/style.css'), /\.soft-link\.quiet \{\n\s+color: var\(--muted\);/)
  // Each file's bar leaves room for it until a run has settled it.
  assert.match(fn('mayShrink'), /if \(settings\(\)\.shrink === 'smallest'\) return first \|\| !planned\(row\)/)
})

test('choosing “Ask first” puts every photo back at full size, and the box asks instead', () => {
  // From "Ask first" to "To fit", copies already asked for stay; any other change makes them all again for it.
  assert.match(tray, /if \(s\.shrink === 'fit' && was === 'ask'\) o\.changed\(\)\n[^\n]*\n\s+else track\(fullSize\(s\.shrink !== 'ask'\)\)/)
  // One sent at full size by choice stays so, unless it's "Ask first", where nothing is made smaller unasked.
  assert.match(fn('fullSize'), /if \(keepChoices && row\.useFull\) continue\n\s+row\.useFull = false/)
  // Every copy cleared before any is packed again, so no run plans for some still made smaller (the review, 2026-10-26).
  assert.match(fn('fullSize'), /back\.push\(row\)\n\s+\}\n\s+\/\/ [^\n]*\n\s+await Promise\.all\(back\.map\(repack\)\)/)
  const full = fn('fullSize')
  assert.match(full, /copiesChosen = false/)
  assert.match(full, /lastPhotos = lastAuto = undefined/)
  assert.match(full, /row\.copy = undefined/)
})

test('a file being made smaller says as far along as its bar, on its row and in the box', () => {
  // The bar's first quarter is reading and cleaning; the rest is the making smaller. Its row said 50% where the bar
  // stood at about 62%.
  assert.match(tray, /export const barAt = \(made: number\) => FIRST_PART \+ \(1 - FIRST_PART\) \* made/)
  for (const x of ['vmaking', 'dmaking', 'amaking', 'pmaking']) {
    assert.ok(tray.includes(`if (row.${x} !== undefined) return { stage: 'working', p: barAt(row.${x}) }`), x)
    assert.ok(tray.includes(`if (row.${x} !== undefined) return \`\${size(row.file.size)} · \${shrinkCopy.MAKING(barAt(row.${x}))}\``), x)
  }
  const working = fn('workingText')
  for (const [k, f] of [['video', 'WORKING_VIDEO'], ['doc', 'WORKING_DOC'], ['audio', 'WORKING_AUDIO']])
    assert.ok(working.includes(`shrinkCopy.${f}(barAt(s.${k}.done), s.${k}.index, s.${k}.count)`), k)
  assert.doesNotMatch(tray, /MAKING\(row\.[vda]making\)/)
})

test('photos move as they’re worked on, and say they’re waiting, not "full size", until then', () => {
  // Five photos sat at a quarter for seconds while each was measured: "it feels like it's doing nothing".
  assert.ok(tray.includes('pmaking?: number // 0 to 1 while a photo is measured and made smaller (kept between the two)'))
  assert.ok(tray.includes('if (row.aqueued || row.pqueued) return `${size(row.file.size)} · ${shrinkCopy.QUEUED}`'))
  const run = fn('makeSmallerCopies')
  // Measuring moves its bar; with "Smallest" that's nearly all of it, as its copy is made then too.
  assert.match(run, /const keep = smallest \? settings\(\)\.smallestPhotos : undefined\n\s+const measuring = keep \? 0\.9 : 0\.4/)
  assert.match(run, /row\.measured = await measure\(row\.data!, row\.photo!, \{\n\s+top: wantTop\(\),\n\s+keep,\n\s+progress: \(done\) => \{/)
  assert.match(run, /row\.pmaking = Math\.max\(row\.pmaking, done \* measuring\)/)
  // Making it goes on from there; the copy kept while measuring is used when it's still the level.
  assert.match(run, /const from = row\.pmaking \?\? 0/)
  assert.match(run, /copy = smallest \? keptCopy\(row\.measured!, level, aimFor\(row\)\) : undefined\n\s+copy \?\?= await makeCopy\(/)
  assert.match(run, /row\.pmaking = Math\.max\(row\.pmaking, from \+ \(1 - from\) \* done\)/)
  assert.match(run, /row\.measured!\.kept = undefined/)
  // Not left part way: one that needs no copy, or a run that ends or stops.
  assert.match(run, /row\.pqueued = false \/\/ fits as it is, or its copy already does\n\s+row\.pmaking = undefined/)
  assert.match(fn('unqueue'), /row\.pmaking = undefined/)
})

test('anything going as it is that’s too big to send even alone is red and says so', () => {
  // A photo at full size with "Ask first" (or "Send full size instead"), a file Slynk can't make smaller: green "full size" looked fine.
  const too = fn('tooBigAsIs')
  assert.match(too, /if \(!s \|\| inCopy\(row\) \|\| row\.squeezing \|\| asking\(row\)\) return false/)
  // On the screen, not while its bar still leaves room for it being made smaller.
  assert.match(tray, /const goesTooBig = \(row: Row\) => prep\.tooBigAsIs\(row\) && !mayShrink\(row\)/)
  assert.match(too, /const length = row\.parent \? \(packedLength\(s\.data\) \?\? s\.data\.length\) : s\.stored\.body\.length/)
  assert.match(too, /return wireAs\(row, sentName\(row\), sentType\(row\), length\) > o\.limit\(\)/)
  // Red only once nothing's left to do for it: after the steps that are still working on it.
  assert.match(fn('stageOf'), /if \(first < 1\) return \{ stage: 'working', p: FIRST_PART \}\n\s+if \(goesTooBig\(row\)\) return \{ stage: 'blocked', p: 1 \}\n\s+return \{ stage: 'ready', p: 1 \}/)
  assert.ok(fn('rowSize').includes('if (goesTooBig(row)) return `${size(row.file.size)} · ${shrinkCopy.TOO_LARGE}`'))
  // Its text follows its colour, which the offer redraws by itself; and once Brotli is done, whether or not it helped.
  assert.match(fn('paintStage'), /part\(row\.li, 'size'\)\.textContent = rowSize\(row\)/)
  assert.match(fn('paintStage'), /part\(row\.parent\.li, 'size'\)\.textContent = rowSize\(row\.parent\)/)
  assert.match(fn('squeezeRow'), /if \(rows\.includes\(row\)\) updateRow\(row\)\n\s+return/)
})

test('too many to fit even at their smallest: the photos are made smallest all the same, so they’re ready once some go', () => {
  // They all stayed "full size" and Slynk "didn't even try".
  const run = fn('makeSmallerCopies')
  assert.match(run, /const anyway = !plan\.fits && settings\(\)\.shrink !== 'ask'\n\s+if \(!plan\.fits && !anyway\) return\n\s+if \(anyway\) lower = true\n\s+const targets = plan\.fits \? plan\.targets : leastTargets\(c, shared\)/)
  // What was made already stays (null is only "not made now"), and videos, documents and audio wait until what's left fits.
  assert.match(run, /if \(!anyway && target\(row\) === null && \(row\.copy \|\| row\.vcopy \|\| row\.dcopy \|\| row\.acopy\)\) \{/)
  assert.ok(run.indexOf('if (anyway) return') > run.indexOf('for (const row of todo) {'))
  assert.ok(run.indexOf('if (anyway) return') < run.indexOf('const docsToMake'))
  // Photos only, at the smallest the setting allows; "Smallest" goes by its own "as it is", "To fit" with leeway.
  const least = fn('leastTargets')
  assert.match(least, /const \{ list, overheads, asIs \} = shares\(c, items, true\)/)
  assert.match(least, /if \(!isPhoto\(row\) \|\| !row\.measured \|\| \(smallest \? asIs\[i\] : list\[i\]\.least >= list\[i\]\.full\)\) return null/)
  assert.match(least, /return smallest \? least : Math\.ceil\(least \* SMALLEST_LEEWAY\)/)
})

test('a file Slynk can’t make smaller, too big even alone, is named in the box', async () => {
  // It said the photos didn't fit, when nothing could make room for this file.
  const offer = fn('offer')
  assert.match(offer, /const stuck = rows\.filter\(\(r\) => !r\.parent && tooBigAlone\(c, r\)\)/)
  // A zip only when it'd still be too big without the files in it that can be made smaller: "To fit" named a zip of
  // photos, beside another file, and made nothing smaller (2026-10-31).
  const alone = fn('tooBigAlone')
  assert.match(alone, /if \(row\.state === 'too-big'\) return true\n\s+if \(!tooBigAsIs\(row\) \|\| shareable\(row\)\) return false/)
  assert.match(alone, /const rest = members\.reduce\(\(n, m\) => n \+ \(shareable\(m\) \? 0 : \(c\.rowWire\.get\(m\) \?\? 0\)\), c\.rowWire\.get\(row\) \?\? 0\)/)
  assert.match(alone, /return !members\.some\(shareable\) \|\| rest > o\.limit\(\)/)
  assert.match(offer, /if \(over && stuck\.length && rows\.some\(\(r\) => !r\.parent && !stuck\.includes\(r\)\)\) \{\n\s+return \{ kind: 'alone', says: \[shrinkCopy\.TOO_LARGE_ALONE\(sentName\(stuck\[0\]\), stuck\.length\)\], names: stuck \}/)
  // After "Smallest" has made the photos smaller, before the box would say they don't fit.
  assert.ok(offer.indexOf('const stuck') > offer.indexOf('if (smallest && settled'))
  assert.ok(offer.indexOf('const stuck') < offer.indexOf("if (!items.length || !over || !settled) return { kind: 'hidden'"))
  const copy = await import('../src/shrinkCopy.ts')
  assert.equal(copy.TOO_LARGE_ALONE('data.bin', 1), 'data.bin is too large to send, even on its own. Remove it to send the rest.')
  assert.equal(copy.TOO_LARGE_ALONE('data.bin', 2), '2 files are too large to send, even on their own. Remove them to send the rest.')
})

test('“Smallest”: before each video is made, the room those made before it left is planned again for those still to make (2026-10-31)', () => {
  // Planned once, the first video's ceiling took the room nobody claimed, and it came out at its level well under
  // that; a 5-second clip last in the list, given only its claim, came out a step below its level (180p for 240p).
  const run = fn('makeSmallerCopies')
  // At the step the run planned, so they all go at the same one.
  assert.match(run, /const videoTarget = \(row: Row, left: Row\[\]\) => \{\n\s+const again = smallest \? planCopies\(o\.compose\(\), left, true, plan\.steps!\.slice\(0, 1\)\) : undefined\n\s+return Math\.max\(target\(row\)!, \(again\?\.fits && again\.targets\[0\]\) \|\| 0\)\n\s+\}/)
  // Those still to make, this one first (its target is the first), with the sizes made so far in compose(); each
  // given the steps from the one planned, to go on down should its sound take more than counted.
  assert.match(run, /await makeVideo\(row, videoTarget\(row, videos\.slice\(i\)\.filter\(\(r\) => rows\.includes\(r\)\)\), plan\.steps, i \+ 1, videos\.length, live\)/)
  assert.ok(run.indexOf('if (!rows.includes(row)) continue\n        await makeVideo(row, videoTarget(') > 0, 'only once it’s known to be on the list')
  // A video made smaller is packed before the next is planned, so it's counted at its size.
  assert.match(fn('makeVideo'), /if \(rows\.includes\(row\)\) await repack\(row\)$/)
  // The example runs this same code (file-prep.test.ts checks it plans nothing of its own).
})

test('a file that can’t go blocks Send, whatever the meter shows (2026-10-31)', () => {
  // A small file added once 100 MB had been read (then made small) was "too large to send" on its row,
  // but counted only as its own size: Send stayed on, and it would have been left out without a word.
  assert.match(tray, /const budget = READ_BUDGET - rows\.reduce\(\(n, r\) => n \+ \(r !== row && r\.read && r\.state !== 'too-big' \? r\.file\.size : 0\), 0\)/)
  assert.match(fn('compose'), /if \(row\.state === 'too-big'\) extra \+= row\.file\.size/)
  assert.match(fn('blocker'), /if \(c\.wire > o\.limit\(\) \|\| c\.raw > MAX_DECODED \|\| rows\.some\(cantGo\)\) return 'Too large to send'/)
  // Too big to read, or too big to go as it is and not made smaller (yet): neither is packed.
  assert.match(tray, /const cantGo = \(row: Row\) => row\.state === 'too-big' \|\| \(row\.state === 'video' && !row\.sending\)/)
  // One in a zip too: the zip waits for it ('video'), and it's 'too-big' itself.
  assert.match(fn('packZip'), /const big = \(m: Row\) => !m\.sending && \(m\.state === 'video' \|\| m\.state === 'too-big'\)/)
  // Both hosts ask the tray before sending.
  assert.match(read('../src/main.ts'), /const files = tray\.blocker\(c\) \/\/ too many, being made smaller, or too large/)
  assert.match(read('../src/inbox/owner.ts'), /tray\.blocker\(c\) \|\| tray\.waiting\(c\)/)
})

test('a photo’s copy at its "Smallest" level is kept from measuring it: decoded once, not twice (about 4 times quicker)', () => {
  const draw = read('../src/shrink/draw.ts')
  // The same drawing at the level's quality: least is the lowest, medium the floor's, good the top size.
  assert.match(draw, /o\.keep === 'good' \? \{ \.\.\.atTop!\.saved, dims: fitDims\(base, atTop!\.top\.edge\), quality: atTop!\.top\.quality \} : \{ \.\.\.\(o\.keep === 'medium' \? atFloor : atLowest\), dims: floor, quality: o\.keep === 'medium' \? Q_FLOOR : Q_LOWEST \}/)
  assert.match(draw, /const copy = \{ \.\.\.at, quality: png \? 1 : at\.quality \}/)
  // Kept only if it opens, as makeCopy's copies must.
  assert.match(draw, /if \(await checkDecodes\(copy\.data, copy\.dims\)\.then\(\(\) => true, \(\) => false\)\) m\.kept = \{ \.\.\.copy, level: o\.keep \}/)
  // Used only at its own level, and only if it's no bigger than the copy may be.
  assert.match(draw, /if \(!k \|\| k\.level !== level \|\| k\.data\.length > target\) return undefined/)
  // "Good" measures the top size whenever it's kept.
  assert.match(draw, /const top = o\.top \|\| o\.keep === 'good'/)
})

test('a row’s progress fits one line on a phone, whatever its size and percentage', async () => {
  const copy = await import('../src/shrinkCopy.ts')
  assert.equal(copy.MAKING(0.62), 'shrinking… 62%')
  assert.equal(copy.MAKING(1), 'shrinking… 99%', 'never 100% before it’s done')
  assert.equal(copy.QUEUED, 'waiting to shrink')
  // "15.53 MB · making it smaller… 99%" took 211 pixels of a 375-pixel phone row's 191; these take about 165.
  for (const t of [copy.MAKING(0.99), copy.QUEUED]) assert.ok(`15.53 MB · ${t}`.length <= 28, t)
  // While it's cleaned, too: "removing hidden details…" took two lines.
  assert.ok(tray.includes("if (row.state === 'cleaning') return `${size(row.file.size)} · cleaning…`"))
  assert.doesNotMatch(tray, /· removing hidden details…/)
})
