# Removing hidden details from files, in the browser

*Slynk, 2026-10-31. All times UTC.*

Many files carry details their owner never sees: where a photo was taken and on which
phone, a document's author and editing history, the names on its comments. Before
anything is sent, Slynk takes these out on the sender's own device, in a Web Worker in
the page; nothing goes to slynk.me or anywhere else to be cleaned. This note describes
how, format by format, and what cleaning can't do. The code is in
[web/src/strip/](../../web/src/strip/); to use it in your own app, see
[preparing files for the mixnet](preparing-files.md).

## In short

- Cleaners for JPEG, PNG, WebP, GIF, HEIC and AVIF photos; MP4, MOV, M4V and 3GP videos;
  MP3 and FLAC audio; SVG drawings; PDF, Office, OpenDocument and RTF documents; and the
  files inside plain zips.
- Metadata is cut out or blanked in place, and everything else copied as it is (files
  built as zips are written afresh around their unchanged parts). Only a PDF is saved
  anew as a whole.
- A file that can't be read with certainty, or cleaned without risk to its content,
  goes as it is, and the sender is told: it's never half-cleaned.
- "Hidden details were removed", on the recipient's screen, is the sender's word, not
  proof.

## 1. Where it runs

While "Remove hidden details from files" is on (the default), every file added to the
composer goes to the cleaner. The engine ([engine.ts](../../web/src/strip/engine.ts))
tells the type from the file's first bytes ([sniff.ts](../../web/src/strip/sniff.ts)),
never from its name or MIME type, runs that format's cleaner, then checks the result: it
must still read as the same type, and the format's `verify` must parse it again and find
nothing left to remove.

The cleaner's worker ([stripWorker.ts](../../web/src/strip/stripWorker.ts)) takes one
file at a time, so a stuck one can be timed out alone: after 30 seconds plus 2 seconds
per megabyte, the worker is replaced and the file counts as failed
([index.ts](../../web/src/strip/index.ts)). A failed file waits for the sender's answer
to "Couldn't clean the hidden data from this file. Send it as it is?". The worker keeps
nothing. Every format's code is fetched when the page starts, for every visitor
([formats.ts](../../web/src/strip/formats.ts)): code fetched only when a file of its
kind turned up would tell a web host's logs, or anyone watching the connection, what
kind of file someone was sending.

## 2. The principles

**Remove rather than rewrite.** Each cleaner walks the file's own structure (JPEG
segments, PNG chunks, ISO media boxes, ZIP entries, RTF groups, SVG elements by byte
offset) and cuts out or blanks only what holds details. Pictures and sound are never
decoded and encoded again, and a document's XML part is rewritten only when it holds
something to remove. PDF is the one exception (section 6).

**Keep what changes how the file looks or plays:** colour profiles, the EXIF
Orientation tag (so photos don't turn sideways), animation, HDR gain maps, a video's
rotation, a document's styles and fonts.

**Refuse rather than half-clean.** Where a cut could damage the content, or the file
can't be read with certainty, the cleaner stops, and the sender sees a line under the
file saying it goes as it is, and why.

**A smaller copy is a new picture.** With the default "Smallest" setting, most photos
are redrawn smaller by the browser, and videos and audio made smaller are encoded
afresh, so they hold nothing of the original file. Browsers add a little of their own to
a picture they save (Chrome a colour profile naming its maker, Safari possibly a small
EXIF block), so each copy keeps only its picture data
([web/src/shrink/bare.ts](../../web/src/shrink/bare.ts)). The cleaners matter for files
sent at full size, for documents and drawings, and for the pictures inside them.

## 3. Photos

**JPEG** ([jpeg.ts](../../web/src/strip/jpeg.ts)) keeps the quantisation and Huffman
tables, frame and scan headers, ICC profile, Adobe's colour-transform segment, JFIF
without its thumbnail, and a fresh EXIF block holding only a non-default Orientation.
Everything else goes: EXIF (location, camera, lens, serial numbers, dates, settings,
maker notes), XMP and Extended XMP, Photoshop and IPTC blocks, comments, Content
Credentials (C2PA), unknown segments, and segments between a progressive JPEG's scans.
So does everything after the end-of-image marker (motion-photo videos, extra previews,
vendor trailers), except an HDR gain map the photo declares (Ultra HDR or ISO 21496-1).
That's kept, cleaned of its own metadata, and linked again with fresh MPF and container
entries, so HDR screens still show the brighter version.

**PNG** ([png.ts](../../web/src/strip/png.ts)) keeps only the chunks that draw the
picture, APNG animation included, copied whole so their checksums stay valid; text
chunks (including the prompts some image generators write), EXIF (bar Orientation),
timestamps, Content Credentials, private chunks and anything after the end go. **WebP** ([webp.ts](../../web/src/strip/webp.ts))
keeps the image, alpha, ICC and animation chunks and drops EXIF (bar Orientation), XMP,
Content Credentials and unknown chunks. **GIF** ([gif.ts](../../web/src/strip/gif.ts))
keeps every frame, its timing and transparency, the looping extension and an ICC
profile, and drops comments, XMP, Photoshop and IPTC data, Content Credentials, unknown
extensions and anything after the trailer.

**HEIC and AVIF** ([isobmff.ts](../../web/src/strip/isobmff.ts)) place their pictures
by absolute byte offset (the `iloc` box), so nothing may move. Metadata is overwritten
in place, at the same length:

- the Exif item becomes an empty TIFF block (rotation lives in the `irot` and `imir`
  properties), and an XMP item an empty packet padded with spaces, unless it holds only
  gain-map parameters; a C2PA item and a user description (`udes`) are zeroed
- top-level `uuid` boxes become zeroed `free` boxes, a type every reader skips. So does
  Samsung's `sefd` box, which holds the moment the photo was taken, to the millisecond,
  the camera mode, and after an edit in Samsung's Gallery, what it keeps to undo it
- a motion-photo video (`mpvd`) is cut when it comes last (blanked when boxes follow
  it), anything after the last box is cut, and padding with leftovers in it is zeroed
  unless a picture points into it.

## 4. Videos

MP4, MOV, M4V and 3GP files ([video.ts](../../web/src/strip/video.ts)) also place their
pictures and sound by absolute offset, so they too are edited in place:

- user-data and metadata boxes (`udta`, `meta`) in the movie and its tracks become
  zeroed `free` boxes. That's where an iPhone keeps its location, make, model, software
  and creation date, and Android its location and the rest
- creation and modification times in the movie, track and media headers are zeroed;
  the rotation matrix stays
- timed metadata tracks have their samples zeroed where they lie, track kept: the
  location and motion action cameras record as they film (GoPro's `gpmd`, Google's
  `camm`, DJI's), iPhones' `mebx` details, and timecode's time of day
- top-level `uuid` boxes (XMP and makers' data) are blanked, leftovers in padding
  zeroed, and anything after the last box cut.

A fragmented video (`moof`) with a metadata track is refused, as its samples are
described where the cleaner doesn't look. A video too big to go as it is goes only as a
new, smaller one; its "Cleaned" list is read without loading its pictures and sound,
from the index, user-data and XMP boxes and at most 1 MiB of any padding, trailer or
metadata track.

## 5. Audio

MP3 ([audio.ts](../../web/src/strip/audio.ts)): ID3v2 tags at the start, and APE,
Lyrics3, ID3v1 and ID3v2-footer tags at the end, are sliced off. The audio frames are
untouched, including the Xing/LAME frame players read for the duration. FLAC keeps
STREAMINFO and SEEKTABLE and drops every other metadata block (tags, pictures, cue
sheets, application data and padding), and any ID3 or APE tags around the stream.
M4A, Ogg and WAV files aren't cleaned in place. With the default settings, audio is
encoded again, where the browser can, as a smaller Opus recording (in an M4A file) with
no tags; an M4A, Ogg or WAV file sent at full size goes as it is, and the sender is told
Slynk can't check it.

## 6. Documents

**Word, Excel and PowerPoint** ([ooxml.ts](../../web/src/strip/ooxml.ts)). Removed: the
document properties (author, last editor, company, manager, title, subject, keywords,
dates, revision, editing time, app, template), custom properties, sensitivity labels,
the thumbnail, editing-session IDs (rsids), document IDs, Excel's saved path and the
names on its pivot tables and shared-file settings, PowerPoint's revision and
co-authoring logs, and pictures' metadata. Office files embedded in one, like the
workbook behind a chart, are cleaned too, two levels deep at most. Comments and tracked
changes stay, as they can be part of the work being shared, but every author becomes
"Author" and their dates are removed or set to 1980-01-01. A rewritten part's text must
come out identical, or the file is refused.

**OpenDocument** (ODT, ODS, ODP: [odf.ts](../../web/src/strip/odf.ts)). `meta.xml`'s
people, dates, title, keywords, description, custom fields, template, generator and
editing statistics go, in embedded charts too, with the printer in `settings.xml`, the
thumbnail, older saved versions and pictures' metadata. Comments and tracked changes are
anonymised as for Word.

**RTF** ([rtf.ts](../../web/src/strip/rtf.ts)) is plain text, so groups and control
words are cut out and every other byte copied: the info group (author, editor, company,
title, keywords, comments, dates, revision, editing time, statistics), the generator,
the template path, custom properties, document variables, Word's data store, every rsid,
and anything after the document's end. Pictures are cleaned, and comment and change
authors become "Author", without dates.

**PDF** ([pdf.ts](../../web/src/strip/pdf.ts)) is saved by pdf-lib as one fresh
revision, because its metadata can sit in any object, and an edited PDF keeps its older
revisions. Removed: the Info dictionary (title, author, subject, keywords, creator and
producer apps, dates, custom keys), XMP at every level, app-private `PieceInfo`, page
thumbnails, `LastModified` stamps, the names and dates on comments, EXIF in JPEG images,
and every object no longer reachable from the document, which is where earlier
revisions and the text they deleted linger. PDF/A and PDF/UA files keep a minimal XMP
naming their conformance level. The new file ID is a hash of the cleaned file, and the
page count is checked after saving. Every PDF added to the composer is cleaned like any
other file (there's no separate switch for PDFs), and "Send original instead" sends it
untouched.

**Left alone:** signed documents (cleaning would break the signature), password-protected
or encrypted ones, and Office's older `.doc`, `.xls` and `.ppt` files, which are
recognised but not parsed; the sender is asked to save those in the newer format.

## 7. SVG drawings

A strict, single-pass reader ([svgscan.ts](../../web/src/strip/svgscan.ts)) reports
where each element, comment and run of text begins and ends, by byte, so the cleaner
([svg.ts](../../web/src/strip/svg.ts)) can cut parts out and keep every other byte. It
removes the contents of `<metadata>` (author, rights, dates, XMP); a `<desc>` that only
names the app; comments; every element and attribute in another app's namespace, which
browsers don't draw (Inkscape's file name, export paths and window settings,
Illustrator's whole editable copy of the artwork, any other app's), plus some apps' own
attributes in no namespace, such as draw.io's copy of the diagram; processing
instructions other than a style sheet's; links to files on the maker's computer; and
the hidden details of embedded pictures and drawings.

It refuses a file it can't be sure it reads as a browser would: one that isn't
well-formed XML, whose first element isn't `<svg>`, in an encoding other than UTF-8 or
one byte per character, or whose DTD does more than name plain text. Entities never
expand inside one another, and nothing is fetched. A file is also left alone when a cut
could change what's drawn, such as a `<style>` or a shape reused by `<use>` inside what
would go. A cleaned drawing looks the same but may no longer open for editing as before
(an app's own editable copy is gone). Its `<title>`, hidden layers and anything drawn
off the page are part of the drawing, so they're still sent.

## 8. Zips

A plain zip ([archive.ts](../../web/src/strip/archive.ts), [zip.ts](../../web/src/strip/zip.ts))
is written afresh. Every entry gets the same date (1980-01-01 00:00, the earliest a zip
can hold), with no extra fields (owners' IDs, timestamps, access lists) and no comments,
so the same input always gives the same bytes. Files a computer or app adds by itself
go (`.DS_Store`, `Thumbs.db`, `__MACOSX`, macOS's `._` companions, Windows'
`Zone.Identifier` marks), and so do Office's and LibreOffice's lock files, which name
whoever had a document open. Names keep their exact bytes, and entries their kind
(folder, link, a file that runs or doesn't), so the zip unpacks as before.

In the composer, a zip's photos, videos, audio and documents (up to 200) become rows of
their own, made smaller and cleaned as they would be alone, then put back in their
folders ([web/src/tray.ts](../../web/src/tray.ts)). The zip cleaner handles the other
files it has a cleaner for, one level deep, except PDFs: a PDF is cleaned only as a row
of its own, so one that doesn't become a row (past the first 200 such files, or too
large to read) goes as it is. What goes unchecked is listed under the zip: zips inside
it, such PDFs, files it can't parse, symbolic links (whose targets can name a home
folder), and sidecar files describing a photo (Lightroom's XMP, Google Takeout's JSON).
A password-protected zip goes as it is.

## 9. Safety against crafted files

- **Sizes are checked before they're used.** Every box, chunk, segment and entry must
  lie inside its parent and the file. A HEIC item larger than the file, or an item index
  listing more than 65,536 pieces in all, is refused, as is a video track claiming more
  than 20,000,000 samples.
- **Overlaps are refused.** In HEIC and video files, every byte a kept picture or track
  points into is checked against what would be blanked or cut; if they overlap, the file
  is refused, not damaged. So are ZIP entries that overlap, share a name, or whose two
  headers disagree, and RTF edits that overlap.
- **Decompression is capped** ([inflate.ts](../../web/src/strip/inflate.ts)) and fed in
  4,096-byte slices, so a small compressed part can't expand into gigabytes. A package
  may expand to 300 MB in all; a zip of more than 10,000 entries, a file over 100 MB, or
  a drawing over 25 MB is left alone as too large to check. Every entry read back is
  checked against its CRC.
- **Work is linear.** The SVG reader never goes back over what it has read, and limits
  nesting, namespaces and entities. XMP reading is bounded, and at most 1,000 removed
  values are collected per file. The watchdog of section 1 catches anything else.

## 10. What the sender and the recipient see

Under a cleaned file the sender sees a **Cleaned** chip. It opens a list of what was
removed, in plain words ("GPS location", "camera make and model", "author name"), most
telling first, each with up to three of the values it held, cut to 80 characters
([values.ts](../../web/src/strip/values.ts),
[web/src/ui/cleaning.ts](../../web/src/ui/cleaning.ts)). Coordinates show to four
decimal places, about 10 m. Characters that hide or reorder text are taken out first, so
a crafted value can't pretend to be something else. The values reach only the sender's
screen: they're never sent, stored or logged. "Send original instead" sends the file
untouched, and the chip then reads "Not cleaned".

The recipient sees **"Hidden details were removed"** (or "Made smaller, no hidden
details") under a file. Each line comes from a bit in the item's header (one for
cleaned, one for a copy made smaller), set by the sender's browser ([web/src/payload.ts](../../web/src/payload.ts)); for a zip, only when nothing
in it went unchecked or was kept by choice. It's the sender's word, not proof: a
modified copy of Slynk could set it on anything, and the recipient's browser doesn't
re-check the file.

File names travel too, and those phones and apps make up can give away a date or a
device (`IMG_20240612_183045.jpg`, `PXL_…`, a screenshot's or scanner's name). "Plain
file names" in Settings, off by default, sends such files under a plain name like
`photo.jpg` ([names.ts](../../web/src/strip/names.ts)).

## 11. What cleaning can't remove

- **What you can see:** faces, a street sign, a reflection, the words in a document.
  Text hidden behind shapes, hidden sheets and layers, and speaker notes are part of a
  document's content, and stay.
- **Watermarks**, visible or not, and the faint pattern a camera's sensor leaves in
  every photo. Neither lives in metadata.
- **Traces in the encoding:** a JPEG's quantisation tables, which are kept, can hint at
  the camera or app that made it; a smaller copy can hint at the browser engine that
  drew it, though not at a person or device.
- **Anything in a format Slynk doesn't parse:** older Office files, TIFF and raw photos,
  Matroska and AVI videos, files attached inside a PDF, objects in an Office file that
  aren't Office files themselves, and zips inside zips. Macros stay as they are.

## 12. Plain warnings for recipients

The same machinery gives a recipient short warnings about a file that arrives
([web/src/filecheck/check.ts](../../web/src/filecheck/check.ts), wording in
[web/src/fileWarnCopy.ts](../../web/src/fileWarnCopy.ts)), read from its structure in
the cleaner's worker, never from what a photo, video or recording shows. They say when a
file is a program, a script or shortcut that runs commands, or a disk image; is
disguised (its name says `.pdf`, but it's a program); has macros; will fetch something
from named websites when opened; is a web page or SVG, which can contact websites in a
browser; or has PDF scripts or attached files. An archive's files are checked the same
way, but by name alone in a tar, a locked zip or a zip inside a zip, and for a file over
25 MB or past a zip's first 2,000 files or 64 MB. A check that can't finish in 15 seconds says so.

The words never call a file safe or harmful. It isn't a virus scanner: a file without
a warning can still be harmful once opened in another program. Only recipients see
warnings, since a harmful file is aimed at them.

## 13. How it's tested

The tests are chiefly in [web/test/strip/](../../web/test/strip/) and
[web/test/file-check.test.ts](../../web/test/file-check.test.ts), all offline
(`npm --prefix web test`). Every test file is built in code from its format's structure,
with invented values only ("Example Author", "ExampleCam X1", a location near 12.34° N,
56.78° E, dates such as 12 June 2024); no real photos, recordings or documents are
involved. They check that each listed detail is gone while the picture,
sound or text is unchanged, and that a second pass finds nothing to remove; metadata in
unusual places (C2PA over several segments, metadata after a progressive scan, a HEIC
picture sharing bytes with its Exif item); crafted SVGs of several megabytes, each done
in under 1.5 seconds; and damaged copies, which must never throw and never come back
half-cleaned.

## Sources

- Slynk's cleaners: [web/src/strip/](../../web/src/strip/); the composer's side:
  [web/src/stripHook.ts](../../web/src/stripHook.ts),
  [web/src/ui/cleaning.ts](../../web/src/ui/cleaning.ts),
  [web/src/tray.ts](../../web/src/tray.ts); the recipient's warnings:
  [web/src/filecheck/](../../web/src/filecheck/).
- CIPA DC-008-2023, *Exif* version 3.0; ISO 16684-1, *XMP*, and Adobe's XMP Specification
  Part 3 (storage in files, including Extended XMP in JPEG).
- ISO/IEC 14496-12, *ISO base media file format*; ISO/IEC 23008-12, *HEIF*; Apple's
  *QuickTime File Format*.
- ISO 21496-1:2025, *Digital photography: Gain map metadata for image conversion,
  Part 1: Dynamic range conversion*; Google's *Ultra HDR* image format; the *C2PA
  Technical Specification* (Content Credentials).
- W3C, *PNG Specification* (third edition); RFC 9649, *WebP Image Format*; *GIF89a*;
  the ID3v2.4 and ID3v1 tag formats; RFC 9639, *FLAC*.
- ECMA-376, *Office Open XML*; OASIS, *OpenDocument* 1.3; Microsoft, *Rich Text Format*
  1.9.1; ISO 32000-2, *PDF 2.0*; PKWARE, *ZIP File Format Specification* (APPNOTE.TXT);
  W3C, *Scalable Vector Graphics (SVG) 2*.

## Credits

The cleaners use three libraries, fetched with the page and kept under their own
licences, which the site's `licenses.txt` lists in full:

- **fflate** 0.8.3 by Arjun Barrett (MIT): ZIP compression and decompression, through
  its synchronous and streaming APIs only (its asynchronous one starts `blob:` workers,
  which the page's security policy forbids).
- **@xmldom/xmldom** 0.9.12 by Christopher J. Brody, jindw and the xmldom contributors
  (MIT): XML parsing and writing in the worker, which has no built-in XML parser.
- **pdf-lib** 1.17.1 by Andrew Dillon (MIT): reading and rewriting PDFs, and the PDF
  checks behind the recipient's warnings. It brings pako 1.0.11 (MIT and Zlib), tslib
  1.14.1 (0BSD), @pdf-lib/standard-fonts 1.0.0 (MIT) and @pdf-lib/upng 1.0.1 (MIT), and
  its stream decoders are adapted from pdf.js (Apache-2.0).

— Slynk
