// Small DOM helpers shared by the inbox's screens.
import * as copy from './inboxCopy'
import type { Part } from './inboxCopy'

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
export const part = (root: Element, name: string) => root.querySelector<HTMLElement>(`[data-part="${name}"]`)!
export const clone = (template: string) => $<HTMLTemplateElement>(template).content.firstElementChild!.cloneNode(true) as HTMLElement

/**
 * Fills every element marked data-copy="NAME" with that text from
 * inboxCopy.ts, and labels every one marked data-copy-label="NAME" with it
 * (an icon button's label is its tooltip too).
 */
export function fillCopy(root: ParentNode = document) {
  const texts = copy as unknown as Record<string, unknown>
  root.querySelectorAll<HTMLElement>('[data-copy]').forEach((el) => {
    const text = texts[el.dataset.copy!]
    if (typeof text === 'string') el.textContent = text
  })
  root.querySelectorAll<HTMLElement>('[data-copy-label]').forEach((el) => {
    const text = texts[el.dataset.copyLabel!]
    if (typeof text !== 'string') return
    el.setAttribute('aria-label', text)
    if (el instanceof HTMLButtonElement) el.title = text
  })
}

/** Copies text, or selects el's text so it can be copied by hand. */
export async function copyText(text: string, done: string, toast: (t: string) => void, el?: HTMLInputElement) {
  try {
    await navigator.clipboard.writeText(text)
    toast(done)
  } catch {
    el?.select()
    toast('Press Ctrl+C to copy')
  }
}

/** Fills el with text, each name isolated in a <bdi> so it can't reorder the words around it. */
export function fillParts(el: HTMLElement, parts: Part[]) {
  el.replaceChildren(
    ...parts.map((p) => {
      if (typeof p === 'string') return document.createTextNode(p)
      const b = document.createElement('bdi')
      b.className = 'given-name'
      b.textContent = p.name
      return b
    }),
  )
}

/** The same text, plain (for a screen reader's label, say). */
export const plainParts = (parts: Part[]) => parts.map((p) => (typeof p === 'string' ? p : p.name)).join('')

/**
 * A name set apart in plain text (a toast, a button, a title), where a
 * <bdi> can't go: between first-strong and pop isolates, so a right-to-left
 * name can't reorder the words around it.
 */
export const isolate = (name: string) => `${String.fromCharCode(0x2068)}${name}${String.fromCharCode(0x2069)}`

/**
 * A row of tabs (role="tablist"): a click, or the arrow, Home and End keys,
 * picks one. The caller marks the one shown with selectTab.
 */
export function wireTabs(list: HTMLElement, pick: (tab: HTMLButtonElement) => void) {
  const tabs = () => [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  list.addEventListener('click', (e) => {
    const tab = (e.target as Element).closest<HTMLButtonElement>('[role="tab"]')
    if (tab) pick(tab)
  })
  list.addEventListener('keydown', (e) => {
    const all = tabs()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: all.length - 1 }[e.key]
    if (to === undefined) return
    e.preventDefault()
    const tab = all[(to + all.length) % all.length]
    pick(tab)
    tab.focus()
  })
}

/** Marks the tab shown: selected, and the one the Tab key reaches. */
export function selectTab(list: HTMLElement, tab: HTMLElement) {
  for (const t of list.querySelectorAll<HTMLElement>('[role="tab"]')) {
    const on = t === tab
    t.setAttribute('aria-selected', String(on))
    t.tabIndex = on ? 0 : -1
  }
}
