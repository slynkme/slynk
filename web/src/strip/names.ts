// File names travel to the recipient, and the ones phones and apps make up
// reveal when (and on what) a photo or recording was made:
// IMG_20240612_183045.jpg, PXL_..., Screenshot_2024-06-12-..., "WhatsApp
// Image 2024-06-12 at 18.30.45.jpeg". suggestNeutralName offers a plain
// replacement; Slynk never renames a file without asking.

// Camera and phone prefixes followed by a number: IMG_1234, IMG_E1234 (an
// edited iPhone photo), DSC_0001, PXL_2024..., WIN_2024... (Windows Camera).
const DEVICE = /^(IMG_E|IMG|VID|PXL|MVIMG|PANO|BURST\d*|DSC[NF0]?|_DSC|MOV|MVI|GOPR|G[HXP]\d\d|DJI|AUD|PTT|WIN)[-_ ]?\d/i
// Prefixes that are also ordinary words need the camera's exact form: SAM_1234, WP_20240612.
const DEVICE_EXACT = /^(SAM_\d{4}|WP_\d{8})/i
// WhatsApp's names for files without one: DOC-20240612-WA0001, STK-20240612-WA0002.
const WHATSAPP = /^[A-Z]{3}-\d{8}-WA\d+$/i
// Panasonic and Olympus: P1000123.JPG, P6120001.JPG.
const LETTER_DIGITS = /^P[0-9A-C]\d{6}$/
// App-made names that carry a date or a long ID, scanner apps included:
// "Scan 2024-06-12 at 18.30", "CamScanner 06-12-2024 18.30", "Adobe Scan 12 Jun 2024".
const APPS =
  /^(Screenshot|Screen ?Shot|Screen Recording|Screenrecorder|Screencast|Capture d.?(é|e)cran|Bildschirmfoto|Schermafbeelding|Captura de pantalla|Captura|Skärmavbild|Zrzut ekranu|WhatsApp (Image|Video|Audio|Ptt|Document)|Signal|photo|video|Snapchat|FB_IMG|received|InShot|Recording|Voice|Photo|Image|Movie|Telegram|Scanned|Scan|CamScanner|Adobe Scan|Genius Scan|Xerox Scan|Office Lens|Microsoft Lens)(?![A-Za-z])/i
// Office printers and copiers that name a scan after the device and the time:
// Konica Minolta's SKM_C28724061218300 and SKMBT_C55024061218300 (scan, model,
// then date and time), Kyocera's Doc20240612183045, and Brother's device name,
// BRN or BRW plus its network address, which some setups put in the name.
const PRINTER = /^(SKM(BT)?_[A-Z0-9]*\d{10}|doc[-_]?\d{8,}|BR[NW][0-9A-F]{12}(?![0-9A-F]))/i
const DATE = /(19|20)\d\d[-_.]?(0[1-9]|1[0-2])[-_.]?(0[1-9]|[12]\d|3[01])/
// Day-first or month-first dates, as in Photo Booth's "Photo on 12-06-2024 at 18.30".
const SHORT_DATE = /\b\d{1,2}[-./]\d{1,2}[-./]\d{2,4}\b/
// Dates with the month spelled out, as scanner apps write them: "12 Jun 2024", "June 12, 2024".
const MONTH = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?'
const MONTH_DATE = new RegExp(`\\b(\\d{1,2}[ _-]${MONTH},?[ _-](19|20)\\d\\d|${MONTH}[ _-]\\d{1,2},?[ _-](19|20)\\d\\d)\\b`, 'i')
const LONG_NUMBER = /\d{9,}/

const KINDS: [RegExp, string][] = [
  [/^(jpe?g|png|heic|heif|webp|gif|avif|tiff?|dng|bmp|jxl)$/i, 'photo'],
  [/^(mp4|mov|m4v|3gp|mkv|webm|avi)$/i, 'video'],
  [/^(mp3|m4a|aac|ogg|oga|opus|wav|flac|amr)$/i, 'audio'],
  [/^(pdf|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt)$/i, 'document'],
]

function split(name: string): [string, string] {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? [name.slice(0, dot), name.slice(dot + 1)] : [name, '']
}

/** Bare timestamps such as 20240612_183045 or 2024-06-12 18.30.45. */
function bareTimestamp(stem: string): boolean {
  const digits = stem.replace(/\D/g, '')
  return DATE.test(stem) && digits.length >= 8 && /^[\d\s_.:,()-]*$/.test(stem.replace(/^(IMG|VID|WA)|WA\d+$/gi, ''))
}

/** A neutral name such as "photo.jpg" when the name leaks a time or device, else null. */
export function suggestNeutralName(name: string): string | null {
  const base = name.replace(/^.*[\\/]/, '')
  const [stem0, ext] = split(base)
  // Motion photos add ".MP" before the extension: PXL_..._123.MP.jpg
  const stem = stem0.replace(/\.(MP|LS|PORTRAIT|NIGHT)$/i, '')
  const leaky =
    DEVICE.test(stem) ||
    DEVICE_EXACT.test(stem) ||
    WHATSAPP.test(stem) ||
    LETTER_DIGITS.test(stem) ||
    PRINTER.test(stem) ||
    (APPS.test(stem) && (DATE.test(stem) || SHORT_DATE.test(stem) || MONTH_DATE.test(stem) || LONG_NUMBER.test(stem))) ||
    bareTimestamp(stem)
  if (!leaky) return null
  let kind = KINDS.find(([re]) => re.test(ext))?.[1] ?? 'file'
  if (/^(Screen|Capture|Bildschirmfoto|Schermafbeelding|Captura|Skärmavbild|Zrzut)/i.test(stem)) {
    kind = kind === 'video' || /record|cast/i.test(stem) ? 'screen-recording' : 'screenshot'
  }
  const out = ext ? `${kind}.${ext}` : kind
  return out === base ? null : out
}
