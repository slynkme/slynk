// Parts of the pages that depend on one of the site's rules (src/site.ts
// ONE_TIME_ONLY, INBOX_FILES and VISIT_LOGS), chosen at build time (vite.config.ts), so
// a fork that changes a rule gets wording that's true for it. Written as
//   <!-- when ONE_TIME_ONLY -->said with the rule on<!-- else -->with it off<!-- /when -->
//   <!-- when !INBOX_FILES -->said only with the switch off<!-- /when -->
// inside a line or around whole lines; a marker alone on its line goes with
// its line. Parts can't be nested.

export interface Rules {
  ONE_TIME_ONLY: boolean
  INBOX_FILES: boolean
  VISIT_LOGS: boolean
}

// A marker alone on its line: the line goes with it.
const MARKER_LINE = /^[ \t]*(<!-- (?:when !?[A-Z_]+|else|\/when) -->)[ \t]*\n/gm
const PART = /<!-- when (!?)([A-Z_]+) -->([\s\S]*?)(?:<!-- else -->([\s\S]*?))?<!-- \/when -->/g

/** html with each rule's part chosen: what's true with the site's rules. */
export function fillRules(html: string, rules: Rules): string {
  const out = html.replace(MARKER_LINE, '$1').replace(PART, (_whole, not: string, rule: string, on: string, off = '') => {
    if (!(rule in rules)) throw new Error(`<!-- when ${rule} -->: no such rule in src/site.ts`)
    if (/<!-- (when|else)\b/.test(on + off)) throw new Error(`<!-- when ${rule} -->: parts can’t be nested`)
    return rules[rule as keyof Rules] !== !!not ? on : off
  })
  // Anything written another way would reach the page with both versions.
  if (/<!--\s*(when\b|else\s*-->|\/when\s*-->)/.test(out)) throw new Error('a rule’s part isn’t written as scripts/rules.ts expects')
  return out
}
