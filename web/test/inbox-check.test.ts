// "Check its address is correct": under the
// composer's Send, a popup where a sender pastes or scans the inbox's address
// from where its owner published it, and the page says whether it's the one
// they're writing to. The comparison is address.ts's; the popup is
// inbox/check.ts. Run: npm --prefix web test
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { INBOX_ADDRESS4_LENGTH, INBOX_ADDRESS4_VERSION, compactAddress, compareAddresses } from '../src/inbox/address.ts'
import * as copy from '../src/inbox/inboxCopy.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const html = read('../index.html')
const check = read('../src/inbox/check.ts')
const main = read('../src/main.ts')

/** A quantum-safe address as the core makes it, but for its keys. */
function address4(seed: number): Uint8Array {
  const a = Uint8Array.from({ length: INBOX_ADDRESS4_LENGTH }, (_, i) => (i * 131 + seed * 17) % 256)
  a[0] = INBOX_ADDRESS4_VERSION
  return a
}

describe('comparing two addresses', () => {
  test('the very same, the same inbox by its other address, or another inbox', () => {
    const qs = address4(1)
    const compact = compactAddress(qs)
    assert.equal(compareAddresses(qs, qs.slice()), 'same')
    assert.equal(compareAddresses(compact, compact.slice()), 'same')
    assert.equal(compareAddresses(qs, compact), 'same-inbox')
    assert.equal(compareAddresses(compact, qs), 'same-inbox')
    assert.equal(compareAddresses(qs, address4(2)), 'other')
    assert.equal(compareAddresses(compact, compactAddress(address4(2))), 'other')
    // A quantum-safe address with this inbox's key and someone else's ML-KEM key: the same inbox by the
    // bytes alone, which is why the popup has the core check its signature before saying so.
    const forged = qs.slice()
    forged[100] ^= 1
    assert.equal(compareAddresses(compact, forged), 'same-inbox')
    assert.equal(compareAddresses(qs, forged), 'same-inbox')
  })

  test('the popup says the same inbox only once the core takes a quantum-safe address', () => {
    assert.match(check, /const found = compareAddresses\(to, given\)\n {2}\/\/ [^\n]*\n {2}if \(found === 'same-inbox' && isQuantumSafe\(given\) && !\(await deps\.works\(given\)\)\) \{\n {4}if \(run === checks\) say\(copy\.ADDR_CHECK_BAD\)\n {4}return\n {2}\}/)
    assert.match(check, /if \(found === 'same'\) say\(copy\.ADDR_CHECK_SAME, true\)\n {2}else if \(found === 'same-inbox'\) say\(copy\.ADDR_CHECK_SAME_INBOX\(isQuantumSafe\(given\)\), true\)\n {2}else say\(copy\.ADDR_CHECK_OTHER\)/)
    assert.match(check, /if \(!given\) return say\(copy\.SEND_TO_BAD\(false\)\)/)
    // The core's own check of the address: the same one the composer uses.
    assert.match(main, /openCheck\(addressed\.address, \{\n {6}works: \(address\) =>\n {8}core\.inboxAddress\(address\)\.then\(\n {10}\(\) => true,\n {10}\(\) => false,\n {8}\),/)
    // A slow answer never speaks over a newer one, or after the popup has closed.
    assert.match(check, /const run = \+\+checks/)
    assert.match(check, /if \(run !== checks\) return/)
    assert.match(check, /d\.addEventListener\('close', \(\) => \{\n {4}writing = undefined\n {4}checks\+\+/)
  })
})

describe('the popup', () => {
  test('from "Check it." after the line asking them to check, in place of "Show its full address"', () => {
    assert.match(
      html,
      /<p class="note to-check" id="to-check"><span id="to-check-text" data-copy="TO_CHECK"><\/span><span id="to-check-it"> <button class="soft-link" id="to-check-go" type="button" aria-haspopup="dialog" data-copy="TO_CHECK_IT"><\/button><\/span><\/p>/,
    )
    assert.equal(copy.TO_CHECK_IT, 'Check it.')
    // Not when replying: that address came with their message.
    assert.match(main, /\$\('to-check-text'\)\.textContent = theirs \? inboxCopy\.TO_REPLYING : inboxCopy\.TO_CHECK\n[^\n]*\n {4}\$\('to-check-it'\)\.hidden = !!theirs/)
    // Nothing under Send but the safety note, under its light rule.
    assert.match(html, /<div id="to-after" hidden>\s*<!--[^>]*-->\s*<p class="note to-safety" data-copy="TO_HONEST_TIMING"><\/p>/)
    assert.match(read('../src/style.css'), /\.to-safety \{\n {2}margin: 12px 0 0;\n {2}padding-top: 12px;\n {2}border-top: 1px solid var\(--line\);/)
    assert.ok(!('TO_CHECK_ADDRESS' in copy))
    // The card itself no longer shows the address.
    for (const gone of ['id="to-address"', 'id="to-address-go"']) assert.ok(!html.includes(gone), gone)
    assert.ok(!/showAddress|'to-address'/.test(main))
  })

  test('paste or scan, Check, and what it found; the full address at the bottom, small and grey, with Copy', () => {
    const popup = html.slice(html.indexOf('<dialog id="addr-check"'), html.indexOf('</dialog>', html.indexOf('<dialog id="addr-check"')))
    assert.match(popup, /<h2 id="addr-check-title" tabindex="-1" autofocus data-copy="ADDR_CHECK_TITLE"><\/h2>/)
    assert.match(popup, /<p id="addr-check-lead" data-copy="ADDR_CHECK_LEAD"><\/p>/)
    // The camera inside the box's right edge, as in New message.
    assert.match(popup, /<span class="field-wrap">\s*<input id="addr-check-field"[^>]*data-copy-label="ADDR_CHECK_FIELD" aria-describedby="addr-check-lead" \/>\s*<button class="field-btn" id="addr-check-scan" type="button">/)
    assert.match(popup, /<button class="btn" id="addr-check-go" type="button" data-copy="ADDR_CHECK_GO"><\/button>/)
    assert.match(popup, /<p class="check-result" id="addr-check-result" role="status" hidden><\/p>/)
    assert.ok(popup.indexOf('addr-check-result') < popup.indexOf('addr-check-full-go'), 'the full address comes last')
    // Shown and hidden under a chevron, its words the same either way.
    assert.match(popup, /<p class="check-full-line"><button class="expander" id="addr-check-full-go" type="button" aria-expanded="false" aria-controls="addr-check-full" data-copy="TO_SHOW_ADDRESS"><\/button><\/p>\s*<div class="check-full" id="addr-check-full" hidden>\s*<code class="to-address" id="addr-check-text"><\/code>\s*<button class="btn small" id="addr-check-copy" type="button" data-copy="ADDR_CHECK_COPY"><\/button>/)
    assert.match(read('../src/style.css'), /\.check-full-line \{\n {2}margin: 16px 0 0;\n {2}color: var\(--muted\);\n {2}font-size: 0\.82rem;/)
    // A code read is checked at once, its link in the box; Enter checks; a new address clears the last answer.
    assert.match(check, /openScan\(\(address\) => \{\n {6}if \(!writing\) return\n {6}field\(\)\.value = inboxLink\(LINK_ORIGIN, address\)\n {6}void check\(\)/)
    assert.match(check, /if \(e\.key === 'Enter'\) \{\n {6}e\.preventDefault\(\)\n {6}void check\(\)/)
    assert.match(check, /field\(\)\.addEventListener\('input', \(\) => say\(''\)\)/)
    // Copied: said on the button, as a toast would sit behind the popup; or selected, to copy by hand.
    assert.match(check, /b\.textContent = copy\.ADDR_CHECK_COPIED/)
    assert.match(check, /getSelection\(\)\?\.selectAllChildren\(\$\('addr-check-text'\)\)/)
    // Opened afresh each time, for the address written to now.
    assert.match(check, /writing = address\.slice\(\)[\s\S]*field\(\)\.value = ''\n {2}say\(''\)\n {2}showFull\(false\)\n {2}\$\('addr-check-text'\)\.textContent = inboxLink\(LINK_ORIGIN, writing\)/)
  })

  test('the words: plain, never "we", and the one that warns says what to do', () => {
    const texts = [copy.ADDR_CHECK_TITLE, copy.ADDR_CHECK_LEAD, copy.ADDR_CHECK_SAME, copy.ADDR_CHECK_SAME_INBOX(true), copy.ADDR_CHECK_SAME_INBOX(false), copy.ADDR_CHECK_OTHER, copy.ADDR_CHECK_BAD, copy.TO_CHECK_IT]
    for (const t of texts) assert.ok(!/\b(we|us|our)\b/i.test(t), t)
    assert.match(copy.ADDR_CHECK_SAME, /^It matches/)
    assert.match(copy.ADDR_CHECK_SAME_INBOX(true), /same inbox: that’s its quantum-safe address, and you’re writing to its secure one/)
    assert.match(copy.ADDR_CHECK_SAME_INBOX(false), /same inbox: that’s its secure address, and you’re writing to its quantum-safe one/)
    assert.match(copy.ADDR_CHECK_OTHER, /^It doesn’t match: that’s a different inbox\. Make sure your link came from them before you write\.$/)
  })
})
