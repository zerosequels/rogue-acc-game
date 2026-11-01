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
import { LAUNCH, TEMPERATURES, VALIDATOR, VISUAL } from '../config/balance'
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
  computeLayerBonus,
  Pass,
  returnsToken,
  scoreLanding,
  scorePin,
  type EchoPayout,
  type ScoreEvent,
  type ScoringContext,
} from '../sim/scoring'
import { generateBoard, boardRngFor } from '../sim/boardgen'
import { probeBoard } from '../sim/validator'
import {
  isAttentionHead,
  type Board,
  type BucketTransform,
  type NodeDef,
  type NodeTransform,
} from '../sim/board'
import {
  buildSignalGraph,
  makeSignalResult,
  propagate,
  type SignalGraph,
  type SignalResult,
} from '../sim/propagation'
import { resolveCriticalStrike } from '../sim/effects'
import { Renderer } from '../render/scene'
import { BoardView } from '../render/boardView'
import { OrbView } from '../render/orbView'
import { Background } from '../render/background'
import { Audio } from '../audio/sound'
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
  private audio = new Audio()

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
  /** Weights detonated during the current pass, restored when the next begins. */
  private detonatedThisPass: NodeDef[] = []
  /** Edge/node lookup for propagation. Rebuilt whenever the board changes. */
  private graph: SignalGraph | null = null
  /** Per-layer Layer Norm bonus. Rebuilt whenever the board changes. */
  private layerBonus: number[] = []
  private signal: SignalResult = makeSignalResult()
  /** Payouts deferred to the next pass by Checkpoint / Cache Hit. */
  private pendingEchoes: EchoPayout[] = []
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
      this.audio.unlock()
      if (this.launcher.selectTemp(i, this.run.mods)) {
        this.audio.uiMove()
        this.syncHud()
      } else {
        this.audio.uiDenied()
      }
    })
    this.hud.bindMuteToggle(() => {
      const muted = this.audio.toggleMute()
      this.hud.setMuted(muted)
    })
    this.hud.setMuted(this.audio.muted)
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

    // One board for the whole run. This is the object every upgrade lands on.
    this.boardView.clear()
    this.board = this.buildRunBoard()
    this.physics.loadBoard(this.board)
    this.boardView.build(this.board)
    this.rebuildBoardCaches()

    this.loadStage()
  }

  // -------------------------------------------------------------------------
  // Stage loading: generate → prune → validate → accept or retry
  // -------------------------------------------------------------------------

  /**
   * Start a benchmark. In v2 the board is NOT rebuilt here — it is the run's
   * machine, generated once in `startRun` and carrying every upgrade the
   * player has bought. All this does is clear the previous attempt off it.
   */
  private loadStage(): void {
    this.run.phase = 'stage-intro'
    this.physics.despawnAllOrbs()
    this.orbView.releaseAll()
    this.pass.reset()
    this.detonatedThisPass.length = 0

    const board = this.board
    if (!board) throw new Error('loadStage before the run board was built')

    this.boardView.resetPass(board)
    this.run.beginStage()
    this.launcher.enabled = false

    this.syncHud()
    this.overlays.stageIntro(this.run, board, () => this.beginPlay())
  }

  /**
   * Build the one board this run is played on. Geometry is fixed; the seed
   * varies wiring and starting state. The validator runs here and only here,
   * so it can afford to be thorough — this is once per run, not once a stage.
   */
  private buildRunBoard(): Board {
    const { seed } = this.run

    for (let attempt = 0; attempt < VALIDATOR.maxAttempts; attempt++) {
      const candidate = generateBoard(boardRngFor(seed, attempt), `${seed}/a${attempt}`)
      const stats = probeBoard(candidate, seed, attempt)
      candidate.stats = stats
      if (stats.accepted) return candidate
    }

    // Never silently ship an unvalidated board: take the last candidate but
    // mark it, so the stage-intro diagnostics say so out loud.
    const last = generateBoard(boardRngFor(seed, VALIDATOR.maxAttempts - 1), `${seed}/fallback`)
    last.stats = { ...probeBoard(last, seed, 0), fallback: true, accepted: true }
    return last
  }

  /**
   * Prune Dead Neurons. On a persistent board this applies the moment the
   * upgrade is taken rather than at board build, and removal lasts the run.
   */
  private applyPruning(fraction: number): void {
    const board = this.board
    if (!board || fraction <= 0) return
    const rng = deriveRng(this.run.seed, 'prune', this.run.stage)
    const ordinary = board.nodes.filter((n) => !isAttentionHead(n) && !n.removed)
    const count = Math.floor(ordinary.length * fraction)
    for (const node of rng.sample(ordinary, count)) {
      this.physics.removePin(node)
      this.boardView.retire(node)
    }
    this.boardView.markLabelsDirty()
  }

  /**
   * Recompute everything derived from board state. Must run after any level,
   * transform or pruning change, or scoring silently uses a stale network.
   */
  private rebuildBoardCaches(): void {
    if (!this.board) return
    this.graph = buildSignalGraph(this.board)
    this.layerBonus = computeLayerBonus(this.board)
  }

  private beginPlay(): void {
    this.audio.unlock()
    this.audio.uiConfirm()
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
      this.audio.uiDenied()
      return
    }

    const charge = this.launcher.charge
    const spec = this.launcher.release(this.run.mods)
    if (!spec) return

    this.run.spend(spec.cost)

    // A new forward pass: clear the struck markers so the cascade path reads
    // fresh, and reset the uncommitted score.
    this.pass.reset()
    this.restoreDetonated()
    if (this.board) this.boardView.resetPass(this.board)

    // Checkpoint and Cache Hit defer part of their payout to the next pass.
    // Banking it here rather than at the end of the previous one means the
    // player sees it land during play instead of inside a results screen.
    if (this.pendingEchoes.length > 0) {
      for (const echo of this.pendingEchoes) {
        this.pass.score += echo.points
        this.emitPopup({
          points: echo.points,
          x: echo.x,
          y: echo.y,
          kind: 'echo',
          tierMult: 1,
        })
      }
      this.pendingEchoes.length = 0
    }

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

    this.audio.launch(charge, this.passHeat)

    this.run.phase = 'resolving'
    this.launcher.enabled = false
    this.syncHud()
  }

  /**
   * Run the forward pass from a contact and present it. Edge flashes and score
   * popups are staggered BY HOP so the player sees a wave travelling down the
   * network rather than the whole subtree lighting in a single frame — the
   * propagation itself is instantaneous and already scored.
   */
  private fireSignal(origin: NodeDef, ctx: ScoringContext): void {
    if (!this.graph) return
    propagate(this.graph, this.pass, origin, ctx, this.signal)
    if (this.signal.reached === 0) return

    for (const lit of this.signal.litEdges) {
      window.setTimeout(
        () => this.boardView.flashEdge(lit.index),
        lit.hop * VISUAL.signalHopMs,
      )
    }

    for (const ev of this.signal.events) {
      const hop = ev.hop ?? 1
      window.setTimeout(() => {
        const node = ev.nodeId === undefined ? undefined : this.graph?.nodes.get(ev.nodeId)
        if (node) this.boardView.strike(node)
        if (ev.points > 0) this.emitPopup(ev)
      }, hop * VISUAL.signalHopMs)
      this.run.totals.pinsStruck++
    }

    if (this.signal.reached >= 8) this.renderer.punch(0.3)
    this.audio.signal(this.signal.reached)
  }

  /** Explosive Weights only damages the board for the duration of one pass. */
  private restoreDetonated(): void {
    if (this.detonatedThisPass.length === 0) return
    for (const pin of this.detonatedThisPass) {
      this.physics.restorePin(pin)
      if (this.board) this.boardView.revive(pin, this.board)
    }
    this.detonatedThisPass.length = 0
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
    this.audio.uiConfirm()
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
      layerBonus: this.layerBonus,
      rng: deriveRng(
        this.run.seed,
        'roll',
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
      if (isAttentionHead(hit.pin)) this.run.totals.criticalsStruck++
      if (ev.kind === 'hallucination' || ev.kind === 'critical') this.renderer.punch(0.22)

      // Pitch climbs with the chain, so a long cascade is an ascending run.
      if (ev.kind === 'hallucination') this.audio.hallucination()
      else if (isAttentionHead(hit.pin)) this.audio.criticalTick(this.pass.chain, this.passHeat)
      else this.audio.pinTick(this.pass.chain, this.passHeat)

      if (isAttentionHead(hit.pin)) this.resolveCritical(hit.pin, hit.orb, ctx)

      // The contact scored; now the network carries it downward.
      this.fireSignal(hit.pin, ctx)
    }

    // --- pocket landings ---
    for (const landing of this.events.landings) {
      const ev = scoreLanding(this.pass, landing.pocket, landing.orb, ctx)
      this.orbView.release(landing.orb.id)

      // Beam Search returns the token to the launcher for a free relaunch.
      if (returnsToken(landing.pocket) && this.physics.orbCount < LAUNCH.maxOrbsHardCap) {
        const relaunch = this.physics.spawnOrb(
          landing.pocket.x * 0.3,
          LAUNCH.originY - 0.5,
          0,
          -LAUNCH.minSpeed,
          { restitution: this.passRestitution, launchId: landing.orb.launchId, scoreScale: landing.orb.scoreScale },
        )
        this.orbView.acquire(relaunch)
        this.hud.flash('BEAM SEARCH', 'var(--lime)')
        this.audio.uiConfirm()
      }

      if (landing.pocket.kind === 'spike') {
        this.run.totals.spikesHit++
        this.renderer.punch(1.3)
        this.audio.spike()
      } else if (landing.pocket.kind === 'drain') {
        this.run.totals.drains++
        this.audio.drain()
      } else {
        this.audio.pocket()
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

  /**
   * Attention-head side effects. The mechanics live in `sim/effects.ts` so the
   * headless harness can execute them too; this only turns the outcome into
   * visuals and sound.
   */
  private resolveCritical(pin: NodeDef, orb: OrbHandle, ctx: ScoringContext): void {
    const outcome = resolveCriticalStrike(
      this.physics,
      this.pass,
      pin,
      orb,
      ctx,
      this.run.mods,
      this.passRestitution,
    )

    for (const { pin: victim, event } of outcome.detonated) {
      this.boardView.retire(victim)
      this.detonatedThisPass.push(victim)
      if (event) this.emitPopup(event)
    }
    if (outcome.detonated.length > 0) {
      this.renderer.punch(0.6)
      this.audio.detonate()
    }

    if (outcome.split) {
      this.orbView.acquire(outcome.split)
      this.renderer.punch(0.35)
      this.audio.split()
    }
  }

  private emitPopup(ev: ScoreEvent): void {
    const screen = this.renderer.worldToScreen(ev.x, ev.y)
    this.hud.popup(ev, screen.x, screen.y)
  }

  /** Called once the last token of a pass has left the board. */
  private finishPass(): void {
    this.pendingEchoes = this.pass.echoes.slice()
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
      this.audio.stageClear()
      const rewards = this.run.applyStageRewards()
      this.syncHud()
      this.overlays.stageClear(this.run, rewards, () => this.showUpgrades())
      return
    }

    // run-win / run-fail
    this.run.phase = next
    if (next === 'run-win') this.audio.stageClear()
    else this.audio.runFail()
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
    this.audio.unlock()
    this.audio.uiConfirm()
    const pruneBefore = this.run.mods.pruneFraction
    this.run.takeUpgrade(upgrade)
    const pruneDelta = this.run.mods.pruneFraction - pruneBefore
    if (pruneDelta > 0) this.applyPruning(pruneDelta)
    this.boardView.markLabelsDirty()
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

    this.audio.frame()
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
      // An EOS bucket terminates the pass wherever the other tokens are.
      if (this.pass.ended && this.physics.orbCount > 0) {
        this.physics.despawnAllOrbs()
        this.orbView.releaseAll()
        this.hud.flash('EOS', 'var(--amber)')
      }
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
    this.renderer.render(dt)
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
      // Any keypress is a user gesture, which is what an AudioContext needs
      // before it will produce sound. Browsers can also re-suspend a context
      // when the tab is backgrounded, so this runs on every key, not once.
      this.audio.unlock()

      if (e.key === 'm' || e.key === 'M') {
        const muted = this.audio.toggleMute()
        this.hud.setMuted(muted)
        this.hud.flash(muted ? 'AUDIO MUTED' : 'AUDIO ON', 'var(--dim)')
        return
      }

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
          if (this.run.phase === 'aim' && !this.launcher.charging) {
            this.launcher.beginCharge()
            this.audio.chargeStart()
          }
          break
        case '1':
        case '2':
        case '3':
        case '4': {
          const idx = Number(e.key) - 1
          if (this.launcher.selectTemp(idx, this.run.mods)) {
            this.audio.uiMove()
            this.syncHud()
          } else {
            this.audio.uiDenied()
            this.hud.flash('SAMPLING TIER LOCKED', 'var(--dim)')
          }
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
      this.audio.unlock()
      if (this.run.phase !== 'aim') return
      e.preventDefault()
      const w = this.renderer.screenToWorld(e.clientX, e.clientY)
      this.launcher.aimAt(w.x, w.y)
      this.launcher.beginCharge()
      this.audio.chargeStart()
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

  /**
   * Console API for exercising Pass 2 before the shop exists.
   *
   *   game.debug.level(3)               raise every node to L3
   *   game.debug.levelOne(12, 5)        node 12 to L5
   *   game.debug.transform(12, 'gelu')  grant a transform
   *   game.debug.scatter('gelu', 6)     grant one to 6 random nodes
   *   game.debug.bucket(0, 4, 'top-k')  bucket 0 to L4 with a transform
   *   game.debug.report()               what the board currently holds
   */
  get debug() {
    const refresh = () => {
      if (!this.board) return
      this.rebuildBoardCaches()
      this.boardView.build(this.board)
      this.physics.loadBoard(this.board)
    }
    return {
      level: (n: number) => {
        for (const node of this.board?.nodes ?? []) node.level = n
        refresh()
      },
      levelOne: (id: number, n: number) => {
        const node = this.board?.nodes.find((x) => x.id === id)
        if (node) node.level = n
        refresh()
      },
      transform: (id: number, t: NodeTransform) => {
        const node = this.board?.nodes.find((x) => x.id === id)
        if (node && !node.transforms.includes(t)) node.transforms.push(t)
        refresh()
      },
      scatter: (t: NodeTransform, count: number) => {
        const pool = (this.board?.nodes ?? []).filter((n) => !n.removed && !n.transforms.includes(t))
        const rng = deriveRng(this.run.seed, 'debug-scatter', t, count)
        for (const n of rng.sample(pool, count)) n.transforms.push(t)
        refresh()
      },
      bucket: (id: number, level: number, t?: BucketTransform) => {
        const p = this.board?.pockets.find((x) => x.id === id)
        if (!p) return
        p.level = level
        if (t) p.transform = t
        refresh()
      },
      report: () => {
        const b = this.board
        if (!b) return 'no board'
        const byTransform = new Map<string, number>()
        for (const n of b.nodes) {
          for (const t of n.transforms) byTransform.set(t, (byTransform.get(t) ?? 0) + 1)
        }
        return {
          nodes: b.nodes.filter((n) => !n.removed).length,
          edges: b.edges.length,
          avgLevel: b.nodes.reduce((a, n) => a + n.level, 0) / b.nodes.length,
          transforms: Object.fromEntries(byTransform),
          buckets: b.pockets.map((p) => `${p.kind} L${p.level}${p.transform ? ' ' + p.transform : ''}`),
        }
      },
    }
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
