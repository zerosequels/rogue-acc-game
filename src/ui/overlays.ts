/**
 * overlays.ts — the full-screen sheets between stages.
 *
 * Four moments: stage intro, stage clear, upgrade pick, and run end. Each is a
 * single DOM sheet built fresh and torn down, which keeps state handling trivial
 * at the cost of a few element allocations per stage — nowhere near a frame
 * budget concern, since the board is paused while any of these is up.
 *
 * Keyboard parity is deliberate: every sheet is fully operable with 1/2/3 and
 * Enter. A pachinko game played at the keyboard should never force a reach for
 * the mouse.
 */

import { ARCHETYPE_LABEL, type Upgrade } from '../config/upgrades'
import { countActive, isAttentionHead, type Board } from '../sim/board'
import type { RunState } from '../core/state'
import { clearLine, failLine, pressureLine, VICTORY_LINE } from '../flavor/text'
import { fmt } from './hud'
import { STAGES } from '../config/balance'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Overlay element #${id} missing from index.html`)
  return node as T
}

export class Overlays {
  private overlay = el('overlay')
  private sheet = el('sheet')
  /** Active keyboard handler for whichever sheet is up. */
  private keyHandler: ((e: KeyboardEvent) => void) | null = null

  get isOpen(): boolean {
    return this.overlay.classList.contains('on')
  }

  private open(): void {
    this.overlay.classList.add('on')
  }

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
  // Stage intro
  // -------------------------------------------------------------------------

  stageIntro(run: RunState, board: Board, onBegin: () => void): void {
    const rng = run.flavorRng('pressure')
    this.sheet.replaceChildren()

    this.sheet.append(
      h('h1', {}, [
        txt(`Stage ${run.stage} / ${STAGES.count} — `),
        span('cyan', run.benchmark),
      ]),
      h('h2', {}, [txt(board.architecture)]),
      h('div', { class: 'flavor' }, [txt(pressureLine(rng, run.activations, run.maxPool))]),
      statGrid([
        ['Target', fmt(run.target), ''],
        ['Activations', `${run.activations}`, run.activations <= 5 ? 'bad' : ''],
        ['Weights', `${countActive(board)}`, ''],
        ['Layers', `${board.layers}`, ''],
        ['Connections', `${board.edges.length}`, 'cyan'],
        ['Attention heads', `${board.nodes.filter((n) => isAttentionHead(n) && !n.removed).length}`, 'amb'],
      ]),
      this.boardDiagnostics(board),
      button('ENGAGE  ▸', onBegin),
    )

    this.open()
    this.bindKeys((e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onBegin()
      }
    })
  }

  /**
   * Surfaces the validator's verdict. Mostly a development affordance, but it
   * also reinforces the fiction — the lab checked the configuration before
   * letting you run tokens through it.
   */
  private boardDiagnostics(board: Board): HTMLElement {
    const s = board.stats
    const bits: string[] = []
    if (s.fallback) {
      bits.push('⚠ procedural generation failed validation — loaded reference checkpoint')
    } else {
      bits.push(`validated in ${s.attempts} attempt${s.attempts === 1 ? '' : 's'}`)
      bits.push(`median cascade ${s.medianPins.toFixed(1)} weights`)
      bits.push(`settle rate ${(s.settleRate * 100).toFixed(0)}%`)
    }
    return h('div', { class: 'mods-list' }, [txt(`config check · ${bits.join(' · ')}`)])
  }

  // -------------------------------------------------------------------------
  // Stage clear
  // -------------------------------------------------------------------------

  stageClear(
    run: RunState,
    rewards: { refund: number; overshoot: number; ratio: number },
    onContinue: () => void,
  ): void {
    const rng = run.flavorRng('clear')
    this.sheet.replaceChildren()

    this.sheet.append(
      h('h1', {}, [span('ok', 'BENCHMARK EXCEEDED')]),
      h('h2', {}, [txt(`${run.benchmark} · stage ${run.stage} of ${STAGES.count}`)]),
      h('div', { class: 'flavor' }, [txt(clearLine(rng, run.score, run.target))]),
      statGrid([
        ['Score', fmt(run.score), 'ok'],
        ['Target', fmt(run.target), ''],
        ['Margin', `${((rewards.ratio - 1) * 100).toFixed(0)}%`, rewards.ratio >= 1.5 ? 'amb' : ''],
        ['Refund', `+${rewards.refund}`, 'cyan'],
        ...(rewards.overshoot > 0
          ? ([['Overshoot bonus', `+${rewards.overshoot}`, 'amb']] as [string, string, string][])
          : ([] as [string, string, string][])),
        ['Activations', `${run.activations} / ${run.maxPool}`, ''],
      ]),
      button('SELECT MODIFICATION  ▸', onContinue),
    )

    this.open()
    this.bindKeys((e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onContinue()
      }
    })
  }

  // -------------------------------------------------------------------------
  // Upgrade pick
  // -------------------------------------------------------------------------

  upgradePick(run: RunState, offers: Upgrade[], onPick: (u: Upgrade) => void): void {
    this.sheet.replaceChildren()

    const cards = h('div', { id: 'cards' }, [])
    offers.forEach((upgrade, i) => {
      const stacks = run.taken[upgrade.id] ?? 0
      const card = h('div', { class: 'card', 'data-arch': upgrade.archetype }, [
        h('div', { class: 'arch' }, [
          txt(ARCHETYPE_LABEL[upgrade.archetype] + (stacks > 0 ? ` · stack ${stacks + 1}/${upgrade.maxStacks}` : '')),
        ]),
        h('div', { class: 'cname' }, [txt(upgrade.name)]),
        h('div', { class: 'cdesc' }, [
          txt(upgrade.description),
          h('div', { style: 'margin-top:9px;color:var(--dim);font-style:italic' }, [txt(upgrade.flavor)]),
        ]),
        h('div', { class: 'ckey' }, [txt(`press ${i + 1}`)]),
      ])
      card.addEventListener('click', () => onPick(upgrade))
      cards.append(card)
    })

    this.sheet.append(
      h('h1', {}, [txt('Apply model modification')]),
      h('h2', {}, [txt('one adapter merges into the checkpoint — choose carefully, this is permanent')]),
      cards,
      this.modsSummary(run),
    )

    this.open()
    this.bindKeys((e) => {
      const n = Number(e.key)
      if (n >= 1 && n <= offers.length) {
        e.preventDefault()
        onPick(offers[n - 1]!)
      }
    })
  }

  /** Running tally of what the player has become. */
  private modsSummary(run: RunState): HTMLElement {
    const m = run.mods
    const bits: string[] = []
    if (m.pinValueMult !== 1) bits.push(`weight value <b>×${m.pinValueMult.toFixed(2)}</b>`)
    if (m.scoreMult !== 1) bits.push(`score <b>×${m.scoreMult.toFixed(2)}</b>`)
    if (m.pinsPerTier !== 5) bits.push(`tier every <b>${m.pinsPerTier}</b> weights`)
    if (m.gradientSurge > 0) bits.push(`surge <b>+${m.gradientSurge}</b>/weight`)
    if (m.orbsPerLaunch > 1) bits.push(`<b>${m.orbsPerLaunch}</b> tokens per pass`)
    if (m.chainSplitOnCritical) bits.push('<b>chain reaction</b>')
    if (m.freeFirstLaunch) bits.push('<b>free first pass</b>')
    if (m.pruneFraction > 0) bits.push(`pruning <b>${(m.pruneFraction * 100).toFixed(0)}%</b>`)
    if (m.explosiveWeights) bits.push('<b>explosive weights</b>')
    if (m.spikeMult !== 5) bits.push(`spike <b>×${m.spikeMult}</b>`)
    if (m.showTrajectory) bits.push('<b>attention mask</b>')
    if (m.agenticOverridesPerStage > 0) bits.push(`<b>${m.agenticOverridesPerStage}</b> override/stage`)
    if (m.unlockRogueTemp) bits.push('<b>rogue sampling</b>')
    if (m.tempCostReduction > 0) bits.push(`temp cost <b>−${m.tempCostReduction}</b>`)
    if (m.hallucinationChance > 0) bits.push(`hallucination <b>${(m.hallucinationChance * 100).toFixed(0)}%</b>`)

    const node = h('div', { class: 'mods-list' }, [])
    node.innerHTML = bits.length
      ? `<span style="color:var(--dim)">active modifications ·</span> ${bits.join(' &nbsp;·&nbsp; ')}`
      : '<span style="color:var(--dim)">base checkpoint — no modifications applied</span>'
    return node
  }

  // -------------------------------------------------------------------------
  // Run end
  // -------------------------------------------------------------------------

  runEnd(run: RunState, won: boolean, onRestart: () => void, onSameSeed: () => void): void {
    const rng = run.flavorRng('end')
    this.sheet.replaceChildren()

    const t = run.totals
    this.sheet.append(
      h('h1', {}, [span(won ? 'ok' : 'bad', won ? 'FRONTIER REACHED' : 'SIGNAL COLLAPSE')]),
      h('h2', {}, [
        txt(won
          ? `all ${STAGES.count} benchmarks exceeded · seed ${run.seed}`
          : `run ended on stage ${run.stage} of ${STAGES.count} · seed ${run.seed}`),
      ]),
      h('div', { class: 'flavor' }, [txt(won ? VICTORY_LINE : failLine(rng))]),
      statGrid([
        ['Stages cleared', `${won ? STAGES.count : run.stage - 1}`, won ? 'ok' : ''],
        ['Total score', fmt(t.totalScore), 'cyan'],
        ['Best pass', fmt(t.bestPass), 'amb'],
        ['Passes fired', `${t.passesFired}`, ''],
        ['Weights struck', fmt(t.pinsStruck), ''],
        ['Signal activations', fmt(t.signalsFired), 'cyan'],
        ['Heads struck', `${t.criticalsStruck}`, 'amb'],
        ['Spikes hit', `${t.spikesHit}`, 'mag'],
        ['Dead neurons', `${t.drains}`, 'bad'],
      ]),
      this.historySummary(run),
      h('div', {}, [
        button('NEW RUN  ▸', onRestart),
        button('RETRY THIS SEED  ↺', onSameSeed, true),
      ]),
    )

    this.open()
    this.bindKeys((e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        onRestart()
      }
    })
  }

  private historySummary(run: RunState): HTMLElement {
    const node = h('div', { class: 'mods-list' }, [])
    if (run.history.length === 0) {
      node.innerHTML = '<span style="color:var(--dim)">no modifications were applied</span>'
      return node
    }
    const names = run.history.map((u) => `<b>${u.name}</b>`).join(' &nbsp;→&nbsp; ')
    node.innerHTML = `<span style="color:var(--dim)">fine-tune lineage ·</span> ${names}`
    return node
  }

  /** Blocking "generating board" notice while the validator runs. */
  compiling(stage: number): void {
    this.sheet.replaceChildren()
    this.sheet.append(
      h('h1', {}, [txt('Initialising weights')]),
      h('h2', {}, [txt(`stage ${stage} · validating configuration`)]),
      h('div', { class: 'flavor' }, [
        txt('Sampling candidate architectures and rejecting the ones that cannot carry a cascade.'),
      ]),
    )
    this.open()
  }
}

// --- tiny DOM helpers ------------------------------------------------------

function h(tag: string, attrs: Record<string, string>, children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const c of children) node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  return node
}

function txt(s: string): Text {
  return document.createTextNode(s)
}

function span(cls: string, s: string): HTMLElement {
  return h('span', { class: cls }, [s])
}

function button(label: string, onClick: () => void, danger = false): HTMLElement {
  const b = h('button', { class: danger ? 'btn danger' : 'btn' }, [label])
  if (danger) b.setAttribute('style', 'margin-left:10px')
  b.addEventListener('click', onClick)
  return b
}

function statGrid(rows: [string, string, string][]): HTMLElement {
  const grid = h('div', { class: 'stat-grid' }, [])
  for (const [label, value, cls] of rows) {
    grid.append(
      h('div', { class: 'stat' }, [
        h('div', { class: 'label' }, [label]),
        h('div', { class: `val ${cls}` }, [value]),
      ]),
    )
  }
  return grid
}
