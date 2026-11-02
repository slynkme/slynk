# Preparing files: an example

A small page and one function, `prepareFiles` in [prepare.ts](prepare.ts), that do with a list of
files what Slynk does when they're added to it at once, with Slynk's own code: each file is cleaned
of hidden details, made smaller (photos, videos, audio, the pictures inside PDFs and Office files,
and the files inside a zip) and compressed, all in the browser, then counted as Slynk counts what it
sends, ready for a mixnet transfer of your own. It runs Slynk's own engine: the file list
that Slynk's composer runs on slynk.me ([web/src/prep/list.ts](../../src/prep/list.ts)), so
it does what Slynk does, and there's no copy of Slynk's planning here to fall behind. It's given
as is, under the repo's BSD 2-Clause licence: copy it and change it. The write-up, [Preparing files for the mixnet](../../../docs/findings/preparing-files.md), explains
what it does, which folders to copy and what it can't do.

## Run it

```bash
cd web && npm install && npm run build:core && npm run dev
```

Then open <http://localhost:5173/examples/file-prep/>. `npm run build:core` builds Slynk's
WebAssembly helper, and needs Go. Without Go, leave it out (`cd web && npm install && npm run
dev`): the page still runs, Brotli is skipped and files are deflated instead. The page is served only by the development server: it isn't part of Slynk's build,
and nothing in it sends anything anywhere.

## Use it

```ts
import { prepareFiles } from './prepare.ts'

const prepared = await prepareFiles(files, { budget: 250_000, shrink: 'fit', onProgress, signal })
if (prepared.fits) for (const f of prepared.files) if (f.data) send(f.name, f.type, f.compressed)
```

With no options it does what Slynk does by default. Each file comes back with its name and
type (a photo made smaller becomes a JPEG, or a WebP or PNG if it has see-through parts;
a video an MP4; audio an M4A), its original
size, the prepared bytes (`data`, which open as they are), the compressed form to send
(`compressed`, with its method) and what it takes of the budget, what cleaning removed with the
values it held, how it was made smaller, any problems in Slynk's own words, and for a zip, its
files (`inside`). A file left out (added twice, or unreadable) comes back with `data: null`.
Together they come with their `total`, the `limit` they must fit in, whether they fit (`fits`), whether
a file is `waiting` for an answer, and what Slynk's box would say when they can't go (`says`).

`prepareFiles` suits an app that takes a set of files and sends them. An app that keeps a list
that changes as files come and go, showing each one's progress as Slynk's composer does, can use
the engine itself, `createFileList` in `web/src/prep/list.ts`: it calls the app back as each file
changes, and Slynk's composer ([web/src/tray.ts](../../src/tray.ts)) is the worked example.
`prepareFiles` is that engine with a list of its own and no screen.

| Option | Default | What it does |
|---|---|---|
| `budget` | `2_000_000` | What the upload may weigh: Slynk's limit (`MAX_PAYLOAD`). Stock xxDK's file transfer takes 250,000. |
| `framing` | `'slynk'` | `'slynk'`: counted as Slynk sends them, inside its envelope (each file's name, type and size) and a one-time link's seal (28 bytes), with 45 more kept for a password, as Slynk keeps them. `'none'`: their compressed bytes alone, for an app with framing of its own. |
| `clean` | `true` | Remove hidden details (Slynk's "Remove hidden details from files"). PDFs too. |
| `shrink` | `'smallest'` | `'smallest'`: every photo, video, audio file and document as small as its level makes it. `'fit'`: made smaller only when they don't fit, sharing the budget out. `'off'`: full size (Slynk's "Ask first", without the asking). |
| `photoLevel` | `'least'` | What `'smallest'` makes photos: `'least'` (1,280 px at 40%), `'medium'` (1,280 px at 70%), `'good'` (up to 2,048 px at 85%). A smaller photo keeps its own size. |
| `videoLevel` | `240` | What `'smallest'` makes videos: `180`, `240` or `360` (lines). When they don't all fit that way, they step down together until they do: each size at 30 frames a second, then 15, then the size below, as far as 180p at 15. |
| `compression` | `'brotli'` | `'brotli'` (deflate where the helper isn't built), `'deflate'` or `'none'`. |
| `plainNames` | `false` | Neutral names for files whose names give something away (`IMG_20240612_183045.jpg` → `photo.jpg`). |
| `perFile` | none | `(file, index) => ({ clean?, shrink?, sendAsIs? })`: one file's own choice, as Slynk's "Send original instead" (`clean: false`) and "Send full size instead" (`shrink: false`, as if ticked before anything was made smaller); `sendAsIs: true` sends a file that couldn't be cleaned as it is (for a zip, the files in it too). `clean: false` alone doesn't: Slynk asks either way. Choices go to whole files: a zip's files take none of their own, where Slynk gives each its own. |
| `onProgress` | none | `({ index, count, name, stage, done })`, `done` from 0 to 1 (through measuring and shrinking together) or `null`. |
| `signal` | none | An `AbortSignal`: the promise then rejects with an `AbortError` at once, and the work stops. What can't be stopped part-way (a photo being drawn, audio being decoded on the page, the file being cleaned) finishes in the background and is thrown away. |

As in Slynk, a file that couldn't be cleaned waits for an answer: nothing is made smaller and
`fits` is false until `perFile` gives it `sendAsIs` (or it's left out). A file added twice goes
once, and one that can't be read is left out, each with a problem that says so. A file too big to
read stops anything being made smaller, and with `'fit'`, so does one that can't be made smaller and
is too big to go even on its own beside others; the problems say which, and `says` gives what
Slynk's box would say. A zip's files are compressed inside it as Slynk does, whatever `compression`
says, and their names in `inside` are before the zip makes repeated ones unique. A zip with
`compressed.unpacked` went unpacked and squeezed whole: un-Brotli it, then pack it again with
`repackZip` from `web/src/zipInside.ts`, as Slynk's recipient does.

It does what Slynk's composer does with the same files added at once, and waits until there's
nothing left that it would do by itself: as in Slynk, with `'fit'` it gives Brotli 10 to 20
seconds before planning, and with `'smallest'` it doesn't wait, counting what Brotli hasn't
finished at its deflated size. Those seconds count from when each file is handed to Brotli, and
lists in the same tab (two calls at once, say) share one Brotli worker, so one's files can wait
behind the other's and get less of that time. What a sender does later (taking a file out, or
changing a choice after a run) is for `createFileList`.

It reads no settings and stores nothing.
