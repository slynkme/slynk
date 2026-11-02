// "Plain file names" (off by default): a name that gives away a date or a
// device goes as photo.jpg and the like, by itself, instead of through a
// Rename button on each file (fewer buttons on a
// phone). And "Send full size instead" sits right under the copy's size.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const tray = read('../src/tray.ts') + read('../src/prep/list.ts') // the screen, and the file list it draws
const html = read('../index.html')
const about = read('../about/index.html').replace(/\s+/g, ' ')

test('off by default, with a switch in Settings', () => {
  assert.match(read('../src/ui/settings.ts'), /\n  plainNames: false,\n/)
  assert.match(html, /<strong>Plain file names<\/strong><span>Sends names cameras and apps make, like IMG_20261017_142233\.jpg, as photo\.jpg\.<\/span>/)
  assert.match(read('../src/main.ts'), /\$\('s-plain'\)\.addEventListener\('change'/)
})

test('a file goes under its plain name only with the setting on, and nothing renames it by hand', () => {
  assert.match(tray, /const baseName = \(row: Row\) => \(settings\(\)\.plainNames && row\.suggested \? row\.suggested : row\.name\)/)
  // A document made smaller keeps its own name.
  assert.match(tray, /const sentName = \(row: Row\) => \(inCopy\(row\) && !row\.dcopy \? copyName\(baseName\(row\), sentType\(row\)\) : baseName\(row\)\)/)
  assert.doesNotMatch(tray, /'rename'/)
  assert.doesNotMatch(html, /data-part="rename"/)
  // Turning it on or off redraws the names; compose() packs each name as it goes.
  assert.match(tray, /if \(s\.plainNames !== plainWereOn\) \{\n\s+plainWereOn = s\.plainNames\n\s+rows\.forEach\(updateRow\)/)
})

test('"Send full size instead" comes straight after the copy’s size, before Cleaned', () => {
  const row = html.slice(html.indexOf('<template id="tpl-file">'), html.indexOf('</template>', html.indexOf('<template id="tpl-file">')))
  const copy = row.indexOf('data-part="copy"')
  const full = row.indexOf('data-part="full"')
  const cleaned = row.indexOf('data-part="cleaned"')
  assert.ok(copy < full && full < cleaned)
})

test('the About page points to the setting', () => {
  assert.match(about, /If a file’s name gives away when or on what it was made, turn on “Plain file names” in Settings\./)
  assert.match(about, /If a file’s name gives away a date or a device, “Plain file names” in Settings sends it under a plain one, like photo\.jpg\./)
  assert.doesNotMatch(about, /Rename button/)
})

test('"Send full size instead" isn’t offered when the photo at full size couldn’t go even on its own, unless it’s ticked', () => {
  assert.match(tray, /full\.hidden = !\(row\.copy \|\| row\.vcopy \|\| row\.dcopy \|\| row\.acopy\) \|\| \(!row\.useFull && fullTooBig\(row\)\)/)
  assert.match(tray, /return !!full && wireAs\(row, baseName\(row\), row\.file\.type, full\.data\.length\) > o\.limit\(\)/)
})
