// Links from a page to Slynk's published code (the About page's technical
// write-ups, say), filled in at build time (vite.config.ts). Each is written as
//   <p class="source-link" data-source="PATH"><a target="_blank" rel="noopener noreferrer">TEXT</a></p>
// While the code isn't published, link(PATH) is '' and the whole paragraph is
// left out, so the page never shows a dead link.

const PARAGRAPH = /[ \t]*<p class="source-link" data-source="([^"]*)"><a ([^>]*)>([^<]*)<\/a><\/p>\n?/g

/** html with each source link's address filled in by link(path), or left out where that's ''. */
export function fillSourceLinks(html: string, link: (path: string) => string): string {
  const out = html.replace(PARAGRAPH, (whole, path: string, attrs: string, text: string) => {
    const href = link(path)
    if (!href) return ''
    const indent = whole.match(/^[ \t]*/)![0]
    return `${indent}<p class="source-link"><a href="${href}" ${attrs}>${text}</a></p>\n`
  })
  // Anything written another way would reach the page unfilled.
  if (out.includes('data-source=')) throw new Error('a data-source link isn’t written as scripts/source-links.ts expects')
  return out
}
