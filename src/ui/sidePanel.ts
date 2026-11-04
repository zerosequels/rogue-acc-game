/**
 * sidePanel.ts — the panel beside the board. Two modes, one place.
 *
 *   FEED    while a round runs: fake industry headlines, reacting to how the
 *           benchmark is going. Pure flavour, but it puts the chamber inside
 *           an industry rather than a vacuum.
 *
 *   MARKET  between rounds: the shop, docked rather than full-screen.
 *
 * Docking the shop is what makes the hover preview possible at all. A
 * full-screen sheet covers the board, so there is nowhere to show which
 * weights a purchase would hit. With the panel beside the net, hovering an
 * item lights its real targets — the player gets full information about a
 * selection that stays random.
 */

import { PRECISION_LABEL } from '../config/shop'
import type { Offer } from '../core/shopkeeper'
import { rerollPrice } from '../core/shopkeeper'
import type { RunState } from '../core/state'
import { nextHeadline, type Headline } from '../flavor/news'
import type { Board } from '../sim/board'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Side panel element #${id} missing from index.html`)
  return node as T
}

export interface MarketHandlers {
  buy: (offer: Offer) => void
  reroll: () => void
  leave: () => void
  /** Hovering an item: show what it would hit. */
  hover: (offer: Offer | null) => void
  /** Human-readable summary of what the hovered item would hit. */
  describe: (offer: Offer) => string
}

export class SidePanel {
  private root = el('side')
  private title = el('side-title')
  private sub = el('side-sub')
  private body = el('side-body')

  private headlines: Headline[] = []
  private nextAt = 0
  private message: { text: string; ok: boolean } | null = null

  // -------------------------------------------------------------------------
  // Feed mode
  // -------------------------------------------------------------------------

  showFeed(): void {
    this.root.classList.remove('market')
    this.title.textContent = 'Feed'
    this.sub.textContent = 'live'
    this.message = null
    if (this.headlines.length === 0) this.body.replaceChildren()
  }

  /** Called each frame while a round is live. Posts on an interval. */
  tickFeed(time: number, run: RunState): void {
    if (this.root.classList.contains('market')) return
    if (time < this.nextAt) return
    // First post lands almost immediately so the panel is never empty.
    this.nextAt = time + (this.nextAt === 0 ? 1.2 : 5.5 + Math.random() * 4.5)

    const rng = run.flavorRng(`news-${Math.floor(time * 10)}`)
    const h = nextHeadline(rng, {
      activations: run.activations,
      allowance: run.benchmarkActivations,
      progress: run.progress,
    })
    this.post(h)
  }

  private post(h: Headline): void {
    for (const child of Array.from(this.body.children)) child.classList.add('old')
    const node = document.createElement('div')
    node.className = 'news'
    node.dataset.tone = h.tone
    const src = document.createElement('div')
    src.className = 'src'
    src.textContent = h.source
    const txt = document.createElement('div')
    txt.className = 'txt'
    txt.textContent = h.text
    node.append(src, txt)
    this.body.prepend(node)
    this.headlines.push(h)
    while (this.body.children.length > 14) this.body.lastElementChild?.remove()
  }

  resetFeed(): void {
    this.headlines = []
    this.nextAt = 0
    this.body.replaceChildren()
  }

  // -------------------------------------------------------------------------
  // Market mode
  // -------------------------------------------------------------------------

  showMarket(run: RunState, board: Board, stock: Offer[], rerolls: number, on: MarketHandlers): void {
    this.root.classList.add('market')
    this.title.textContent = 'Market'
    this.sub.textContent = `${run.benchmark.roundName}`
    this.body.replaceChildren()

    const wallet = document.createElement('div')
    wallet.className = 'side-wallet'
    const cash = document.createElement('span')
    cash.className = 'cash'
    cash.textContent = `$${run.money}`
    const note = document.createElement('span')
    note.className = 'note'
    note.textContent = 'hover an item to see what it hits'
    wallet.append(cash, note)
    this.body.append(wallet)

    if (this.message) {
      const m = document.createElement('div')
      m.className = this.message.ok ? 'side-msg' : 'side-msg bad'
      m.textContent = this.message.text
      this.body.append(m)
    }

    stock.forEach((offer, i) => {
      this.body.append(this.card(offer, i, run, on))
    })

    const actions = document.createElement('div')
    actions.className = 'side-actions'
    const price = rerollPrice(rerolls)
    const roll = this.button(`REROLL $${price}`, () => {
      if (run.money >= price) { run.money -= price; on.reroll() }
    }, run.money < price)
    const go = this.button('CONTINUE ▸', on.leave)
    actions.append(roll, go)
    this.body.append(actions)

    void board
  }

  private card(offer: Offer, i: number, run: RunState, on: MarketHandlers): HTMLElement {
    const { def } = offer
    const affordable = run.canAfford(offer.price) && !offer.sold

    const node = document.createElement('div')
    node.className = `side-card${affordable ? '' : ' poor'}`
    node.dataset.prec = def.precision

    const slug = document.createElement('div')
    slug.className = 'slug'
    slug.textContent = `CH_${String(i).padStart(2, '0')} · ${def.effect.kind.replace('-', '_').toUpperCase()}`

    const row = document.createElement('div')
    row.className = 'row'
    const name = document.createElement('div')
    name.className = 'cname'
    name.textContent = def.name
    const price = document.createElement('div')
    price.className = 'price'
    price.textContent = offer.sold ? 'SOLD' : `$${offer.price}`
    row.append(name, price)

    const desc = document.createElement('div')
    desc.className = 'cdesc'
    desc.textContent = def.flavor

    const tag = document.createElement('div')
    tag.className = 'ptag'
    tag.textContent = `${def.precision} · ${PRECISION_LABEL[def.precision]}`

    const hint = document.createElement('div')
    hint.className = 'hint'

    node.append(slug, row, desc, tag, hint)

    node.addEventListener('mouseenter', () => {
      on.hover(offer)
      hint.textContent = on.describe(offer)
    })
    node.addEventListener('mouseleave', () => {
      on.hover(null)
      hint.textContent = ''
    })
    if (affordable) node.addEventListener('click', () => on.buy(offer))
    return node
  }

  private button(label: string, onClick: () => void, disabled = false): HTMLElement {
    const b = document.createElement('button')
    b.className = `btn${disabled ? ' off' : ''}`
    b.textContent = label
    if (!disabled) b.addEventListener('click', onClick)
    return b
  }

  setMessage(text: string, ok: boolean): void {
    this.message = { text, ok }
  }
}
