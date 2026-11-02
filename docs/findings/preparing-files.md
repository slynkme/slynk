# Preparing files for the mixnet: Slynk's file pipeline, for your own app

*Slynk, 2026-10-31. All times UTC.*

Before Slynk uploads anything, the sender's browser cleans each file of hidden details,
makes photos, videos, audio and documents smaller, and compresses what's left. This piece
is for xx network developers who want the same in their own apps. It describes a small
example, [web/examples/file-prep/](../../web/examples/file-prep/), that uses Slynk's modules
as they are through one function, `prepareFiles`; what each step does; which folders to
copy and what they need; and what the example can't do.

## In short

- cMix payloads are small: stock xxDK's file transfer takes at most 250,000 bytes, Slynk's
  fork 2,000,000, and each part on the network carries about 923 bytes.
- `prepareFiles(files, options)` cleans, shrinks and compresses a list of files in the
  browser, and says whether they fit a budget. It runs Slynk's own file list
  ([web/src/prep/list.ts](../../web/src/prep/list.ts)), the code its composer runs on
  slynk.me, so for files added at once it gets the same result: the same files made
  smaller, to the same sizes, counted the same way. With no options it does what Slynk does by default.
- It isn't a side project: slynk.me runs every file through the same modules. Slynk adds
  its own file list, screens and transfer around them, and so would your app (section 2).
- It needs three npm packages (MIT, with pdf-lib's own few), Web Workers, a canvas, and
  WebCodecs for video and audio; Brotli needs Slynk's optional Go WebAssembly helper.
- It's given as is, under the BSD 2-Clause licence: no package, no support. Copy it and
  change it.

## 1. Why it matters on cMix

A file on cMix travels as many small messages. xxDK's channels file transfer splits it into
parts of about 923 bytes, and one client gets at most one batch of at most 11 parts into
each round ([upload-throughput-2026-10.md](upload-throughput-2026-10.md)). Stock xxDK v4.8.4
caps a file at 250,000 bytes (`fileMaxSize` in `channelsFileTransfer/manager.go`, and
`FileMaxSize` in `fileTransfer/manager.go`). Slynk's fork raises it to 2,000,000
([xxdk-changes.md](xxdk-changes.md), section 5.1), and a link filled to that limit took
4 min 4 s to send from a browser, measured on mainnet on 2026-10-15.

So every byte costs time, and a phone photo of 3 to 5 MB doesn't fit at all. Making files
smaller is what lets people send ordinary photos, recordings and documents. Cleaning
matters for the same people: a phone photo carries where it was taken, a document its
author and history.

## 2. Slynk is the worked example

`prepareFiles` isn't a side project: it's the middle of Slynk's own pipeline. Every file a
sender adds on slynk.me goes through the same modules, with the same defaults: the cleaner
([web/src/strip/](../../web/src/strip/)), the photo, video and audio shrinkers
([web/src/shrink/](../../web/src/shrink/), [web/src/video/](../../web/src/video/),
[web/src/audio/](../../web/src/audio/)), the document shrinkers
([web/src/docshrink/](../../web/src/docshrink/)) and compression
([web/src/payload.ts](../../web/src/payload.ts), [web/src/squeeze/](../../web/src/squeeze/)).
So the code has already been through what a 2 MB limit on a mixnet asks of it: phone photos,
iPhone HEIC, screen recordings, voice notes, scanned PDFs, decks full of pictures.

What Slynk builds around those modules, and the example leaves to you:

- **Its file list's screen** ([web/src/tray.ts](../../web/src/tray.ts)): each file's row
  and progress, the box under the meter, and its questions on screen. The list behind it
  ([web/src/prep/list.ts](../../web/src/prep/list.ts)) plans again as files are added or
  removed and keeps a video already made when more files come; `prepareFiles` runs that same
  list (section 3), and an app whose list changes as files come and go can use it directly
  (`createFileList`), with Slynk's screen as the worked example.
- **Its screens:** the sender's "Cleaned" list with what was removed, previews, and plain
  warnings to the recipient about files that could run as programs.
- **Its link and transfer:** the envelope ([web/src/payload.ts](../../web/src/payload.ts)),
  the one-time and password layers, and the upload through the xx network (section 9).

That's the split to copy: take the modules and `prepareFiles` (or the file list itself), and
put your own screens and transfer around them, as Slynk does.

## 3. What `prepareFiles` does

[prepare.ts](../../web/examples/file-prep/prepare.ts) takes a list of `File`s and does with
them what Slynk's composer ([web/src/tray.ts](../../web/src/tray.ts)) does when the same
files are added to it at once and left until it's finished, because it runs the same code:
it adds them to a file list of its own ([web/src/prep/list.ts](../../web/src/prep/list.ts),
the composer's), gives each the choices `perFile` names, waits until the list has nothing
left to do by itself, and reads what came out. The steps below are the list's, under its
names (`place`, `processRow`, `openZip`, `packRow`, `compose`, `shares`, `planCopies`,
`makeSmallerCopies`…).

1. **Looks at each file**, in the order given. A video is first read by its index alone
   ([web/src/video/info.ts](../../web/src/video/info.ts)), and one too big to go as it is
   isn't read at all: only a smaller version of it can go, made from the file. So it is
   with a WAV recording of 25 MB to 200 MB, which is read a run at a time. A zip is opened
   without being read whole, whatever its size: its photos, videos, audio and documents
   become files of their own, and the rest goes in it as it is. Anything else is read: most
   files up to 25 MB, documents, audio and a zip that can't be opened so (one locked with a
   password, say) up to 60 MB, and no more than 100 MB in all.
2. **Cleans it** with the cleaner, `cleanFile` from
   [web/src/stripHook.ts](../../web/src/stripHook.ts), always with PDFs. The cleaner runs in
   a worker, rewrites the file without re-encoding it, and checks its own output by
   parsing it again. It hands back the cleaned bytes and what was removed, with the values
   it held ("GPS location: 12.34° N, 56.78° E"), for the sender's eyes only. A file it
   can't clean safely comes back as it was, and says why. Slynk then asks the sender before
   sending it, and makes nothing smaller until they answer; `prepareFiles` does the same in
   its way: the file waits, `waiting` is true and nothing fits until `perFile` gives it
   `sendAsIs` or it's left out.
3. **Makes them smaller**, when the composer would, as much as it would. With
   `'smallest'` it always does, unless a file is too big to read or waits for an answer;
   with `'fit'`, only when they don't fit as they are (section 4). Neither starts while a
   zip holds a file too big to go even alone, and they're over. The space is shared out
   by Slynk's own plan: each file's claim, the room the rest leave, Slynk's `allocate` and
   `giveRoom` ([web/src/shrink/plan.ts](../../web/src/shrink/plan.ts)). Then, by kind:
   - **Photos** are redrawn on a canvas and saved as a new JPEG (WebP or PNG for one with
     see-through parts) by [web/src/shrink/draw.ts](../../web/src/shrink/draw.ts):
     `measure`, then `keptCopy` or `makeCopy`. HEIC photos are opened with the browser's
     own HEVC decoder where it has one ([web/src/heic/](../../web/src/heic/)). Animations
     are left as they are.
   - **PDFs and Office files** (Word, Excel and PowerPoint, OpenDocument, RTF) of
     200 KB or more have their pictures made smaller, in a second
     copy of the cleaner's worker ([web/src/docshrink/](../../web/src/docshrink/), which
     runs [web/src/pdfshrink/](../../web/src/pdfshrink/) and
     [web/src/officeshrink/](../../web/src/officeshrink/)). Text and layout never change.
     They're made from the cleaned bytes, so what cleaning removed stays out. A PDF is made
     for its share as it will be sent, deflated by the same rule
     ([web/src/compress.ts](../../web/src/compress.ts)): each new picture is counted as it
     deflates, and the PDF is made once at its smallest while it's measured, so how small it
     can get is exact. A manual of screenshots goes about a seventh smaller that way, which
     can be the difference between fitting and not. Office files are zips, sent as they are.
   - **Audio** is made again as Opus in an M4A file, in the video worker (`audioInWorker`);
     FLAC and Ogg are decoded on the page first, where the Web Audio API is
     ([web/src/audio/](../../web/src/audio/)).
   - **Videos** (MP4 and MOV) are made again as H.264 MP4 in a worker, with WebCodecs and
     Slynk's own MP4 reader and writer (`shrinkInWorker` in
     [web/src/video/client.ts](../../web/src/video/client.ts)).
   - **A zip's files** are made smaller as files of their own, and the zip is written
     again with them ([web/src/zipInside.ts](../../web/src/zipInside.ts)).

   Photos come first, then documents, audio and videos, as in Slynk. With `'smallest'`, a
   smaller version is made only when it would save at least 5% of the file. A new photo,
   video or audio file holds none of the original's hidden details.
4. **Compresses it** with Slynk's own `store` and `squeeze`
   ([web/src/payload.ts](../../web/src/payload.ts)): nothing for what's already compressed,
   by its first bytes; raw deflate (the browser's own) when it saves at least 5%; then
   Brotli when it's smaller still. Brotli runs in a worker of its own on Slynk's
   WebAssembly helper ([web/src/squeeze/](../../web/src/squeeze/)). Where that helper isn't
   built, the worker fails to start and the deflated version stands. A zip written afresh
   may go unpacked and squeezed whole, when that's smaller.
5. **Counts them** as Slynk sends them: each file as an item of Slynk's envelope (its name,
   type and size beside its bytes), and the envelope's own few bytes. They must fit the
   budget less a one-time link's seal (28 bytes; every slynk.me link is one-time), and
   copies are planned with 45 bytes kept for a password and, beside videos and audio,
   8,000 for a message, as Slynk keeps them. With `framing: 'none'` only their compressed
   bytes are counted, against the whole budget.

Each file comes back with its name (a copy gets its new type's extension, so
`IMG_1234.HEIC` becomes `IMG_1234.jpg`), its type, its original size, the prepared bytes,
which open as they are, the compressed form to send and what it takes of the budget, what
cleaning removed, how it was made smaller ("1280 px JPEG at 40%", "240p H.264 MP4 at 30
fps, Opus sound"), any problems in Slynk's own words ("This browser can't make videos
smaller."), and for a zip, its files. With them come the total, the limit, whether they
fit, and, when they can't go as they are, what Slynk's box would say ("Too much to fit,
even made smaller. Remove the video or some photos.").

## 4. The options

The options are Slynk's Settings, without its screens. Nothing is read from Slynk's
settings or stored in the browser: every choice comes in through the options object, and
each default is Slynk's own. Two choices have no Slynk setting of their own: `'off'`
stands in for Slynk's "Ask first", which makes nothing smaller until the sender says so,
and `compression: 'none'`.

| Option | Default | What it does |
|---|---|---|
| `budget` | 2,000,000 | What the upload may weigh (Slynk's `MAX_PAYLOAD`) |
| `framing` | `'slynk'` | `'slynk'`: counted as Slynk sends them (its envelope, a one-time link's seal, room for a password); `'none'`: their compressed bytes alone |
| `clean` | `true` | Remove hidden details ("Remove hidden details from files") |
| `shrink` | `'smallest'` | `'smallest'`, `'fit'` or `'off'` (below) |
| `photoLevel` | `'least'` | What `'smallest'` makes photos: `'least'`, 1,280 px at 40%; `'medium'`, 1,280 px at 70%; `'good'`, up to 2,048 px at 85% |
| `videoLevel` | `240` | What `'smallest'` makes videos: 180p, 240p or 360p, stepping down when they don't fit (below) |
| `compression` | `'brotli'` | `'brotli'` (deflate where the helper isn't built), `'deflate'` or `'none'` |
| `plainNames` | `false` | Neutral names for names that give something away (`IMG_20240612_183045.jpg` becomes `photo.jpg`) |
| `perFile` | none | One file's own choice: `clean: false` as Slynk's "Send original instead", `shrink: false` as "Send full size instead", `sendAsIs: true` as the answer to Slynk's question about a file it couldn't clean |
| `onProgress`, `signal` | none | Progress for each file and stage; an `AbortSignal` to stop |

**`'smallest'`** makes every file as small as its level makes it, whatever the room, as
Slynk does by default: photos at the chosen level, videos at the chosen level (240p is
about 426 × 240 pixels at up to 30 frames a second), audio at about 16 kbit/s in mono, and
the photos in a document at its lowest level (100 pixels per inch at 40%;
[web/src/pdfshrink/plan.ts](../../web/src/pdfshrink/plan.ts)). Smaller files send faster,
so this is the right default on cMix. A video is made at its level when everything fits
that way. When it doesn't, the videos step down together, all at the same step: each size
at 30 frames a second, then at 15, then the next size down, as far as 180p at 15 frames a
second at a lower quality, as small as Slynk goes (`levelSteps` in
[web/src/video/plan.ts](../../web/src/video/plan.ts)). At 240p, a 1080p video with sound
goes at 30 frames a second up to about 85 seconds, at 15 up to about 2¼ minutes, and at
180p up to about 3½. A video is made within what it's given: the room the rest leave, up
to what a good quality would take, as a margin for a sound or an encoder that comes out
bigger than planned; if its sound still takes more than counted, it goes on down from the
step planned. Videos are made one at a time, and before each the room is planned again
with the sizes the earlier ones came out at, so what one doesn't use goes to the next. When
they can't all fit even at their smallest, only the photos are made smaller, and the rest
are left until enough is taken out, as in Slynk.

**`'fit'`** keeps files at full size while they fit, compressed as they'll go. When they
don't, every photo, video, audio file and document that could be made smaller gets a share
of what the rest leave, in proportion to its weight (a photo's pixels; for the others, what
it would take at a good quality, counted in photo pixels), so they come out at about the
same quality. This uses Slynk's own `allocate`
([web/src/shrink/plan.ts](../../web/src/shrink/plan.ts)) and the composer's way of weighing
each kind; lower qualities are used only when the usual ones can't fit. As in Slynk,
`'fit'` doesn't start while a file it can't make smaller is too big to go even on its own
beside others: the result names it, and says it should be taken out. A zip counts as such a
file only when it would still be too big without the files in it that can be made smaller.

## 5. How to run it

```bash
cd web && npm install && npm run build:core && npm run dev
```

Then open `http://localhost:5173/examples/file-prep/`. The page offers the options above
with Slynk's defaults chosen, a budget of 2,000,000 or 250,000 bytes or one of your own,
and each file's own choices. It shows each file before and after (a zip's files under it),
what was removed, the total against what the budget leaves them, what Slynk would say when
they can't go, and a way to save each prepared file. `npm run build:core` needs Go; without
Go, leave it out (`cd web && npm install && npm run dev`): the page still runs, and files are
deflated instead of Brotli'd. The page is served only by the development server: it isn't in
Slynk's build, so slynk.me never serves it.

## 6. What to copy into your project

The example imports Slynk's modules where they are, as `../../src/…` with `.ts` extensions.
To use it elsewhere, copy [prepare.ts](../../web/examples/file-prep/prepare.ts) and these from
`web/src/`, keeping their layout, and change those import paths to where you put them. The
code expects TypeScript with `allowImportingTsExtensions` and bundler resolution, and Vite's
types for the Brotli worker's `?url` import (as [web/tsconfig.json](../../web/tsconfig.json)
sets them):

| From `web/src/` | What it's for |
|---|---|
| `strip/`, `filecheck/`, `stripHook.ts` | The cleaner and its worker (which also runs file checks) |
| `shrink/`, `heic/` | Photo copies; HEIC decoding |
| `video/`, `audio/` | Video and audio, and their worker |
| `docshrink/`, `pdfshrink/`, `officeshrink/` | Pictures in PDFs and Office files |
| `squeeze/`, `core/generated/` | Brotli: its worker, and the helper's `slynk-tools.wasm` and `wasm_exec.js` (built, not in the repo) |
| `prep/` | The file list that plans and makes it all (`list.ts`), and what it makes things smaller with (`makers.ts`) |
| `payload.ts`, `compress.ts`, `site.ts` | The budget's default, the envelope it counts in and the compression rules (`compress.ts`, which the PDF shrinker counts with too); whether links are one-time |
| `zipFile.ts`, `zipInside.ts` | Opening a zip without reading it whole, and writing it again |
| `shrinkCopy.ts`, `ui/cleaning.ts`, `ui/svgPicture.ts` | Slynk's wording for problems; which bytes go after cleaning; telling an SVG drawing apart |
| `ui/format.ts` | Sizes for the demo page only |

**npm packages** (from `web/package.json` and `CREDITS.md`), the three MIT: fflate 0.8.3,
@xmldom/xmldom 0.9.12, and pdf-lib 1.17.1, which brings pako (MIT and Zlib), tslib (0BSD),
@pdf-lib/standard-fonts (MIT) and @pdf-lib/upng (MIT). pdf.js isn't needed.

**The WebAssembly helper** is Slynk's Go program `core/cmd/tools-wasm`, with
`core/squeeze` (Brotli) and `core/kdf` (Argon2id for Slynk's password links, from
golang.org/x/crypto). Its Brotli is Andy Balholm's Go port v1.2.7 (MIT), kept in
`third_party/andybalholm-brotli`. `npm run build:core` (`core/build-wasm.sh`) builds it
along with Slynk's whole mixnet engine; on its own, in `core/`:

```bash
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o slynk-tools.wasm ./cmd/tools-wasm
```

then copy `lib/wasm/wasm_exec.js` from the same Go installation (`go env GOROOT`). Brotli
is optional at run time, but not at build time: `payload.ts` imports `squeeze/`, whose
worker imports both files, so a bundler needs them there even if Brotli is never used.
Without them, the development server only fails to start that worker, and deflate stands.

**Browser features:**

- Web Workers, as module workers: the cleaner, the document shrinker, the video and audio
  worker and Brotli each run in one.
- A canvas: photos are drawn on the page's canvas, and pictures in documents and video
  frames on `OffscreenCanvas` in workers. Some privacy settings make a canvas hand back
  noise; the code checks before making photos smaller, and if the canvas is altered, nothing
  is made smaller, as in Slynk.
- WebCodecs: `VideoDecoder` and an H.264 `VideoEncoder` for video, `AudioDecoder` and
  `AudioEncoder` with Opus for audio. Firefox on Android, Tor Browser and older iPhones
  lack them.
- An HEVC decoder for HEIC photos away from Safari.
- The Web Audio API (`OfflineAudioContext`) on the page, for FLAC and Ogg.
- A secure context (HTTPS, or `localhost`): cleaning a PDF uses `crypto.subtle`.

**Bundling.** The workers are started as
`new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })`. Vite finds them by
itself: Vite 8.3.4 builds the example with no settings of its own, its three workers and
the helper included. webpack 5 documents the same pattern, but it hasn't been tried with
this code. Slynk builds with Vite and `worker.format: 'es'`, so the cleaner's worker can
load each format's code as its own chunk ([web/vite.config.ts](../../web/vite.config.ts)).
The Brotli worker imports its WebAssembly file with Vite's `?url`; another bundler needs
its own way to name that file. No `blob:` workers, `eval` or CDNs are used, so it runs
under a strict Content Security Policy; Brotli's WebAssembly needs `'wasm-unsafe-eval'` in
its `script-src`, as Slynk's has.

**What stays behind:** Slynk's screens (the composer's screen, `web/src/tray.ts`, and the
rest of `web/src/ui/`) and its settings (`web/src/ui/settings.ts`, whose type alone the file
list names). Slynk's envelope format
([link-and-envelope-format.md](link-and-envelope-format.md)) is only counted in, with
`framing: 'slynk'`: you needn't send in it (`framing: 'none'`). Ties remain in what you copy:
`site.ts` names the site, which Slynk's wording for problems and the cleaner's reasons for
leaving a file alone use, and its `ONE_TIME_ONLY` decides whether the 28 bytes of a one-time
link's seal are counted.

## 7. What it can't do

- **Cleaning has limits.** It can't remove what can be seen, watermarks, or a camera's own
  patterns, and some formats go as they are: older Office files, TIFF and raw photos,
  Matroska and AVI videos. [hidden-data-cleaning.md](hidden-data-cleaning.md), section 11,
  has the list.
- **Making smaller is lossy.** A photo at the least level may look a little blocky up
  close; audio at 16 kbit/s is fine for speech but flat for music; HDR photos may look
  flatter. The original stays on the device.
- **One pass.** `prepareFiles` adds the files once and reads them once the list has settled.
  Until then it's Slynk's composer at work: it waits for Brotli as long as the composer does
  (with `'fit'`, 10 to 20 seconds before deciding to make anything smaller; with
  `'smallest'`, not at all, counting what Brotli hasn't finished at its deflated size), and
  plans again where the composer would, as when a file fails to be made smaller after the
  plan. What a sender does later, taking a file out or changing a choice after a run, it
  can't: an app that needs that uses the file list itself (`createFileList`), as the composer
  does. A file waiting for an answer is a flag, with no question to show. Choices go to whole
  files: a zip's files take none of their own (Slynk gives each its own) and answer with the
  zip.
- **Big files go as in Slynk.** Most kinds are read only up to 25 MB, documents and audio up
  to 60 MB, and no more than 100 MB in all; videos and WAV recordings of up to 200 MB are
  made smaller from the file, never read whole, and a zip is opened part by part, whatever
  its size. A file too big to read can't go,
  and stops anything else being made smaller until it's taken out.
- **Browsers differ.** Without WebCodecs, videos and audio aren't made smaller: those that
  fit go at full size, the rest can't go, and the result says so. So does a HEIC photo in a
  browser that can't open it.
- **Names can repeat.** Two files can come back with the same name: `a.mp3` and `a.ogg`
  both become `a.m4a`, and with plain names two phone photos can both become `photo.jpg`.
  Slynk sends them so too, and its recipient makes them unique when it saves them as one
  zip (`uniqueNames` in [web/src/zip.ts](../../web/src/zip.ts)). Make them unique if your
  app needs it.
- **`'fit'` compresses first.** To see whether the files fit as they are, `'fit'` first
  compresses them at full size, as Slynk does: Brotli on every one when that could make them
  fit, and otherwise only on those it won't make smaller. That's seconds for a big document,
  before anything is made smaller.

## 8. What was tried

**Tests.** In Slynk's repo the example is checked with the rest of the code. Every build
type-checks it, and `web/test/file-prep.test.ts`, part of `npm test`, checks that it still
runs Slynk's file list and has nothing of its own to plan or make, that its defaults, levels
and limits are still Slynk's, and that it stays out of the site's build. It also runs the
cleaning, counting, compression, options, waiting, read limits, zips and
document-measuring paths in Node, with the cleaner's and the document shrinker's own code
standing in for their workers. Node has no canvas or WebCodecs, so photos, videos and audio
are made smaller only in a browser; `web/test/file-list.test.ts` stands in for what makes
them, so the file list's plan, the order it makes things in and what its box says are
checked in Node too.

**Beside Slynk.** On 2026-10-31 the same files went through Slynk's own page and through
`prepareFiles`, in the same tab of a desktop Chromium-based browser (version 152): a 12 MP
photo with a location; a screenshot; two H.264 videos (10.15 MB and 564 KB); a 60 s WAV; an
MP3; a text file; a zip holding a 12 MP photo and a text file; a small Word file and an SVG
drawing, both with made-up hidden details; and test documents of 11.6 and 13.7 MB with
pictures in them.

| Settings | Slynk's meter | `prepareFiles` |
|---|---|---|
| Smallest, 12 files with the zip | 1.16 MB, 58.2401% of its limit | 1,164,785 bytes, 58.2401% |
| Smallest, the 11 without the zip | 993 KB, 49.6651% | 993,288 bytes, 49.6651% |
| To fit, the 11 without the zip, added at once | 1.48 MB, 74.0598% | 1,481,176 bytes, 74.0598% |
| To fit, 12 files with the zip | 1.63 MB, 81.4601%, the zip's photo made smaller in it | 1,629,179 bytes, 81.4601% |
| To fit, a zip of a photo and two 1.2 MB files of random data, beside a text file | Over by 6.20 MB; "z-random-and-photo.zip is too large to send, even on its own" | 8,197,122 bytes; the same words, on the zip |
| Smallest, three videos (10 s portrait, 20 s at 720p, 5 s at 640 × 360) and 1.12 MB of random data | 1.58 MB, 78.7981%, all three at 240p | 1,575,940 bytes, 78.7981%, the same |

The meter shows four decimal places of a 1,999,972-byte limit, so each match is to within two
bytes. (The test documents are drawn with random grain each time, so the rows are separate
runs.) Where they were compared file by file, every file came out the same on both: the same
name, the same size, the same way made smaller. In one "To fit" run (74.1016% on both), the
photo went to 1,280 px at 70% (287 KB), the screenshot to 1,708 px at 85% (92 KB), the videos
to 240p (91 KB and 239 KB), the recordings to Opus at 19 and 23 kbit/s, the PDF to 245 KB and
the Word file to 193 KB. A list that Slynk had already worked on and then changed came out differently, as
section 7 says.

On 2026-11-01 the example moved onto Slynk's own file list, and 12 batches of these files went through
Slynk's page and `prepareFiles`, before the move and after it: "Smallest" at each level, "To fit", too much
to fit, plain names and "Ask first", with photos, videos, audio, documents and zips. Slynk's page gave the same
sizes and words after as before, and `prepareFiles` the same as Slynk's page every time, to within the meter's
rounding. One answer changed, in the example: beside a 3 MB file of random data, too big to go even on its
own, it now gives Slynk's own words for that ("…is too large to send, even on its own"), where it used to say
the files were too much to fit.

**Each kind.** With the default options, in batches small enough for Slynk's limits:

| File | Prepared | How |
|---|---|---|
| JPEG photo, 4032 × 3024, with a location, 5.80 MB | 180 KB | 1,280 px JPEG at 40%; its location, camera, serial numbers and date listed |
| PNG screenshot, 2560 × 1440, 431 KB | 28 KB | 1,280 px JPEG at 40% |
| H.264 video, 1080 × 1920, 10 s with sound, 10.15 MB | 217 KB | 240p H.264 MP4 at 30 fps, Opus sound |
| H.264 video, 1280 × 720, 20 s with sound, 564 KB | 91 KB | The same |
| WAV, 60 s, stereo, 10.58 MB | 103 KB | Opus in M4A, 13 kbit/s, mono |
| MP3, FLAC, Ogg Vorbis, Opus and AAC, 60 s each | 103 to 124 KB each | Opus in M4A |
| PDF with pictures, 11.58 MB | 117 KB | Six of its pictures made smaller, then Brotli |
| Word, Excel and PowerPoint files with pictures, 13.7 to 15.8 MB | 128 to 181 KB | Their pictures made smaller |
| OpenDocument text and presentation, 13.7 and 15.8 MB | 937 and 971 KB | Their pictures made smaller |
| RTF with pictures, 27.6 MB | 114 KB | Its pictures made smaller, then Brotli |
| Zip holding the 12 MP photo and a text file, 5.80 MB | 172 KB | Its photo made smaller inside it, then the zip squeezed whole with Brotli |

Prepared files were opened again in the browser: the photo decodes, the audio and video
play (the video at 240 × 426 and 10 s), the PDF opens with its pages, and the Word file
unzips whole. Some went as they were, and said why: HEIC photos, in that browser without an
HEVC decoder, went through the cleaner but weren't made smaller ("This browser can't open
this photo to make it smaller."); a WebM video was neither (only MP4 and MOV are made
smaller, and Matroska isn't cleaned); an MPEG-4 Part 2 video in a MOV was cleaned, not made
smaller; random data wasn't compressed; and a 61 MB file wasn't read, so nothing beside it
was made smaller. The OpenDocument files and the RTF together can't fit even at their
smallest, so beside each other they were left as they were, with only photos made smaller,
as Slynk does; each came to the size above on its own.

The same pipeline was also tried on phones (an iPhone and an Android phone) before
launch. Not tried: Firefox, or Safari on a Mac.

## 9. Then the mixnet

`prepareFiles` stops before the network. Each file comes back with `compressed.method`
(`'as-is'`, `'deflate'`, which is raw deflate, or `'brotli'`) and `compressed.body`.

**In Slynk**, the composer packs its files the same way into its envelope (`packItem` and
`encode` in [web/src/payload.ts](../../web/src/payload.ts)), which records each item's name,
type, size and method. The one-time and password layers go around it, and the core uploads
the result (`Upload` in [core/transfer/transfer.go](../../core/transfer/transfer.go)) with
xxDK's channels file transfer, to a random single-use recipient ID.

**In your app**, send what your transfer needs: the name, type, method and body, inside
your own framing, and count that framing within the budget. The recipient undoes the
compression (`DecompressionStream('deflate-raw')` for deflate; a Brotli decoder for Brotli)
and should check the result's size, since the bytes come from whoever sent them, as
Slynk's `inflate` does. A zip with `compressed.unpacked` went with its files unpacked: its
Brotli body comes back to that many bytes, a zip with its files stored, which the recipient
packs again (`repackZip` in [web/src/zipInside.ts](../../web/src/zipInside.ts)), as Slynk's
recipient does.

## 10. As is

The example and the code it uses are Slynk's, under the repo's BSD 2-Clause licence. There
is no package and no support: copy it, change it, and keep the licences of what it uses.

## Sources

- xxDK v4.8.4: `gitlab.com/elixxir/client/v4`, mirrored at github.com/xxfoundation
  (`channelsFileTransfer/manager.go` and `fileTransfer/manager.go`: the 250,000-byte cap)
- Slynk's fork's cap: [third_party/xxdk-client/channelsFileTransfer/manager.go](../../third_party/xxdk-client/channelsFileTransfer/manager.go)
- The example: [web/examples/file-prep/](../../web/examples/file-prep/)
- The pipeline: [web/src/strip/](../../web/src/strip/), [web/src/shrink/](../../web/src/shrink/),
  [web/src/video/](../../web/src/video/), [web/src/audio/](../../web/src/audio/),
  [web/src/docshrink/](../../web/src/docshrink/), [web/src/squeeze/](../../web/src/squeeze/),
  the file list that runs it all, [web/src/prep/list.ts](../../web/src/prep/list.ts), and the
  composer's screen, [web/src/tray.ts](../../web/src/tray.ts)
- Why files are made smaller and cleaned on the device: [decisions.md](decisions.md),
  section 6

## Credits

The cleaner and shrinkers use fflate by Arjun Barrett, @xmldom/xmldom by Christopher J.
Brody, jindw and the xmldom contributors, pdf-lib by Andrew Dillon, and Brotli, designed at
Google by Jyrki Alakuijala and Zoltán Szabadka, through Andy Balholm's Go port. Thanks to
the xx foundation for cMix and xxDK, to Rick Carback, xxDK's leading contributor, and to
Keith Millette, whose fork Slynk builds on.

— Slynk
