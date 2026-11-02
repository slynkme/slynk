// "While you wait" facts, shown during transfers. Keep them accurate:
// people will quote them. {nodes} becomes the live node count.
import { SITE_ADDRESS, SITE_NAME } from '../site.ts'

export const FACTS = [
  `What you send is locked with a key that exists only in the link. Without the link, nobody can open it, not even ${SITE_ADDRESS} or the xx network.`,
  `Unlike most messaging apps and cloud drives, ${SITE_NAME} needs no account, phone number or email.`,
  'The xx network, which carries your data, uses cMix, created by David Chaum and colleagues. Chaum invented mix networks in 1981.',
  'A mixnet shuffles a whole batch of messages together and keeps the shuffle secret.',
  'Most encrypted apps protect what you say. A mixnet also aims to keep who’s talking to whom private, and gets better the more people use it.',
  'Your data travels in pieces of about 900 bytes, every one exactly the same size, so no single piece stands out.',
  'This tab made a brand-new mixnet identity just for this visit. It lives only in memory and vanishes with the tab.',
  `The secret part of a ${SITE_NAME} link, everything after the #, is never sent to ${SITE_ADDRESS}: browsers leave it out when they load a page.`,
  'The xx network holds the pieces for up to three weeks, so the recipient doesn’t need to be online when you send.',
  '{nodes} nodes, run by operators around the world, make up the xx mixnet right now.',
  'The xx network can see that you’re using it, but never what you send.',
  `${SITE_NAME} removes details hidden inside most photos, videos and documents, like where a photo was taken. You can turn this off in Settings.`,
  'Every piece is encrypted and authenticated, and the whole file is checked against the link before it’s handed over.',
  `${SITE_NAME} never sees what you send. It goes from your browser straight into the mixnet.`,
]

// While a message goes to an anonymous inbox. There's no link, so nothing
// about keys in links or files; and an inbox's address is public, so
// nothing about keeping who's talking to whom private either.
export const INBOX_FACTS = [
  `Your message is sealed so that only the inbox’s owner can open it. Not ${SITE_ADDRESS}, and not the xx network.`,
  'It travels as a single piece, exactly the same size as every other, so its length gives nothing away.',
  FACTS[1],
  FACTS[2],
  FACTS[3],
  FACTS[6],
  FACTS[9],
  FACTS[10],
  FACTS[13],
]

// While a message goes to an inbox's quantum-safe address: two
// pieces a few seconds apart, each in a round of its own (always,
// since 2026-10-19), sealed to resist a future quantum computer too.
export const INBOX_FACTS_QS = [
  'Your message is sealed so that only the inbox’s owner can open it, in a way built to stay safe even against the quantum computers of the future.',
  'It travels as two pieces a few seconds apart, each exactly the same size as every other, so its length gives nothing away.',
  FACTS[1],
  FACTS[2],
  FACTS[3],
  FACTS[6],
  FACTS[9],
  FACTS[10],
  FACTS[13],
]

// While a message goes with reply keys the inbox gave: sealed to
// resist a future quantum computer too, in a single piece.
export const INBOX_FACTS_REPLY = [INBOX_FACTS_QS[0], ...INBOX_FACTS.slice(1)]

// While files or a longer message go to an inbox (INBOX_FILES, site.ts). An
// upload is many pieces, so not the single-piece fact; its key travels only
// inside the notice sealed to the inbox, so still nothing about links.
export const INBOX_UPLOAD_FACTS = [
  `What you send is sealed so that only the inbox’s owner can open it. Not ${SITE_ADDRESS}, and not the xx network.`,
  FACTS[1],
  FACTS[2],
  FACTS[3],
  FACTS[5],
  FACTS[6],
  FACTS[9],
  FACTS[10],
  FACTS[11],
  FACTS[13],
]

const INTERVAL_MS = 9000

/** Rotates shuffled facts into `el` until the returned stop function is called. */
export function rotateFacts(el: HTMLElement, nodeCount: () => number | undefined, facts: string[] = FACTS): () => void {
  const order = shuffle(facts.map((_, i) => i))
  let i = 0
  let fadeTimer = 0
  const show = () => {
    const fact = facts[order[i++ % order.length]].replace('{nodes}', String(nodeCount() ?? 'Around 180'))
    el.classList.add('fading')
    fadeTimer = window.setTimeout(() => {
      el.textContent = fact
      el.classList.remove('fading')
    }, 250)
  }
  show()
  const timer = window.setInterval(show, INTERVAL_MS)
  return () => {
    window.clearInterval(timer)
    window.clearTimeout(fadeTimer)
  }
}

function shuffle<T>(a: T[]): T[] {
  const r = new Uint32Array(a.length)
  crypto.getRandomValues(r)
  for (let i = a.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}
