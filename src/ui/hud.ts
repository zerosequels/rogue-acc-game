/**
 * hud.ts — the DOM heads-up display.
 *
 * Plain DOM rather than canvas text: crisp type at any DPI, free layout, and
 * it keeps text rendering out of the WebGL frame budget. It lives in an
 * overlay with `pointer-events: none`, so only the bits that need clicking
 * opt back in.
 *
 * Every setter is write-only and idempotent — `sync()` runs every frame and
 * guards against touching the DOM when nothing changed.
 */

import { ECONOMY } from '../config/balance'
import { totalBenchmarks } from '../config/rounds'
import type { RunState } from '../core/state'
import { CARD_TYPES, CARD_TRANSFORMS, type Card } from '../sim/deck'
import type { ScoreEvent } from '../sim/scoring'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`HUD element #${id} missing from index.html`)
  return node as T
}

const POPUP_COLORS: Record<ScoreEvent['kind'], string> = {
  pin: 'var(--cyan)',
  critical: 'var(--amber)',
  spike: 'var(--magenta)',
  pocket: 'var(--fg)',
  dud: 'var(--dim)',
  hallucination: 'var(--magenta)',
  detonation: 'var(--amber)',
  signal: 'var(--lime)',
  echo: 'var(--dim)',
}

export interface HudData {
  run: RunState
  loaded: Card | null
  upcoming: Card[]
  chain: number
  tierMult: number
  passScore: number
  signalCount: number
  charging: boolean
  charge: number
}

export class Hud {
  private roundVal = el('round-val')
  private roundName = el('round-name')
  private scoreVal = el('score-val')
  private targetVal = el('target-val')
  private benchFill = el('bench-fill')
  private benchBar = el('bench-bar')
  private benchName = el('bench-name')
  private actVal = el('act-val')
  private actMax = el('act-max')
  private actPips = el('act-pips')
  private cellAct = el('cell-act')
  private moneyVal = el('money-val')
  private deckRail = el('deck-rail')
  private chargeWrap = el('charge-wrap')
  private chargeFill = el('charge-fill')
  private chainVal = el('chain-val')
  private multVal = el('mult-val')
  private launchVal = el('launch-val')
  private signalVal = el('signal-val')
  private popups = el('popups')
  private seedTxt = el('seed-txt')
  private muteBtn = el('mute-btn')
  private hintEl = el('help-hint')
  private bossBar = el('boss-bar')

  private last = {
    bm: -1, score: -1, target: -1, act: -1, actMax: -1, money: -1,
    chain: -1, mult: -1, pass: -1, signal: -1, pips: -1, lit: -1, deck: '',
  }

  setSeed(seed: string): void { this.seedTxt.textContent = seed }
  bindMuteToggle(fn: () => void): void { this.muteBtn.addEventListener('click', fn) }
  setMuted(muted: boolean): void {
    this.muteBtn.textContent = muted ? '♪ off' : '♪ on'
    this.muteBtn.classList.toggle('off', muted)
  }

  sync(d: HudData): void {
    const { run } = d
    const L = this.last
    const bm = run.benchmark

    if (run.benchmarkIndex !== L.bm) {
      this.roundVal.textContent = bm.roundName
      this.roundName.textContent = `${run.benchmarkIndex + 1} / ${totalBenchmarks()}`
      this.benchName.textContent = bm.name.toUpperCase()
      L.bm = run.benchmarkIndex
      this.renderBoss(run)
    }
    if (run.score !== L.score) {
      this.scoreVal.textContent = fmt(run.score)
      L.score = run.score
    }
    if (run.target !== L.target) {
      this.targetVal.textContent = fmt(run.target)
      L.target = run.target
    }

    const pct = run.target > 0 ? Math.min(1, run.score / run.target) : 1
    this.benchFill.style.right = `${(1 - pct) * 100}%`
    this.benchBar.classList.toggle('met', pct >= 1)

    const allowance = run.benchmarkActivations
    if (run.activations !== L.act || allowance !== L.actMax) {
      this.actVal.textContent = `${run.activations}`
      this.actMax.textContent = `${allowance}`
      this.cellAct.classList.toggle('low', run.activations <= ECONOMY.lowWarning)
      this.renderPips(run.activations, allowance)
      L.act = run.activations
      L.actMax = allowance
    }

    if (run.money !== L.money) {
      this.moneyVal.textContent = `$${run.money}`
      L.money = run.money
    }

    if (d.chain !== L.chain) { this.chainVal.textContent = `${d.chain}`; L.chain = d.chain }
    if (d.tierMult !== L.mult) { this.multVal.textContent = `×${d.tierMult.toFixed(1)}`; L.mult = d.tierMult }
    if (d.passScore !== L.pass) { this.launchVal.textContent = fmt(d.passScore); L.pass = d.passScore }
    if (d.signalCount !== L.signal) { this.signalVal.textContent = `${d.signalCount}`; L.signal = d.signalCount }

    this.renderDeck(d)
    this.chargeWrap.classList.toggle('on', d.charging)
    if (d.charging) this.chargeFill.style.right = `${(1 - d.charge) * 100}%`
    this.updateHint(run)
  }

  /** Boss modifiers must be unmissable — they invalidate a habit. */
  private renderBoss(run: RunState): void {
    const boss = run.boss
    if (!boss) {
      this.bossBar.classList.remove('on')
      this.bossBar.replaceChildren()
      return
    }
    this.bossBar.classList.add('on')
    this.bossBar.replaceChildren()
    const name = document.createElement('b')
    name.textContent = boss.name
    const desc = document.createElement('span')
    desc.textContent = boss.description
    this.bossBar.append(name, desc)
  }

  /** The chambered card plus what is coming. You cannot choose, only aim. */
  private renderDeck(d: HudData): void {
    const sig = [d.loaded?.id, ...d.upcoming.map((c) => c.id)].join(',') +
      `|${d.loaded?.level}|${d.run.deck.size}`
    if (sig === this.last.deck) return
    this.last.deck = sig

    this.deckRail.replaceChildren()
    const rows: { card: Card | null; now: boolean }[] = [{ card: d.loaded, now: true }]
    for (const c of d.upcoming) rows.push({ card: c, now: false })

    for (const row of rows) {
      const node = document.createElement('div')
      node.className = row.now ? 'card-row now' : 'card-row'
      if (!row.card) {
        node.innerHTML = '<div class="cname" style="color:var(--dim)">deck empty</div>'
        this.deckRail.append(node)
        continue
      }
      const def = CARD_TYPES[row.card.type]
      const marker = document.createElement('div')
      marker.className = 'marker'
      marker.textContent = row.now ? '▶' : '·'

      const body = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'cname'
      name.textContent = `${def.name}  L${row.card.level}`
      const meta = document.createElement('div')
      meta.className = 'cmeta'
      meta.textContent = row.card.transforms.length
        ? row.card.transforms.map((t) => CARD_TRANSFORMS[t].short).join(' · ')
        : def.blurb
      body.append(name, meta)
      node.append(marker, body)
      node.dataset.type = row.card.type
      this.deckRail.append(node)
    }

    const foot = document.createElement('div')
    foot.className = 'deck-foot'
    foot.textContent = `${d.run.deck.size} cards in corpus`
    this.deckRail.append(foot)
  }

  private renderPips(activations: number, allowance: number): void {
    const shown = Math.min(allowance, 24)
    if (this.last.pips !== shown) {
      this.actPips.replaceChildren()
      for (let i = 0; i < shown; i++) {
        const pip = document.createElement('i')
        pip.className = 'pip'
        this.actPips.append(pip)
      }
      this.last.pips = shown
      this.last.lit = -1
    }
    const lit = Math.min(shown, activations)
    if (this.last.lit === lit) return
    this.last.lit = lit
    const nodes = this.actPips.children
    for (let i = 0; i < nodes.length; i++) {
      ;(nodes[i] as HTMLElement).classList.toggle('spent', i >= lit)
    }
  }

  private lastHint = ''
  private updateHint(run: RunState): void {
    const parts = [
      '<kbd>◄ ►</kbd> / mouse  aim',
      '<kbd>SPACE</kbd> / click  charge + fire',
    ]
    if (run.mods.agenticOverridesPerStage > 0) {
      parts.push(`<kbd>E</kbd>  override (${run.overridesLeft})`)
    }
    parts.push('<kbd>M</kbd>  mute', '<kbd>R</kbd>  new run')
    const html = parts.join(' &nbsp;·&nbsp; ')
    if (html !== this.lastHint) {
      this.hintEl.innerHTML = html
      this.lastHint = html
    }
  }

  popup(ev: ScoreEvent, screenX: number, screenY: number): void {
    const node = document.createElement('div')
    const big = ev.kind === 'spike' || ev.kind === 'hallucination'
    node.className = big ? 'popup crit' : 'popup'
    if (ev.kind === 'signal') node.classList.add('sig')
    node.style.left = `${screenX + (Math.random() - 0.5) * 14}px`
    node.style.top = `${screenY}px`
    node.style.color = POPUP_COLORS[ev.kind]

    if (ev.kind === 'spike') node.textContent = `BENCHMARK SPIKE  +${fmt(ev.points)}`
    else if (ev.kind === 'dud') node.textContent = 'dropped'
    else if (ev.kind === 'hallucination') node.textContent = `×5  +${fmt(ev.points)}`
    else if (ev.kind === 'critical') node.textContent = `HEAD  +${fmt(ev.points)}`
    else node.textContent = `+${fmt(ev.points)}`

    this.popups.append(node)
    window.setTimeout(() => node.remove(), 1000)
  }

  flash(text: string, color = 'var(--red)'): void {
    const node = document.createElement('div')
    node.className = 'popup crit'
    node.style.left = '50%'
    node.style.top = '46%'
    node.style.color = color
    node.style.fontSize = '20px'
    node.textContent = text
    this.popups.append(node)
    window.setTimeout(() => node.remove(), 1000)
  }

  clearPopups(): void { this.popups.replaceChildren() }

  invalidate(): void {
    this.last = {
      bm: -1, score: -1, target: -1, act: -1, actMax: -1, money: -1,
      chain: -1, mult: -1, pass: -1, signal: -1, pips: -1, lit: -1, deck: '',
    }
  }
}

export function fmt(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return Math.round(n).toLocaleString('en-US')
}
