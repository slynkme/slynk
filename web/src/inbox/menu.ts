// A small menu for the inbox's screens: a button that opens a list of
// actions under it, so the rarer ones don't crowd the screen. Keyboard: the
// arrow keys move between items, Home and End jump, Escape or Tab closes it
// (Escape returns to the button). A click outside closes it too. Styles only
// through classes (the page's rules forbid inline styles).

export interface MenuItem {
  label: string
  /** Text for screen readers when the label alone isn't enough. */
  aria?: string
  /** A heading for the items after it, not an action (e.g. "Move to"). */
  heading?: boolean
  /** Red text: removing something. */
  danger?: boolean
  run?: () => void
}

let openMenu: { button: HTMLButtonElement; panel: HTMLElement } | undefined

function close(refocus: boolean) {
  const m = openMenu
  if (!m) return
  openMenu = undefined
  m.panel.closest('.card')?.classList.remove('menu-open')
  m.panel.hidden = true
  m.panel.replaceChildren()
  m.button.setAttribute('aria-expanded', 'false')
  if (refocus) m.button.focus()
}

document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.panel.contains(e.target as Node) && !openMenu.button.contains(e.target as Node)) close(false)
})

/**
 * Makes button open a menu in panel (an empty element beside it), with the
 * items items() gives at that moment.
 */
export function attachMenu(button: HTMLButtonElement, panel: HTMLElement, items: () => MenuItem[]) {
  button.setAttribute('aria-haspopup', 'true')
  button.setAttribute('aria-expanded', 'false')
  panel.setAttribute('role', 'menu')
  panel.hidden = true
  const actions = () => [...panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]

  function open(focusLast = false) {
    close(false)
    panel.replaceChildren(
      ...items().map((item) => {
        if (item.heading) {
          const h = document.createElement('p')
          h.className = 'menu-heading'
          h.setAttribute('role', 'presentation')
          h.textContent = item.label
          return h
        }
        const b = document.createElement('button')
        b.type = 'button'
        b.className = item.danger ? 'menu-item danger' : 'menu-item'
        b.setAttribute('role', 'menuitem')
        b.tabIndex = -1
        b.textContent = item.label
        if (item.aria) b.setAttribute('aria-label', item.aria)
        b.addEventListener('click', () => {
          close(true)
          item.run?.()
        })
        return b
      }),
    )
    panel.hidden = false
    // Above the cards after this one, which would otherwise cover it.
    panel.closest('.card')?.classList.add('menu-open')
    button.setAttribute('aria-expanded', 'true')
    openMenu = { button, panel }
    const all = actions()
    all[focusLast ? all.length - 1 : 0]?.focus()
  }

  button.addEventListener('click', () => (openMenu?.button === button ? close(true) : open()))
  button.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      open(e.key === 'ArrowUp')
    } else if (e.key === 'Escape' && openMenu?.button === button) {
      e.stopPropagation()
      close(true)
    }
  })
  panel.addEventListener('keydown', (e) => {
    const all = actions()
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    const go = (i: number) => all[(i + all.length) % all.length]?.focus()
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(all.length - 1)
    else if (e.key === 'Escape') {
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') return close(false) // the focus moves on as usual
    else return
    e.preventDefault()
  })
}

/** Closes whatever menu is open: the screen under it is being redrawn. */
export const closeMenus = () => close(false)
