// A page as slynk.me's build has it: each part that depends on a rule chosen
// for slynk.me's rules (scripts/rules.ts, src/site.ts). Its name and address
// need nothing: the pages are written with them.
import { readFileSync } from 'node:fs'
import { fillRules } from '../../scripts/rules.ts'
import { INBOX_FILES, ONE_TIME_ONLY, VISIT_LOGS } from '../../src/site.ts'

/** path is from web/, e.g. "about/index.html". */
export const sitePage = (path: string) => fillRules(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), { ONE_TIME_ONLY, INBOX_FILES, VISIT_LOGS })

/**
 * A page as one kind of visitor sees it: the website's (.on-web), or a copy on
 * one's own computer's (.on-local), with the other's words left out (style.css,
 * html[data-local]). Neither kind nests inside itself, so a lazy match finds its end.
 */
export function seenOn(html: string, where: 'web' | 'local' = 'web'): string {
  const other = where === 'web' ? 'on-local' : 'on-web'
  const mine = where === 'web' ? 'on-web' : 'on-local'
  return html
    .replace(new RegExp(`<(span|li|p)( class="${other}")[^>]*>[\\s\\S]*?</\\1>`, 'g'), '')
    .replace(new RegExp(`<span class="${mine}">([\\s\\S]*?)</span>`, 'g'), '$1')
    .replace(new RegExp(`<(li|p) class="${mine}"`, 'g'), '<$1')
}

/** sitePage as a visitor to the website sees it. */
export const sitePageOnWeb = (path: string) => seenOn(sitePage(path), 'web')
