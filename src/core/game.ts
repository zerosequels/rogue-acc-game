/**
 * game.ts — orchestration. Owns the physics world, the views, the HUD, and the
 * frame loop, and translates between them.
 *
 * Division of labour, so this file stays readable:
 *   state.ts     decides the RULES    (can I afford this? did I clear?)
 *   scoring.ts   decides the POINTS   (what is this pin worth right now?)
 *   physics.ts   decides the MOTION   (where did the token go?)
 *   game.ts      decides the ORDER    (what happens next, and who is told)
 *
 * The one piece of real sequencing subtlety is pass resolution. A forward pass
 * is not over when the player releases the launcher — it is over when the last
 * of its tokens leaves the board, because a benchmark spike can retroactively
 * multiply everything banked during that pass. So score is held uncommitted in
 * `Pass` until `orbCount` hits zero, and only then does the stage total move.
 */

import * as THREE from 'three'
import { LAUNCH, TEMPERATURES, VALIDATOR } from '../config/balance'
import { deriveRng, mintSeed } from './rng'
import { RunState, type Phase } from './state'
import { Launcher } from '../sim/launcher'
import {
  initPhysics,
  makeStepEvents,
  PhysicsWorld,
  type OrbHandle,
  type StepEvents,
} from '../sim/physics'
import {
  Pass,
  scoreDetonation,
  scoreLanding,
  scorePin,
  type ScoreEvent,
  type ScoringContext,
} from '../sim/scoring'
import { fallbackBoard, generateCandidate, boardRngFor } from '../sim/boardgen'
import { probeBoard } from '../sim/validator'
import type { Board, PinDef } from '../sim/board'
import { Renderer } from '../render/scene'
import { BoardView } from '../render/boardView'
import { OrbView } from '../render/orbView'
import { Background } from '../render/background'
import { Hud } from '../ui/hud'
import { Overlays } from '../ui/overlays'
import type { Upgrade } from '../config/upgrades'

/** Normalise a temperature value to 0..1 for visual intensity. */
function heatOf(tempValue: number): number {
  const lo = TEMPERATURES[0]!.value
  const hi = TEMPERATURES[TEMPERATURES.length - 1]!.value
  return Math.max(0, Math.min(1, (tempValue - lo) / (hi - lo)))
}

export class Game {
  private renderer: Renderer
  private physics!: PhysicsWorld
  private boardView = new BoardView()
  private orbView = new OrbView()
  private background: Background
  private hud = new Hud()
  private overlays = new Overlays()

  private run!: RunState
  private launcher = new Launcher()
  private pass = new Pass()
  private board: Board | null = null

  private events: StepEvents = makeStepEvents()
  private clock = new THREE.Clock()

  /** Heat in force for the pass currently in flight. */
  private passHeat = 0
  /**
   * Restitution of the pass in flight. Split tokens MUST inherit this — they
   * were spawning with restitution 0, which made every Chain Reaction child a
   * dead weight that dropped straight through the board without bouncing.
   */
  private passRestitution = 0
  /** Smoothed heat, so the backdrop eases rather than snaps. */
  private displayHeat = 0

  /** Keyboard aim state. */
  private keyLeft = false
  private keyRight = false

  private rafId = 0

  constructor(host: HTMLElement) {
    this.renderer = new Renderer(host)
    this.background = new Background(40, 40)
    this.renderer.scene.add(this.background.mesh)
    this.renderer.scene.add(this.boardView.group)
    this.renderer.scene.add(this.orbView.group)

    this.renderer.onResize(() => {
      this.background.fit(
        this.renderer.viewWidth * 1.05,
        this.renderer.viewHeight * 1.05,
        this.renderer.viewCentreY,
      )
    })
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async boot(seed: string): Promise<void> {
    await initPhysics()
    this.physics = new PhysicsWorld()
    this.installInput()
    this.hud.bindTempSelect((i) => {
      if (this.launcher.selectTemp(i, this.run.mods)) this.syncHud()
    })
    this.startRun(seed)
    this.loop()
  }

  startRun(seed: string): void {
    this.run = new RunState(seed)
    this.launcher = new Launcher()
    this.pass.reset()
    this.hud.setSeed(seed)
    this.hud.invalidate()
    this.hud.clearPopups()
    this.updateSeedInUrl(seed)
    this.loadStage()
  }

  // -------------------------------------------------------------------------
  // Stage loading: generate → prune → validate → accept or retry
  // -------------------------------------------------------------------------

  private loadStage(): void {
    this.run.phase = 'stage-intro'
    this.physics.despawnAllOrbs()
    this.orbView.releaseAll()
    this.pass.reset()

    const board = this.buildValidatedBoard()
    this.board = board

    this.physics.loadBoard(board)
    this.boardView.build(board)

    this.run.beginStage()
    this.launcher.normaliseSelection(this.run.mods)
    this.launcher.enabled = false

    this.syncHud()
    this.overlays.stageIntro(this.run, board, () => this.beginPlay())
  }

  /**
   * Generate candidates until one passes the validator, then fall back to the
   * handcrafted board. Synchronous and blocking: a stage cannot start without a
   * board, and the whole loop is a few milliseconds.
   */
  private buildValidatedBoard(): Board {
    const { seed, stage } = this.run

    for (let attempt = 0; attempt < VALIDATOR.maxAttempts; attempt++) {
      const rng = boardRngFor(seed, stage, attempt)
      const candidate = generateCandidate(rng, `${seed}/s${stage}/a${attempt}`)

      // Pruning is a board-shaping upgrade, so it must apply BEFORE validation
      // — the player plays the pruned board, so that is what we must validate.
      this.applyPruning(candidate, attempt)

      const stats = probeBoard(candidate, seed, stage, attempt)
      candidate.stats = stats
      if (stats.accepted) return candidate
    }

    const fb = fallbackBoard(`${seed}/s${stage}/fallback`)
    this.applyPruning(fb, 0)
    return fb
  }

  /** Prune Dead Neurons: remove a fraction of ordinary weights, never heads. */
  private applyPruning(board: Board, attempt: number): void {
    const frac = this.run.mods.pruneFraction
    if (frac <= 0) return
    const rng = deriveRng(this.run.seed, 'prune', this.run.stage, attempt)
    const ordinary = board.pins.filter((p) => !p.critical && !p.removed)
    const count = Math.floor(ordinary.length * frac)
    for (const pin of rng.sample(ordinary, count)) pin.removed = true
  }

  private beginPlay(): void {
    this.overlays.close()
    this.run.phase = 'aim'
    this.launcher.enabled = true
    this.syncHud()
  }

  // -------------------------------------------------------------------------
  // Launching
  // -------------------------------------------------------------------------

  private tryLaunch(): void {
    if (this.run.phase !== 'aim') return

    const tier = this.launcher.tier
    const cost = this.launcher.costOf(tier, this.run.mods)
    if (!this.run.canAfford(cost)) {
      this.launcher.cancelCharge()
      this.hud.flash('INSUFFICIENT ACTIVATIONS', 'var(--red)')
      return
    }

    const spec = this.launcher.release(this.run.mods)
    if (!spec) return

    this.run.spend(spec.cost)

    // A new forward pass: clear the struck markers so the cascade path reads
    // fresh, and reset the uncommitted score.
    this.pass.reset()
    if (this.board) this.boardView.resetPass(this.board)

    this.passHeat = heatOf(spec.tier.value)
    this.passRestitution = spec.restitution

    const launchId = this.run.totals.passesFired
    for (const o of spec.orbs) {
      if (this.physics.orbCount >= Math.min(this.run.mods.maxOrbs, LAUNCH.maxOrbsHardCap)) break
      const orb = this.physics.spawnOrb(o.x, o.y, o.vx, o.vy, {
        restitution: spec.restitution,
        launchId,
        scoreScale: spec.scoreScale,
      })
      this.orbView.acquire(orb)
    }

    this.run.phase = 'resolving'
    this.launcher.enabled = false
    this.syncHud()
  }

  /** Agentic Override: redirect the highest in-flight token toward the aim line. */
  private tryOverride(): void {
    if (this.run.phase !== 'resolving') return
    if (this.run.overridesLeft <= 0) return
    const orbs = this.physics.orbs
    if (orbs.length === 0) return

    let target: OrbHandle = orbs[0]!
    for (const o of orbs) if (o.y > target.y) target = o

    this.physics.redirectOrb(target, this.launcher.angle, 1.15)
    this.run.overridesLeft--
    this.renderer.punch(0.5)
    this.hud.flash('AGENTIC OVERRIDE', 'var(--magenta)')
    this.syncHud()
  }

  // -------------------------------------------------------------------------
  // Pass resolution
  // -------------------------------------------------------------------------

  private scoringContext(): ScoringContext {
    return {
      mods: this.run.mods,
      tempScoreMult: this.launcher.tier.scoreMult,
      tempValue: this.launcher.tier.value,
      rng: deriveRng(
        this.run.seed,
        'hallucinate',
        this.run.stage,
        this.run.totals.passesFired,
        this.pass.struck.size,
      ),
    }
  }

  private handleEvents(): void {
    const ctx = this.scoringContext()

    // --- pin strikes ---
    for (const hit of this.events.pinHits) {
      const ev = scorePin(this.pass, hit.pin, hit.orb, ctx)
      if (!ev) continue

      this.boardView.strike(hit.pin)
      this.emitPopup(ev)
      this.run.totals.pinsStruck++
      if (hit.pin.critical) this.run.totals.criticalsStruck++
      if (ev.kind === 'hallucination' || ev.kind === 'critical') this.renderer.punch(0.22)

      if (hit.pin.critical) {
        this.detonate(hit.pin, ctx)
        this.splitOrb(hit.orb)
      }
    }

    // --- pocket landings ---
    for (const landing of this.events.landings) {
      const ev = scoreLanding(this.pass, landing.pocket, landing.orb, ctx)
      this.orbView.release(landing.orb.id)

      if (landing.pocket.kind === 'spike') {
        this.run.totals.spikesHit++
        this.renderer.punch(1.3)
      } else if (landing.pocket.kind === 'drain') {
        this.run.totals.drains++
      }
      if (ev) this.emitPopup(ev)
      else if (landing.pocket.kind === 'drain') this.hud.flash('DEAD NEURON', 'var(--red)')
    }

    // --- culled orbs (stuck / escaped) ---
    for (const orb of this.events.culled) {
      this.orbView.release(orb.id)
      this.run.totals.drains++
    }
  }

  /** Explosive Weights: detonate neighbours of a struck attention head. */
  private detonate(pin: PinDef, ctx: ScoringContext): void {
    if (!this.run.mods.explosiveWeights) return
    const near = this.physics.pinsNear(pin.x, pin.y, this.run.mods.explosiveRadius)
    let destroyed = 0
    for (const victim of near) {
      if (victim.critical) continue // heads survive; only ordinary weights blow
      if (destroyed >= 3) break
      const ev = scoreDetonation(this.pass, victim, ctx)
      this.boardView.retire(victim)
      this.physics.removePin(victim)
      destroyed++
      if (ev) this.emitPopup(ev)
    }
    if (destroyed > 0) this.renderer.punch(0.6)
  }

  /** LoRA: Chain Reaction — split on an attention head, respecting the cap. */
  private splitOrb(orb: OrbHandle): void {
    if (!this.run.mods.chainSplitOnCritical) return
    const cap = Math.min(this.run.mods.maxOrbs, LAUNCH.maxOrbsHardCap)
    if (this.physics.orbCount >= cap) return

    // Mirror the parent's horizontal velocity, with a nudge away from it, so
    // the pair visibly diverges instead of overlapping into one blurred dot.
    const vx = -orb.vx * 0.9 + (orb.vx >= 0 ? -2 : 2)
    const vy = Math.min(-2, orb.vy * 0.8)

    const child = this.physics.spawnOrb(orb.x, orb.y, vx, vy, {
      restitution: this.passRestitution,
      launchId: orb.launchId,
      // Splits pay less, or Chain Reaction stacked with multi-orb runs away.
      scoreScale: orb.scoreScale * 0.6,
    })
    this.orbView.acquire(child)
    this.renderer.punch(0.35)
  }

  private emitPopup(ev: ScoreEvent): void {
    const screen = this.renderer.worldToScreen(ev.x, ev.y)
    this.hud.popup(ev, screen.x, screen.y)
  }

  /** Called once the last token of a pass has left the board. */
  private finishPass(): void {
    this.run.commitPass(this.pass.score)
    const next: Phase = this.run.resolveAfterPass()
    this.pass.reset()
    this.syncHud()

    if (next === 'aim') {
      this.run.phase = 'aim'
      this.launcher.enabled = true
      return
    }

    if (next === 'stage-clear') {
      this.run.phase = 'stage-clear'
      const rewards = this.run.applyStageRewards()
      this.syncHud()
      this.overlays.stageClear(this.run, rewards, () => this.showUpgrades())
      return
    }

    // run-win / run-fail
    this.run.phase = next
    this.overlays.runEnd(
      this.run,
      next === 'run-win',
      () => this.startRun(mintSeed()),
      () => this.startRun(this.run.seed),
    )
  }

  private showUpgrades(): void {
    this.run.phase = 'upgrade'
    const offers = this.run.rollUpgradeOffers()
    if (offers.length === 0) {
      this.advanceStage()
      return
    }
    this.overlays.upgradePick(this.run, offers, (u) => this.pickUpgrade(u))
  }

  private pickUpgrade(upgrade: Upgrade): void {
    this.run.takeUpgrade(upgrade)
    this.launcher.normaliseSelection(this.run.mods)
    this.hud.invalidate()
    this.advanceStage()
  }

  private advanceStage(): void {
    this.run.nextStage()
    this.loadStage()
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop)
    const dt = Math.min(this.clock.getDelta(), 0.1)
    const t = this.clock.elapsedTime

    const playing = this.run.phase === 'aim' || this.run.phase === 'resolving'

    // --- input-driven aim + charge ---
    if (this.run.phase === 'aim') {
      if (this.keyLeft) this.launcher.aimBy(-LAUNCH.aimSpeedKeyboard * dt)
      if (this.keyRight) this.launcher.aimBy(LAUNCH.aimSpeedKeyboard * dt)
      if (this.launcher.updateCharge(dt)) {
        // Auto-fire at full charge: holding past full should never feel punitive.
        if (this.launcher.charge >= 1) this.tryLaunch()
      }
    }

    // --- physics + scoring ---
    if (this.run.phase === 'resolving') {
      this.physics.advance(dt, this.events)
      this.handleEvents()
      if (this.physics.orbCount === 0) this.finishPass()
    }

    // --- visuals ---
    const targetHeat =
      this.run.phase === 'resolving' ? this.passHeat : heatOf(this.launcher.tier.value)
    this.displayHeat += (targetHeat - this.displayHeat) * Math.min(1, dt * 6)
    this.renderer.heat = this.displayHeat
    this.background.update(t, this.displayHeat)

    if (this.board) this.boardView.update(dt, this.board)
    this.orbView.update(this.physics?.orbs ?? [], this.displayHeat)
    this.orbView.updateLauncher(
      this.launcher.angle,
      this.launcher.charge,
      this.launcher.predictPath(this.run.mods),
      this.run.phase === 'aim',
    )

    if (playing) this.syncHud()
    this.renderer.render()
  }

  private syncHud(): void {
    this.hud.sync({
      stage: this.run.stage,
      score: this.run.score,
      target: this.run.target,
      benchmark: this.run.benchmark,
      activations: this.run.activations,
      maxPool: this.run.maxPool,
      tempIndex: this.launcher.tempIndex,
      tier: this.launcher.tier,
      chain: this.pass.chain,
      tierMult: this.pass.tierMult(this.run.mods),
      passScore: this.pass.score,
      charging: this.launcher.charging,
      charge: this.launcher.charge,
      mods: this.run.mods,
      overridesLeft: this.run.overridesLeft,
    })
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private installInput(): void {
    window.addEventListener('keydown', (e) => {
      // Overlays own the keyboard while they are up.
      if (this.overlays.isOpen) {
        if (e.key === 'r' || e.key === 'R') this.startRun(mintSeed())
        return
      }

      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          this.keyLeft = true
          e.preventDefault()
          break
        case 'ArrowRight':
        case 'd':
        case 'D':
          this.keyRight = true
          e.preventDefault()
          break
        case ' ':
          e.preventDefault()
          if (this.run.phase === 'aim' && !this.launcher.charging) this.launcher.beginCharge()
          break
        case '1':
        case '2':
        case '3':
        case '4': {
          const idx = Number(e.key) - 1
          if (this.launcher.selectTemp(idx, this.run.mods)) this.syncHud()
          else this.hud.flash('SAMPLING TIER LOCKED', 'var(--dim)')
          break
        }
        case 'e':
        case 'E':
          this.tryOverride()
          break
        case 'r':
        case 'R':
          this.startRun(mintSeed())
          break
      }
    })

    window.addEventListener('keyup', (e) => {
      switch (e.key) {
        case 'ArrowLeft':
        case 'a':
        case 'A':
          this.keyLeft = false
          break
        case 'ArrowRight':
        case 'd':
        case 'D':
          this.keyRight = false
          break
        case ' ':
          if (this.launcher.charging) this.tryLaunch()
          break
      }
    })

    const canvas = this.renderer.renderer.domElement

    canvas.addEventListener('pointermove', (e) => {
      if (this.run.phase !== 'aim') return
      const w = this.renderer.screenToWorld(e.clientX, e.clientY)
      this.launcher.aimAt(w.x, w.y)
    })

    canvas.addEventListener('pointerdown', (e) => {
      if (this.run.phase !== 'aim') return
      e.preventDefault()
      const w = this.renderer.screenToWorld(e.clientX, e.clientY)
      this.launcher.aimAt(w.x, w.y)
      this.launcher.beginCharge()
    })

    canvas.addEventListener('pointerup', (e) => {
      e.preventDefault()
      if (this.launcher.charging) this.tryLaunch()
    })

    // Leaving the canvas mid-charge fires rather than silently cancelling —
    // a swallowed input feels like a bug even when it is a safeguard.
    canvas.addEventListener('pointerleave', () => {
      if (this.launcher.charging) this.tryLaunch()
    })

    // --- seed controls ---
    document.getElementById('seed-new')?.addEventListener('click', () => {
      this.startRun(mintSeed())
    })
    document.getElementById('seed-copy')?.addEventListener('click', async () => {
      const url = new URL(window.location.href)
      url.searchParams.set('seed', this.run.seed)
      try {
        await navigator.clipboard.writeText(url.toString())
        this.hud.flash('LINK COPIED', 'var(--cyan)')
      } catch {
        this.hud.flash('CLIPBOARD BLOCKED', 'var(--dim)')
      }
    })
  }

  private updateSeedInUrl(seed: string): void {
    const url = new URL(window.location.href)
    url.searchParams.set('seed', seed)
    window.history.replaceState({}, '', url)
  }

  dispose(): void {
    cancelAnimationFrame(this.rafId)
    this.boardView.clear()
    this.orbView.dispose()
    this.background.dispose()
    this.physics?.dispose()
    this.renderer.dispose()
  }
}
