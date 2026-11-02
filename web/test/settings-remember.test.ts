// "Connect when the page opens" is forgotten on the next visit unless settings
// are remembered, so switching it on remembers them too, and says so; switching
// it off leaves remembering as it is.
// Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('switching on connecting at once remembers settings too, with a note; off leaves remembering on', () => {
  const main = read('../src/main.ts')
  assert.match(main, /const rememberToo = on && !settings\(\)\.remember\n\s+updateSettings\(\{ connectOnLoad: on, \.\.\.\(rememberToo \? \{ remember: true \} : \{\}\) \}\)/)
  assert.match(main, /\$\('s-connect-note'\)\.hidden = !rememberToo/)
  assert.match(main, /const CONNECT_REMEMBERS = 'Turned on “Remember these settings” too, so it connects next time\.'/)
  // Said once, when it happened: closed whenever Settings opens.
  assert.match(main, /\$\('s-connect-note'\)\.hidden = true \/\/ said once, when it happened/)
  assert.match(read('../index.html'), /<span class="setting-count" id="s-connect-note" role="status" hidden><\/span>/)
})
