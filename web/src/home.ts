// Where this page's key server is, and the address its links begin with.
// Links and inbox addresses made here are the site's (site.ts SITE_URL),
// whatever address the page itself is at: in a copy downloaded and run on
// one's own computer (site.ts LOCAL_ORIGIN) they still begin
// https://slynk.me/#, so anyone can open them. Decided as the page runs, so
// the downloaded files are exactly the site's. Development and test builds,
// whose key server is the page's own, keep the page's address.
import { KEY_SERVER, SITE_URL } from './site.ts'

/**
 * Where the key server is: the site's own (site.ts), or in local development
 * /api/k, which Vite passes on to a key server run with -dev on port 8099. A
 * build may set VITE_KEY_SERVER instead, to test against another.
 */
export const ENDPOINT: string = import.meta.env?.VITE_KEY_SERVER || (import.meta.env?.DEV ? '/api/k' : KEY_SERVER)

/**
 * What every link and inbox address made here begins with, before /#: the
 * site's address, or the page's own where its key server is on the page's own
 * address (/api/k), since that's where its links' halves are kept.
 */
export const LINK_ORIGIN: string = ENDPOINT.startsWith('/') && typeof location !== 'undefined' ? location.origin : SITE_URL

/** This site's own origins: where its links point, and where this page is (the same, but in a downloaded copy). */
export const homeOrigins = (): string[] => (typeof location === 'undefined' ? [LINK_ORIGIN] : [LINK_ORIGIN, location.origin])
