// A list item's number as its document writes it: 1, 01,
// a, A, i or I. Others (Word's 23 kinds of Asian
// counting, say) show as plain numbers. Letters go on after z the way the
// document's app counts: Word repeats the letter (aa, bb), LibreOffice counts
// on (aa, ab) unless the list says to repeat. Very large numbers show as
// plain numbers, so a crafted list can't make a label of a million letters.

export type NumberFormat = 'decimal' | 'decimalZero' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman' | 'none'

const ROMAN: [number, string][] = [
  [1000, 'm'],
  [900, 'cm'],
  [500, 'd'],
  [400, 'cd'],
  [100, 'c'],
  [90, 'xc'],
  [50, 'l'],
  [40, 'xl'],
  [10, 'x'],
  [9, 'ix'],
  [5, 'v'],
  [4, 'iv'],
  [1, 'i'],
]

function roman(n: number): string {
  let s = ''
  for (const [v, r] of ROMAN) for (; n >= v; n -= v) s += r
  return s
}

function letters(n: number, repeat: boolean): string {
  if (repeat) return String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1)
  let s = ''
  for (; n > 0; n = Math.floor(n / 26)) s = String.fromCharCode(97 + (--n % 26)) + s
  return s
}

/** n in a list's number format; letters past z repeat (Word's way) unless repeat is false. */
export function formatNumber(n: number, fmt: string, repeat = true): string {
  n = Math.floor(n)
  switch (fmt) {
    case 'none':
      return ''
    case 'decimalZero':
      return n >= 0 && n < 10 ? `0${n}` : String(n)
    case 'lowerLetter':
    case 'upperLetter': {
      if (n < 1 || n > 780) return String(n)
      const s = letters(n, repeat)
      return fmt === 'upperLetter' ? s.toUpperCase() : s
    }
    case 'lowerRoman':
    case 'upperRoman': {
      if (n < 1 || n > 3999) return String(n)
      const s = roman(n)
      return fmt === 'upperRoman' ? s.toUpperCase() : s
    }
    default:
      return String(n)
  }
}
