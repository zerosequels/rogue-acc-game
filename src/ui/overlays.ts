/**
 * overlays.ts — the full-screen sheets between passes.
 *
 * Four moments: the benchmark brief, the clear screen, the shop, and the run
 * end. Each is built fresh and torn down, which keeps state handling trivial
 * at the cost of a few element allocations — nowhere near a frame budget
 * concern, since the board is paused while any of these is up.
 *
 * Keyboard parity throughout: every sheet is fully operable with number keys
 * and Enter. A game played at the keyboard should never force a reach for
 * the mouse.
 */

import { ECONOMY } from '../config/balance'
import { totalBenchmarks } from '../config/rounds'
import { PRECISION_LABEL, SHOP, type Band, type Precision } from '../config/shop'
import type { ClearReward, RunState } from '../core/state'
import type { Offer } from '../core/shopkeeper'
import { bucketCandidates, cardCandidates, nodeCandidates, rerollPrice } from '../core/shopkeeper'
import { clearLine, failLine, pressureLine, VICTORY_LINE } from '../flavor/text'
import type { Board } from '../sim/board'
import { cardLabel } from '../sim/deck'
import { fmt } from './hud'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Overlay element #${id} missing from index.html`)
  return node as T
}

export interface ShopHandlers {
  buy: (offer: Offer) => void
  reroll: () => void
  leave: () => void
}

export class Overlays {
  private overlay = el('overlay')
  private sheet = el('sheet')
  private keyHandler: ((e: KeyboardEvent) => void) | null = null
  private message: { text: string; ok: boolean } | null = null

  get isOpen(): boolean { return this.overlay.classList.contains('on') }

  private open(): void { this.overlay.classList.add('on') }

  close(): void {
    this.overlay.classList.remove('on')
    this.sheet.replaceChildren()
    this.message = null
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler)
      this.keyHandler = null
    }
  }

  private bindKeys(handler: (e: KeyboardEvent) => void): void {
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler)
    this.keyHandler = handler
    window.addEventListener('keydown', handler)
  }

  // -------------------------------------------------------------------------
  // Benchmark brief
  // -------------------------------------------------------------------------

  brief(run: RunState, board: Board, onBegin: () => void): void {
    const bm = run.benchmark
    const boss = run.boss
    this.sheet.replaceChildren()

    this.sheet.append(
      h('h1', { class: 'fringe' }, [txt(`${bm.roundName} — `), span('cyan', bm.name)]),
      h('h2', {}, [txt(`benchmark ${run.benchmarkIndex + 1} of ${totalBenchmarks()} · ${board.architecture}`)]),
    )

    if (boss) {
      this.sheet.append(
        h('div', { class: 'boss-call' }, [
          h('div', { class: 'boss-name' }, [boss.name]),
          h('div', { class: 'boss-desc' }, [boss.description]),
        ]),
      )
    } else {
      this.sheet.append(
        h('div', { class: 'flavor' }, [
          txt(pressureLine(run.flavorRng('pressure'), run.activations, run.benchmarkActivations)),
        ]),
      )
    }

    this.sheet.append(
      statGrid([
        ['Target', fmt(run.target), boss?.targetMult && boss.targetMult > 1 ? 'bad' : ''],
        ['Activations', `${run.benchmarkActivations}`, boss?.activationMult && boss.activationMult < 1 ? 'bad' : ''],
        ['Capital', `$${run.money}`, 'mag'],
        ['Corpus', `${run.deck.size} cards`, ''],
        ['Payout', `$${bm.payout}`, 'ok'],
      ]),
      button('ENGAGE  ▸', onBegin),
    )

    this.open()
    this.bindKeys((e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBegin() }
    })
  }

  // -------------------------------------------------------------------------
  // Benchmark cleared
  // -------------------------------------------------------------------------

  cleared(run: RunState, reward: ClearReward, onContinue: () => void): void {
    const bm = run.benchmark
    this.sheet.replaceChildren()
    this.sheet.append(
      h('h1', { class: 'fringe' }, [span('ok', 'BENCHMARK EXCEEDED')]),
      h('h2', {}, [txt(`${bm.roundName} · ${bm.name}`)]),
      h('div', { class: 'flavor' }, [txt(clearLine(run.flavorRng('clear'), run.score, run.target))]),
      this.payoutTable(run, reward),
      button('ENTER THE MARKET  ▸', onContinue),
    )
    this.open()
    this.bindKeys((e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onContinue() }
    })
  }

  /** Itemised, because interest is the part players need to learn exists. */
  private payoutTable(run: RunState, r: ClearReward): HTMLElement {
    const rows: [string, string, string][] = [
      ['Benchmark met', `+$${r.base}`, 'ok'],
      ['Overshoot', r.overshoot > 0 ? `+$${r.overshoot}` : '—', r.overshoot > 0 ? 'amb' : 'dimv'],
      ['Unspent activations', r.unspent > 0 ? `+$${r.unspent}` : '—', r.unspent > 0 ? 'cyan' : 'dimv'],
      [`Interest (cap $${ECONOMY.interestCap})`, r.interest > 0 ? `+$${r.interest}` : '—', r.interest > 0 ? 'lime' : 'dimv'],
      ['Capital', `$${run.money}`, 'mag'],
    ]
    const grid = h('div', { class: 'stat-grid' }, [])
    for (const [label, value, cls] of rows) {
      grid.append(h('div', { class: 'stat' }, [
        h('div', { class: 'label' }, [label]),
        h('div', { class: `val ${cls}` }, [value]),
      ]))
    }
    const wrap = h('div', {}, [
      h('div', { class: 'score-line' }, [
        txt(`${fmt(run.score)} against ${fmt(run.target)} — `),
        span(r.ratio >= 2 ? 'amb' : 'ok', `${Math.round((r.ratio - 1) * 100)}% over`),
      ]),
      grid,
    ])
    return wrap
  }

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------

  shop(run: RunState, board: Board, stock: Offer[], rerolls: number, on: ShopHandlers): void {
    this.sheet.replaceChildren()
    const reroll = rerollPrice(rerolls)

    this.sheet.append(
      h('h1', { class: 'fringe' }, [txt('Capital allocation')]),
      h('h2', {}, [
        txt('precision costs money — a blind upgrade is cheap, naming the target is not'),
      ]),
      h('div', { class: 'wallet' }, [
        h('span', { class: 'cash' }, [`$${run.money}`]),
        h('span', { class: 'cashnote' }, [
          `one dollar is one billion dollars · interest pays $1 per $${ECONOMY.interestPer} held, capped at $${ECONOMY.interestCap}`,
        ]),
      ]),
    )

    if (this.message) {
      this.sheet.append(
        h('div', { class: this.message.ok ? 'shop-msg ok' : 'shop-msg bad' }, [this.message.text]),
      )
    }

    const grid = h('div', { id: 'shop-grid' }, [])
    stock.forEach((offer, i) => {
      grid.append(this.shopCard(offer, i, run, board, on))
    })
    this.sheet.append(grid)

    const controls = h('div', { class: 'shop-controls' }, [])
    const rerollBtn = button(`REROLL STOCK  $${reroll}`, () => {
      if (run.money >= reroll) { run.money -= reroll; on.reroll() }
    }, run.money < reroll)
    controls.append(rerollBtn, button('CONTINUE  ▸', on.leave))
    this.sheet.append(controls, this.deckStrip(run))

    this.open()
    this.bindKeys((e) => {
      const n = Number(e.key)
      if (n >= 1 && n <= stock.length) {
        e.preventDefault()
        const offer = stock[n - 1]!
        if (!offer.sold && run.canAfford(offer.price)) this.beginBuy(offer, run, board, on)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        on.leave()
      }
    })
  }

  private shopCard(offer: Offer, i: number, run: RunState, board: Board, on: ShopHandlers): HTMLElement {
    const { def } = offer
    const affordable = run.canAfford(offer.price) && !offer.sold
    const card = h('div', {
      class: `shop-card${offer.sold ? ' sold' : ''}${affordable ? '' : ' poor'}`,
      'data-prec': def.precision,
    }, [
      h('div', { class: 'slug' }, [channelSlug(def, i)]),
      h('div', { class: 'prec' }, [
        h('span', { class: 'prec-tag' }, [def.precision]),
        h('span', { class: 'prec-note' }, [PRECISION_LABEL[def.precision]]),
      ]),
      h('div', { class: 'cname' }, [def.name]),
      h('div', { class: 'cdesc' }, [effectText(def.effect, board)]),
      h('div', { class: 'cflavor' }, [def.flavor]),
      h('div', { class: 'cfoot' }, [
        h('span', { class: 'price' }, [offer.sold ? 'SOLD' : `$${offer.price}`]),
        h('span', { class: 'ckey' }, [`press ${i + 1}`]),
      ]),
    ])
    if (affordable) card.addEventListener('click', () => this.beginBuy(offer, run, board, on))
    return bracket(card)
  }

  /**
   * Blind purchases apply immediately. Banded and precise ones first ask
   * where — that choice is literally what the extra money bought.
   */
  private beginBuy(offer: Offer, run: RunState, board: Board, on: ShopHandlers): void {
    if (offer.def.precision === 'blind') { on.buy(offer); return }
    if (offer.def.precision === 'banded') { this.pickBand(offer, on); return }
    this.pickTarget(offer, run, board, on)
  }

  private pickBand(offer: Offer, on: ShopHandlers): void {
    this.sheet.replaceChildren()
    this.sheet.append(
      h('h1', {}, [txt(offer.def.name)]),
      h('h2', {}, [txt('you paid to choose a band — which third of the network?')]),
    )
    const grid = h('div', { id: 'shop-grid' }, [])
    const bands: { id: Band; label: string; note: string }[] = [
      { id: 'upper', label: 'Upper layers', note: 'closest to the launcher — feeds the most hops downstream' },
      { id: 'middle', label: 'Middle layers', note: 'balanced: decent traffic, decent reach' },
      { id: 'lower', label: 'Lower layers', note: 'heaviest traffic, but little left below it to carry signal' },
    ]
    bands.forEach((b, i) => {
      const card = h('div', { class: 'shop-card', 'data-prec': 'banded' }, [
        h('div', { class: 'cname' }, [b.label]),
        h('div', { class: 'cdesc' }, [b.note]),
        h('div', { class: 'cfoot' }, [h('span', { class: 'ckey' }, [`press ${i + 1}`])]),
      ])
      card.addEventListener('click', () => { offer.band = b.id; on.buy(offer) })
      grid.append(card)
    })
    this.sheet.append(grid)
    this.open()
    this.bindKeys((e) => {
      const n = Number(e.key)
      if (n >= 1 && n <= bands.length) {
        e.preventDefault()
        offer.band = bands[n - 1]!.id
        on.buy(offer)
      }
    })
  }

  private pickTarget(offer: Offer, run: RunState, board: Board, on: ShopHandlers): void {
    const kind = offer.def.effect.kind
    this.sheet.replaceChildren()
    this.sheet.append(
      h('h1', {}, [txt(offer.def.name)]),
      h('h2', {}, [txt('you paid to name the target — pick it')]),
    )

    const list = h('div', { class: 'target-list' }, [])

    if (kind === 'node-level' || kind === 'node-transform') {
      const pool = nodeCandidates(offer.def, board).slice(0, 60)
      for (const n of pool) {
        const row = h('button', { class: 'target-row' }, [
          h('span', { class: 'tid' }, [`#${n.id}`]),
          h('span', {}, [`layer ${n.layer}  ·  L${n.level}`]),
          h('span', { class: 'ttag' }, [n.transforms.join(' · ') || '—']),
        ])
        row.addEventListener('click', () => { offer.target = { kind: 'node', id: n.id }; on.buy(offer) })
        list.append(row)
      }
    } else if (kind === 'bucket-level' || kind === 'bucket-transform') {
      for (const p of bucketCandidates(offer.def, board)) {
        const row = h('button', { class: 'target-row' }, [
          h('span', { class: 'tid' }, [`TOK_${String(p.id).padStart(2, '0')}`]),
          h('span', {}, [`${p.kind}  ·  L${p.level}`]),
          h('span', { class: 'ttag' }, [p.transform ?? '—']),
        ])
        row.addEventListener('click', () => { offer.target = { kind: 'bucket', id: p.id }; on.buy(offer) })
        list.append(row)
      }
    } else {
      for (const c of cardCandidates(offer.def, run)) {
        const row = h('button', { class: 'target-row' }, [
          h('span', { class: 'tid' }, [`#${c.id}`]),
          h('span', {}, [cardLabel(c)]),
          h('span', { class: 'ttag' }, ['']),
        ])
        row.addEventListener('click', () => { offer.target = { kind: 'card', id: c.id }; on.buy(offer) })
        list.append(row)
      }
    }

    this.sheet.append(list)
    this.open()
  }

  private deckStrip(run: RunState): HTMLElement {
    const strip = h('div', { class: 'deck-strip' }, [])
    strip.append(h('div', { class: 'label' }, [`Corpus — ${run.deck.size} cards`]))
    const row = h('div', { class: 'deck-cards' }, [])
    for (const c of run.deck.cards) {
      row.append(h('span', { class: 'mini-card', 'data-type': c.type }, [cardLabel(c)]))
    }
    strip.append(row)
    return strip
  }

  shopMessage(text: string, ok: boolean): void {
    this.message = { text, ok }
  }

  // -------------------------------------------------------------------------
  // Run end
  // -------------------------------------------------------------------------

  runEnd(run: RunState, won: boolean, onRestart: () => void, onSameSeed: () => void): void {
    const t = run.totals
    this.sheet.replaceChildren()

    this.sheet.append(
      h('h1', { class: 'fringe' }, [span(won ? 'ok' : 'bad', won ? 'IPO' : 'THE BUBBLE POPS')]),
      h('h2', {}, [
        txt(won
          ? `all ${totalBenchmarks()} benchmarks exceeded · seed ${run.seed}`
          : `failed at ${run.benchmark.roundName} · ${run.benchmark.name} · seed ${run.seed}`),
      ]),
      h('div', { class: 'flavor' }, [
        txt(won ? VICTORY_LINE : failLine(run.flavorRng('end'))),
      ]),
      statGrid([
        ['Benchmarks cleared', `${won ? totalBenchmarks() : run.benchmarkIndex}`, won ? 'ok' : ''],
        ['Final capital', `$${run.money}`, 'mag'],
        ['Total score', fmt(t.totalScore), 'cyan'],
        ['Best pass', fmt(t.bestPass), 'amb'],
        ['Passes fired', `${t.passesFired}`, ''],
        ['Weights struck', fmt(t.pinsStruck), ''],
        ['Signal activations', fmt(t.signalsFired), 'cyan'],
        ['Spikes hit', `${t.spikesHit}`, 'mag'],
        ['Upgrades bought', `${t.itemsBought}`, 'lime'],
        ['Capital spent', `$${t.moneySpent}`, ''],
      ]),
      this.deckStrip(run),
      h('div', {}, [
        button('NEW RUN  ▸', onRestart),
        button('RETRY THIS SEED  ↺', onSameSeed, false, true),
      ]),
    )
    this.open()
    this.bindKeys((e) => { if (e.key === 'Enter') { e.preventDefault(); onRestart() } })
  }
}

// --- DOM helpers -----------------------------------------------------------

function effectText(e: Offer['def']['effect'], board?: Board): string {
  switch (e.kind) {
    case 'node-level': return e.count >= 999
      ? `+${e.amount} level to EVERY weight`
      : `+${e.amount} level to ${e.count === 1 ? 'one weight' : `${reach(e.count, board)} weights`}`
    case 'node-transform': return `${e.transform} on ${e.count === 1 ? 'one weight' : `${reach(e.count, board)} weights`}`
    case 'bucket-level': return `+${e.amount} level to ${e.count === 1 ? 'one output token' : `${e.count} output tokens`}`
    case 'bucket-transform': return `transform an output token → ${e.transform}`
    case 'card-level': return `+${e.amount} level to ${e.count === 1 ? 'one card' : `${e.count} cards`}`
    case 'card-transform': return `transform a card → ${e.transform}`
    case 'card-add': return `add ${e.count} ${e.cardType} cards to the corpus`
    case 'card-remove': return 'delete one card from the corpus'
    case 'activations': return `+${e.amount} activation${e.amount === 1 ? '' : 's'} every benchmark`
  }
}

/**
 * A telemetry slug for a shop card — the effect's target channel, in the same
 * register as the coordinate locks on the board.
 */
function channelSlug(def: Offer['def'], i: number): string {
  const ch = def.effect.kind.replace('-', '_').toUpperCase()
  return `CH_${String(i).padStart(2, '0')} · ${ch} · ${def.precision.toUpperCase()}`
}

/** Shop reach scales with the lattice, so the card must quote the real number. */
function reach(count: number, board?: Board): number {
  if (!board) return count
  const active = board.nodes.filter((n) => !n.removed).length
  return Math.max(1, Math.round(count * (active / SHOP.referenceNodes)))
}

/** Add instrument corner brackets to an element. */
function bracket(node: HTMLElement): HTMLElement {
  node.classList.add('bracketed')
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    const b = document.createElement('i')
    b.className = `bk ${corner}`
    node.append(b)
  }
  return node
}

function h(tag: string, attrs: Record<string, string>, children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return node
}
function txt(s: string): Text { return document.createTextNode(s) }
function span(cls: string, s: string): HTMLElement { return h('span', { class: cls }, [s]) }

function button(label: string, onClick: () => void, disabled = false, danger = false): HTMLElement {
  const b = h('button', { class: `btn${danger ? ' danger' : ''}${disabled ? ' off' : ''}` }, [label])
  if (danger) b.setAttribute('style', 'margin-left:10px')
  if (!disabled) b.addEventListener('click', onClick)
  return b
}

function statGrid(rows: [string, string, string][]): HTMLElement {
  const grid = h('div', { class: 'stat-grid' }, [])
  for (const [label, value, cls] of rows) {
    grid.append(h('div', { class: 'stat' }, [
      h('div', { class: 'label' }, [label]),
      h('div', { class: `val ${cls}` }, [value]),
    ]))
  }
  return grid
}

export type { Precision }
