// Pre-compresses the WebAssembly core after `vite build`. The web host serves
// .wasm uncompressed (about 40 MB), so the site ships brotli and gzip copies,
// and .htaccess hands each browser the best one it accepts.
//
//   node scripts/precompress.mjs              add .br and .gz next to each .wasm
//   node scripts/precompress.mjs --drop-raw   ...and delete the raw .wasm
//                                             (for publishing; every browser
//                                             that runs WebAssembly accepts gzip)
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

const dir = fileURLToPath(new URL('../dist/assets/', import.meta.url))
const dropRaw = process.argv.includes('--drop-raw')
const mb = (n) => (n / 1048576).toFixed(1) + ' MB'

for (const name of readdirSync(dir).filter((n) => n.endsWith('.wasm'))) {
  const path = join(dir, name)
  const raw = readFileSync(path)
  const br = brotliCompressSync(raw, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
  })
  const gz = gzipSync(raw, { level: 9 })
  // The gzip header names the system that made it (byte 9): 3, Unix, as CI's
  // Linux writes, wherever it's built, so a rebuild on a Mac or Windows
  // matches the published fingerprints (scripts/fingerprints.ts).
  gz[9] = 3
  writeFileSync(path + '.br', br)
  writeFileSync(path + '.gz', gz)
  if (dropRaw) rmSync(path)
  console.log(`${name}: ${mb(raw.length)} raw -> ${mb(br.length)} brotli, ${mb(gz.length)} gzip${dropRaw ? ' (raw dropped)' : ''}`)
}
