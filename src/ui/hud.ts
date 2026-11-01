/**
 * hud.ts — the DOM heads-up display.
 *
 * The HUD is plain DOM, not canvas text. Crisp type at any DPI, free layout,
 * free accessibility, and it keeps text rendering out of the WebGL frame
 * budget. It sits in an overlay with `pointer-events: none`, so only the bits
 * that need clicking (the temperature rail, seed buttons) opt back in.
 *
 * Every setter is write-only and idempotent — `sync()` is safe to call every
 * frame, and guards against touching the DOM when a value has not changed.
 */

import { ECONOMY, TEMPERATURES, type TemperatureTier } from '../config/balance'
import type { Mods } from '../config/upgrades'
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

export class Hud {
  private stageVal = el('stage-val')
  private scoreVal = el('score-val')
  private targetVal = el('target-val')
  private benchFill = el('bench-fill')
  private benchBar = el('bench-bar')
  private benchName = el('bench-name')
  private actVal = el('act-val')
  private actMax = el('act-max')
  private actPips = el('act-pips')
  private cellAct = el('cell-act')
  private tempVal = el('temp-val')
  private tempName = el('temp-name')
  private tempRail = el('temp-rail')
  private chargeWrap = el('charge-wrap')
  private chargeFill = el('charge-fill')
  private chainVal = el('chain-val')
  private multVal = el('mult-val')
  private launchVal = el('launch-val')
  private popups = el('popups')
  private seedTxt = el('seed-txt')
  private muteBtn = el('mute-btn')
  private hintEl = el('help-hint')

  /** Cached last-written values, so sync() does not thrash the DOM. */
  private last = {
    stage: -1,
    score: -1,
    target: -1,
    act: -1,
    maxPool: -1,
    tempIndex: -1,
    chain: -1,
    mult: -1,
    pass: -1,
    pipCount: -1,
    pipSpent: -1,
  }

  private onSelectTemp: ((index: number) => void) | null = null
  private railBuiltFor = ''

  bindTempSelect(fn: (index: number) => void): void {
    this.onSelectTemp = fn
  }

  setSeed(seed: string): void {
    this.seedTxt.textContent = seed
  }

  bindMuteToggle(fn: () => void): void {
    this.muteBtn.addEventListener('click', fn)
  }

  setMuted(muted: boolean): void {
    this.muteBtn.textContent = muted ? '♪ off' : '♪ on'
    this.muteBtn.classList.toggle('off', muted)
  }

  /** Build or rebuild the temperature rail. Cheap guard avoids churn. */
  buildTempRail(mods: Mods, selected: number, activations: number): void {
    const signature = `${mods.unlockRogueTemp}|${mods.tempCostReduction}|${selected}|${activations}`
    if (signature === this.railBuiltFor) return
    this.railBuiltFor = signature

    this.tempRail.replaceChildren()

    TEMPERATURES.forEach((tier, i) => {
      const locked = tier.locked && !mods.unlockRogueTemp
      const cost = Math.max(1, tier.cost - mods.tempCostReduction)
      const unaffordable = !locked && activations < cost

      const row = document.createElement('div')
      row.className = 'temp-opt'
      row.dataset.tier = String(i)
      if (i === selected) row.classList.add('sel')
      if (locked) row.classList.add('locked')
      if (unaffordable) row.classList.add('unaffordable')

      const key = document.createElement('div')
      key.className = 'key'
      key.textContent = String(i + 1)

      const body = document.createElement('div')
      const name = document.createElement('div')
      name.className = 'tname'
      name.textContent = locked ? `${tier.name} — locked` : `${tier.value.toFixed(1)} ${tier.name}`
      const meta = document.createElement('div')
      meta.className = 'tmeta'
      meta.textContent = locked
        ? 'requires Temperature Spike'
        : `×${tier.scoreMult.toFixed(1)} score · ${cost} activation${cost === 1 ? '' : 's'}`
      body.append(name, meta)

      row.append(key, body)
      row.title = tier.blurb
      if (!locked) {
        row.addEventListener('click', () => this.onSelectTemp?.(i))
      }
      this.tempRail.append(row)
    })
  }

  sync(data: {
    stage: number
    score: number
    target: number
    benchmark: string
    activations: number
    maxPool: number
    tempIndex: number
    tier: TemperatureTier
    chain: number
    tierMult: number
    passScore: number
    charging: boolean
    charge: number
    mods: Mods
    overridesLeft: number
  }): void {
    const L = this.last

    if (data.stage !== L.stage) {
      this.stageVal.textContent = `${data.stage}`
      L.stage = data.stage
    }
    if (data.score !== L.score) {
      this.scoreVal.textContent = fmt(data.score)
      L.score = data.score
    }
    if (data.target !== L.target) {
      this.targetVal.textContent = fmt(data.target)
      this.benchName.textContent = data.benchmark.toUpperCase()
      L.target = data.target
    }

    const pct = data.target > 0 ? Math.min(1, data.score / data.target) : 1
    this.benchFill.style.right = `${(1 - pct) * 100}%`
    this.benchBar.classList.toggle('met', pct >= 1)

    if (data.activations !== L.act || data.maxPool !== L.maxPool) {
      this.actVal.textContent = `${data.activations}`
      this.actMax.textContent = `${data.maxPool}`
      this.cellAct.classList.toggle('low', data.activations <= ECONOMY.lowWarning)
      this.renderPips(data.activations, data.maxPool)
      L.act = data.activations
      L.maxPool = data.maxPool
    }

    if (data.tempIndex !== L.tempIndex) {
      this.tempVal.textContent = data.tier.value.toFixed(1)
      this.tempName.textContent = data.tier.name
      L.tempIndex = data.tempIndex
    }
    this.buildTempRail(data.mods, data.tempIndex, data.activations)

    if (data.chain !== L.chain) {
      this.chainVal.textContent = `${data.chain}`
      L.chain = data.chain
    }
    if (data.tierMult !== L.mult) {
      this.multVal.textContent = `×${data.tierMult.toFixed(1)}`
      L.mult = data.tierMult
    }
    if (data.passScore !== L.pass) {
      this.launchVal.textContent = fmt(data.passScore)
      L.pass = data.passScore
    }

    this.chargeWrap.classList.toggle('on', data.charging)
    if (data.charging) this.chargeFill.style.right = `${(1 - data.charge) * 100}%`

    this.updateHint(data.mods, data.overridesLeft)
  }

  /** Activation pips. Capped so a huge pool does not wrap the whole screen. */
  private renderPips(activations: number, maxPool: number): void {
    const shown = Math.min(maxPool, 30)
    if (this.last.pipCount !== shown) {
      this.actPips.replaceChildren()
      for (let i = 0; i < shown; i++) {
        const pip = document.createElement('i')
        pip.className = 'pip'
        this.actPips.append(pip)
      }
      this.last.pipCount = shown
      this.last.pipSpent = -1
    }
    const lit = Math.min(shown, activations)
    if (this.last.pipSpent === lit) return
    this.last.pipSpent = lit
    const nodes = this.actPips.children
    for (let i = 0; i < nodes.length; i++) {
      ;(nodes[i] as HTMLElement).classList.toggle('spent', i >= lit)
    }
  }

  private lastHint = ''
  private updateHint(mods: Mods, overridesLeft: number): void {
    const parts = [
      '<kbd>◄ ►</kbd> / mouse  aim',
      '<kbd>SPACE</kbd> / click  charge + fire',
      '<kbd>1</kbd>–<kbd>4</kbd>  temperature',
    ]
    if (mods.agenticOverridesPerStage > 0) {
      parts.push(`<kbd>E</kbd>  agentic override (${overridesLeft} left)`)
    }
    parts.push('<kbd>M</kbd>  mute')
    parts.push('<kbd>R</kbd>  new run')
    const html = parts.join(' &nbsp;·&nbsp; ')
    if (html !== this.lastHint) {
      this.hintEl.innerHTML = html
      this.lastHint = html
    }
  }

  /**
   * Floating score popup at a world position, projected to screen space by the
   * caller. Cosmetic jitter here is the one place a non-seeded random is fine.
   */
  popup(ev: ScoreEvent, screenX: number, screenY: number): void {
    const node = document.createElement('div')
    node.className = ev.kind === 'spike' || ev.kind === 'hallucination' ? 'popup crit' : 'popup'
    node.style.left = `${screenX + (Math.random() - 0.5) * 14}px`
    node.style.top = `${screenY}px`
    node.style.color = POPUP_COLORS[ev.kind]

    if (ev.kind === 'spike') node.textContent = `BENCHMARK SPIKE  +${fmt(ev.points)}`
    else if (ev.kind === 'dud') node.textContent = 'hallucinated'
    else if (ev.kind === 'hallucination') node.textContent = `×5  +${fmt(ev.points)}`
    else if (ev.kind === 'critical') node.textContent = `HEAD  +${fmt(ev.points)}`
    else node.textContent = `+${fmt(ev.points)}`

    this.popups.append(node)
    // Animation is 900ms; clean up a touch after so nothing accumulates.
    window.setTimeout(() => node.remove(), 1000)
  }

  /** Centre-screen announcement for drains and stage events. */
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

  clearPopups(): void {
    this.popups.replaceChildren()
  }

  /** Reset caches so the next sync() repaints everything. */
  invalidate(): void {
    this.last.stage = -1
    this.last.score = -1
    this.last.target = -1
    this.last.act = -1
    this.last.maxPool = -1
    this.last.tempIndex = -1
    this.last.chain = -1
    this.last.mult = -1
    this.last.pass = -1
    this.last.pipCount = -1
    this.last.pipSpent = -1
    this.railBuiltFor = ''
  }
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
