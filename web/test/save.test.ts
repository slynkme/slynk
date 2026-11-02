// Saving files (src/ui/save.ts): on iPhones and iPads, videos and sound go as
// plain files, so Safari doesn't offer its "View", which can't play them here.
// Run from the repo root: npm --prefix web test
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainForSafari } from '../src/ui/save.ts'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1'
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36'

test('videos and sound go as plain files on iPhones and iPads', () => {
  for (const type of ['video/mp4', 'video/quicktime', 'audio/mp4', 'audio/mpeg']) {
    assert.equal(plainForSafari(type, IPHONE, 5), true, `${type} on an iPhone`)
    assert.equal(plainForSafari(type, IPAD, 5), true, `${type} on an iPad, which says it's a Mac`)
  }
})

test('everything else keeps its type', () => {
  for (const type of ['image/jpeg', 'image/svg+xml', 'application/pdf', 'text/plain', 'application/zip', ''])
    assert.equal(plainForSafari(type, IPHONE, 5), false, `${type || 'no type'} on an iPhone`)
  // A Mac (no touch screen) and Android save videos as they are.
  assert.equal(plainForSafari('video/mp4', IPAD, 0), false)
  assert.equal(plainForSafari('video/mp4', ANDROID, 5), false)
})
