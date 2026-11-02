// Makes the downloads' icons from Slynk's logo (web/public/favicon.svg), for
// the programs to carry (no Terminal window, and
// Slynk's own icon):
//   - ../slynk.icns, the Mac app's (Slynk.app/Contents/Resources), with room
//     around the logo as macOS icons have;
//   - ../rsrc_windows_amd64.syso, which the Go linker puts into slynk.exe: its
//     icon, and its name ("Slynk") for Explorer and Task Manager. No company
//     or copyright line: Slynk has none to give.
// Both are committed, so building the programs needs neither this nor Node.
// Run again only when the logo changes, from the repository's root:
//   node lab/run-locally/icons/icons.mjs
// It uses @napi-rs/canvas, which web/ already installs (pdfjs-dist's optional
// helper); nothing here is part of the website.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..', '..')
const { createCanvas, Image } = createRequire(join(root, 'web', 'package.json'))('@napi-rs/canvas')

const logo = new Image()
logo.src = readFileSync(join(root, 'web', 'public', 'favicon.svg'))

/** The logo drawn at size px, inset by pad px on every side; RGBA canvas. */
function draw(size, pad = 0) {
  const c = createCanvas(size, size)
  const g = c.getContext('2d')
  if (pad > 0) {
    // macOS icons float a little above the Dock: a soft shadow under the square.
    g.shadowColor = 'rgba(0, 0, 0, 0.3)'
    g.shadowBlur = size * 0.024
    g.shadowOffsetY = size * 0.01
  }
  g.drawImage(logo, pad, pad, size - 2 * pad, size - 2 * pad)
  return c
}

const png = (c) => c.toBuffer('image/png')

// --- Mac: an .icns of PNGs -------------------------------------------------------

/** Apple's grid: the icon's square is 824 of 1024, centred. */
const macPad = (size) => Math.round((size * 100) / 1024)

function icns() {
  const kinds = [
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024],
    ['ic11', 32],
    ['ic12', 64],
    ['ic13', 256],
    ['ic14', 512],
  ]
  const parts = kinds.map(([kind, size]) => {
    const data = png(draw(size, macPad(size)))
    const head = Buffer.alloc(8)
    head.write(kind, 0, 'latin1')
    head.writeUInt32BE(8 + data.length, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'latin1')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

// --- Windows: icon and version resources in a COFF object --------------------------

/** An icon image: PNG for 256 px, a 32-bit bitmap (with its empty mask) below. */
function iconImage(size) {
  const c = draw(size)
  if (size >= 256) return png(c)
  const rgba = c.getContext('2d').getImageData(0, 0, size, size).data
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0) // biSize
  header.writeInt32LE(size, 4) // biWidth
  header.writeInt32LE(size * 2, 8) // biHeight: the picture and its mask
  header.writeUInt16LE(1, 12) // biPlanes
  header.writeUInt16LE(32, 14) // biBitCount
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4 // bottom row first
      const to = (y * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)])
}

const utf16 = (s) => Buffer.from(s + '\0', 'utf16le')
const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b)

/**
 * One block of a version resource: its header, key, value and children, each
 * on a 4-byte boundary. Its length leaves out the padding after it, as
 * Windows expects.
 */
function block(key, value, { text = false, children = [] } = {}) {
  const keyed = pad4(Buffer.concat([Buffer.alloc(6), utf16(key)]))
  let whole = value ? Buffer.concat([keyed, value]) : keyed
  if (children.length) whole = Buffer.concat([pad4(whole), ...children.map((c, i) => (i < children.length - 1 ? pad4(c) : c))])
  whole.writeUInt16LE(whole.length, 0) // wLength
  whole.writeUInt16LE(value ? (text ? value.length / 2 : value.length) : 0, 2) // wValueLength: characters for text
  whole.writeUInt16LE(text ? 1 : 0, 4) // wType
  return whole
}

function versionInfo() {
  const fixed = Buffer.alloc(52)
  fixed.writeUInt32LE(0xfeef04bd, 0) // signature
  fixed.writeUInt32LE(0x00010000, 4) // structure version
  fixed.writeUInt32LE(0x00000001, 8) // file version 0.1
  fixed.writeUInt32LE(0x00000001, 16) // product version 0.1
  fixed.writeUInt32LE(0x3f, 24) // flags mask
  fixed.writeUInt32LE(0x00040004, 32) // for Windows NT
  fixed.writeUInt32LE(1, 36) // an application
  const strings = [
    ['FileDescription', 'Slynk'],
    ['ProductName', 'Slynk'],
    ['OriginalFilename', 'slynk.exe'],
    ['FileVersion', '0.1'],
    ['ProductVersion', '0.1'],
  ].map(([k, v]) => block(k, utf16(v), { text: true }))
  const table = block('040904B0', null, { text: true, children: strings }) // US English, Unicode
  const stringInfo = block('StringFileInfo', null, { text: true, children: [table] })
  const translation = Buffer.alloc(4)
  translation.writeUInt16LE(0x0409, 0)
  translation.writeUInt16LE(0x04b0, 2)
  const varInfo = block('VarFileInfo', null, { text: true, children: [block('Translation', translation)] })
  return block('VS_VERSION_INFO', fixed, { children: [stringInfo, varInfo] })
}

/**
 * The resources as a COFF object for amd64 (.syso), as Windows' own resource
 * compiler makes them: one .rsrc section holding the resource tree (type, then
 * id, then language), whose data entries the linker fixes to their final
 * addresses (IMAGE_REL_AMD64_ADDR32NB against the section's symbol).
 */
function syso() {
  const sizes = [16, 24, 32, 48, 64, 256]
  const images = sizes.map(iconImage)
  const group = Buffer.alloc(6 + 14 * sizes.length)
  group.writeUInt16LE(0, 0)
  group.writeUInt16LE(1, 2) // icons
  group.writeUInt16LE(sizes.length, 4)
  sizes.forEach((size, i) => {
    const at = 6 + 14 * i
    group[at] = size >= 256 ? 0 : size
    group[at + 1] = size >= 256 ? 0 : size
    group.writeUInt16LE(1, at + 4) // planes
    group.writeUInt16LE(32, at + 6) // bits per pixel
    group.writeUInt32LE(images[i].length, at + 8)
    group.writeUInt16LE(i + 1, at + 12) // its RT_ICON id
  })
  const english = 0x0409
  // type → [id, data], ids ascending
  const tree = [
    [3, images.map((data, i) => [i + 1, data])], // RT_ICON
    [14, [[1, group]]], // RT_GROUP_ICON
    [16, [[1, versionInfo()]]], // RT_VERSION
  ]
  const dirSize = (n) => 16 + 8 * n
  // Where everything goes: the root, each type's directory, each id's, then the data entries, then the data.
  let at = dirSize(tree.length)
  const typeAt = tree.map(([, ids]) => {
    const here = at
    at += dirSize(ids.length)
    return here
  })
  const idAt = tree.map(([, ids]) =>
    ids.map(() => {
      const here = at
      at += dirSize(1)
      return here
    }),
  )
  const entryAt = tree.map(([, ids]) =>
    ids.map(() => {
      const here = at
      at += 16
      return here
    }),
  )
  const dataAt = tree.map(([, ids]) =>
    ids.map(([, data]) => {
      at = Math.ceil(at / 8) * 8
      const here = at
      at += data.length
      return here
    }),
  )
  const section = Buffer.alloc(Math.ceil(at / 4) * 4)
  const dir = (offset, entries) => {
    section.writeUInt16LE(entries.length, offset + 14) // id entries
    entries.forEach(([id, to], i) => {
      section.writeUInt32LE(id, offset + 16 + 8 * i)
      section.writeUInt32LE(to >>> 0, offset + 20 + 8 * i)
    })
  }
  const sub = (offset) => (0x80000000 | offset) >>> 0
  const relocations = []
  dir(
    0,
    tree.map(([type], t) => [type, sub(typeAt[t])]),
  )
  tree.forEach(([, ids], t) => {
    dir(
      typeAt[t],
      ids.map(([id], i) => [id, sub(idAt[t][i])]),
    )
    ids.forEach(([, data], i) => {
      dir(idAt[t][i], [[english, entryAt[t][i]]])
      section.writeUInt32LE(dataAt[t][i], entryAt[t][i]) // fixed by the linker
      section.writeUInt32LE(data.length, entryAt[t][i] + 4)
      relocations.push(entryAt[t][i])
      data.copy(section, dataAt[t][i])
    })
  })
  const fileHeader = Buffer.alloc(20)
  const sectionHeader = Buffer.alloc(40)
  const relocs = Buffer.alloc(10 * relocations.length)
  const symbols = Buffer.alloc(18)
  const strings = Buffer.alloc(4)
  const rawAt = 20 + 40
  const relocAt = rawAt + section.length
  const symAt = relocAt + relocs.length
  fileHeader.writeUInt16LE(0x8664, 0) // amd64
  fileHeader.writeUInt16LE(1, 2) // one section
  fileHeader.writeUInt32LE(symAt, 8)
  fileHeader.writeUInt32LE(1, 12) // one symbol
  sectionHeader.write('.rsrc', 0, 'latin1')
  sectionHeader.writeUInt32LE(section.length, 16)
  sectionHeader.writeUInt32LE(rawAt, 20)
  sectionHeader.writeUInt32LE(relocAt, 24)
  sectionHeader.writeUInt16LE(relocations.length, 32)
  sectionHeader.writeUInt32LE(0x40000040, 36) // initialised data, readable
  relocations.forEach((offset, i) => {
    relocs.writeUInt32LE(offset, 10 * i)
    relocs.writeUInt32LE(0, 10 * i + 4) // the section's symbol
    relocs.writeUInt16LE(3, 10 * i + 8) // IMAGE_REL_AMD64_ADDR32NB
  })
  symbols.write('.rsrc', 0, 'latin1')
  symbols.writeInt16LE(1, 12) // in section 1
  symbols[16] = 3 // static
  strings.writeUInt32LE(4, 0)
  return Buffer.concat([fileHeader, sectionHeader, section, relocs, symbols, strings])
}

writeFileSync(join(here, '..', 'slynk.icns'), icns())
writeFileSync(join(here, '..', 'rsrc_windows_amd64.syso'), syso())
console.log('Wrote slynk.icns and rsrc_windows_amd64.syso')
