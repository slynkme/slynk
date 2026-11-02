// The site's name and address in its pages (src/site.ts SITE_NAME and
// SITE_ADDRESS), put in at build time (vite.config.ts). The pages are written
// for slynk.me, with "Slynk" and "slynk.me" wherever the site's name and
// address go; a fork's build puts its own in their place, everywhere but in
// comments. For slynk.me's own build nothing changes. (The page's scripts take
// them from src/site.ts; licenses.txt keeps Slynk's name, as its credits.)

/** "Slynk" as a word ("Slynk’s" too), never part of another ("slynk-sees", "SlynkCore"). */
const NAME = /\bSlynk\b/g
/** "slynk.me" as an address, never part of another ("k.slynk.me", "slynk.me.example"). */
const ADDRESS = /(?<![\w.-])slynk\.me(?![\w-]|\.\w)/g
const COMMENT = /(<!--[\s\S]*?-->)/

/** Refuses a name or address that would break the pages or the links, so a typo stops the build. */
export function checkSiteName(name: string, address: string) {
  if (!name.trim() || name !== name.trim() || /[<>&"'`\p{Cc}]/u.test(name)) throw new Error(`src/site.ts SITE_NAME: ${JSON.stringify(name)}`)
  // A host name as browsers write it: lower case, with a dot, no port or path (links are https://ADDRESS/#…).
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(address)) {
    throw new Error(`src/site.ts SITE_ADDRESS isn't a host name like "slynk.me": ${JSON.stringify(address)}`)
  }
}

/** html with the site's name and address in place of Slynk's, outside comments. */
export function fillSiteName(html: string, name: string, address: string): string {
  checkSiteName(name, address)
  return html
    .split(COMMENT)
    .map((part, i) => (i % 2 ? part : part.replace(NAME, () => name).replace(ADDRESS, () => address)))
    .join('')
}
