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

import type { ClearReward, RunState } from '../core/state'
import { clearLine, failLine, pressureLine, VICTORY_LINE } from '../flavor/text'
import type { Board } from '../sim/board'
import { cardLabel } from '../sim/deck'
import { fmt } from './hud'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Overlay element #${id} missing from index.html`)
  return node as T
}

export class Overlays {
  private overlay = el('overlay')
  private sheet = el('sheet')
  private keyHandler: ((e: KeyboardEvent) => void) | null = null

  get isOpen(): boolean { return this.overlay.classList.contains('on') }

  private open(): void { this.overlay.classList.add('on') }

  close(): void {
    this.overlay.classList.remove('on')
    this.sheet.replaceChildren()
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

  /**
   * The shop moved to the docked side panel (`ui/sidePanel.ts`). A
   * full-screen sheet covered the board, which made the hover preview
   * impossible — there was nowhere to show which weights a purchase would
   * hit. The deck strip and run-end sheet still live here.
   */

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

