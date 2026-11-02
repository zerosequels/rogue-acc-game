/**
 * game.ts — orchestration. Owns the physics world, the views, the HUD, and
 * the frame loop, and translates between them.
 *
 * Division of labour, so this file stays readable:
 *   state.ts       the RULES    (can I fire? did I clear? what did I earn?)
 *   scoring.ts     the POINTS   (what is this weight worth right now?)
 *   propagation.ts the SPREAD   (what else did that light up?)
 *   physics.ts     the MOTION   (where did the token go?)
 *   shopkeeper.ts  the MARKET   (what is for sale, what does buying it do?)
 *   game.ts        the ORDER    (what happens next, and who is told?)
 *
 * The sequencing subtlety is pass resolution. A pass is not over when the
 * player releases the launcher — it is over when the last of its tokens
 * leaves the board, because a benchmark spike multiplies everything banked
 * during that pass retroactively. Score is held uncommitted in `Pass` until
 * `orbCount` hits zero.
 */

import * as THREE from 'three'
import { DECK, LAUNCH, SIGNAL, VALIDATOR, VISUAL } from '../config/balance'
import { bossFor } from '../config/rounds'
import { deriveRng, mintSeed } from './rng'
import { RunState, type Phase } from './state'
import { Launcher } from '../sim/launcher'
import { cardLabel, type Card } from '../sim/deck'
import {
  initPhysics, makeStepEvents, PhysicsWorld,
  type OrbHandle, type StepEvents,
} from '../sim/physics'
import {
  computeLayerBonus, Pass, returnsToken, scoreLanding, scorePin,
  type EchoPayout, type ScoreEvent, type ScoringContext,
} from '../sim/scoring'
import {
  buildSignalGraph, makeSignalResult, propagate,
  type SignalGraph, type SignalResult,
} from '../sim/propagation'
import { resolveCriticalStrike } from '../sim/effects'
import { generateBoard, boardRngFor } from '../sim/boardgen'
import { probeBoard } from '../sim/validator'
import {
  isAttentionHead,
  type Board, type BucketTransform, type NodeDef, type NodeTransform,
} from '../sim/board'
import { Renderer } from '../render/scene'
import { BoardView } from '../render/boardView'
import { OrbView } from '../render/orbView'
import { Background } from '../render/background'
import { Audio } from '../audio/sound'
import { Hud } from '../ui/hud'
import { Overlays } from '../ui/overlays'
import { applyPurchase, rollStock, type Offer } from './shopkeeper'

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
  private signal: SignalResult = makeSignalResult()
  private graph: SignalGraph | null = null
  private layerBonus: number[] = []
  private clock = new THREE.Clock()

  private passRestitution = 0
  private passExtraHops = 0
  private passIsDud = false
  private detonatedThisPass: NodeDef[] = []
  private pendingEchoes: EchoPayout[] = []

  /** Layers rendered inert by a boss modifier, counted from the bottom. */
  private deadLayers = 0

  private displayHeat = 0
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
  // Boot and run lifecycle
  // -------------------------------------------------------------------------

  async boot(seed: string): Promise<void> {
    await initPhysics()
    this.physics = new PhysicsWorld()
    this.installInput()
    this.hud.bindMuteToggle(() => this.hud.setMuted(this.audio.toggleMute()))
    this.hud.setMuted(this.audio.muted)
    this.startRun(seed)
    this.loop()
  }

  startRun(seed: string): void {
    this.run = new RunState(seed)
    this.launcher = new Launcher()
    this.pass.reset()
    this.pendingEchoes.length = 0
    this.hud.setSeed(seed)
    this.hud.invalidate()
    this.hud.clearPopups()
    this.updateSeedInUrl(seed)

    this.boardView.clear()
    this.board = this.buildRunBoard()
    this.physics.loadBoard(this.board)
    this.boardView.build(this.board)
    this.rebuildBoardCaches()

    this.beginBenchmark()
  }

  /**
   * The one board this run is played on. Geometry is fixed; the seed varies
   * wiring and starting state. The validator runs here and only here, so it
   * can afford to be thorough.
   */
  private buildRunBoard(): Board {
    const { seed } = this.run
    for (let attempt = 0; attempt < VALIDATOR.maxAttempts; attempt++) {
      const candidate = generateBoard(boardRngFor(seed, attempt), `${seed}/a${attempt}`)
      candidate.stats = probeBoard(candidate, seed, attempt)
      if (candidate.stats.accepted) return candidate
    }
    const last = generateBoard(boardRngFor(seed, 0), `${seed}/fallback`)
    last.stats = { ...probeBoard(last, seed, 0), fallback: true, accepted: true }
    return last
  }

  private rebuildBoardCaches(): void {
    if (!this.board) return
    this.graph = buildSignalGraph(this.board)
    this.layerBonus = computeLayerBonus(this.board)
  }

  // -------------------------------------------------------------------------
  // Benchmarks
  // -------------------------------------------------------------------------

  private beginBenchmark(): void {
    const board = this.board
    if (!board) throw new Error('beginBenchmark before the run board was built')

    this.run.phase = 'brief'
    this.physics.despawnAllOrbs()
    this.orbView.releaseAll()
    this.pass.reset()
    this.detonatedThisPass.length = 0
    this.pendingEchoes.length = 0
    this.boardView.resetPass(board)

    this.run.beginBenchmark(deriveRng(this.run.seed, 'draw', this.run.benchmarkIndex))

    // Boss modifiers apply for this benchmark only.
    const boss = bossFor(this.run.benchmark)
    this.deadLayers = boss?.deadLayers ?? 0
    this.boardView.setDeadLayers(this.deadLayers, board)

    this.launcher.enabled = false
    this.chamberNext()
    this.syncHud()
    this.overlays.brief(this.run, board, () => this.beginPlay())
  }

  private beginPlay(): void {
    this.audio.unlock()
    this.audio.uiConfirm()
    this.overlays.close()
    this.run.phase = 'aim'
    this.launcher.enabled = true
    this.syncHud()
  }

  /** Pull the next card from the queue into the chamber. */
  private chamberNext(): void {
    const rng = deriveRng(this.run.seed, 'draw', this.run.benchmarkIndex, this.run.totals.passesFired)
    this.launcher.loaded = this.run.deck.draw(rng)
  }

  // -------------------------------------------------------------------------
  // Firing
  // -------------------------------------------------------------------------

  private tryLaunch(): void {
    if (this.run.phase !== 'aim') return
    if (!this.run.canFire) {
      this.launcher.cancelCharge()
      this.hud.flash('NO ACTIVATIONS LEFT', 'var(--red)')
      this.audio.uiDenied()
      return
    }

    const charge = this.launcher.charge
    const roll = deriveRng(
      this.run.seed, 'launch', this.run.benchmarkIndex, this.run.totals.passesFired,
    )
    const spec = this.launcher.release(this.run.mods, roll)
    if (!spec) return

    this.run.spend()
    this.pass.reset()
    this.restoreDetonated()
    if (this.board) this.boardView.resetPass(this.board)
    this.bankEchoes()

    this.passRestitution = spec.restitution
    this.passExtraHops = spec.extraHops
    this.passIsDud = spec.poisonedDud
    if (this.passIsDud) this.hud.flash('CONTAMINATED BATCH', 'var(--red)')

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

    this.audio.launch(charge, 0.4)
    this.run.phase = 'resolving'
    this.launcher.enabled = false
    this.syncHud()
  }

  /** Checkpoint / Cache Hit pay out at the START of the next pass. */
  private bankEchoes(): void {
    if (this.pendingEchoes.length === 0) return
    for (const echo of this.pendingEchoes) {
      this.pass.score += echo.points
      this.emitPopup({ points: echo.points, x: echo.x, y: echo.y, kind: 'echo', tierMult: 1 })
    }
    this.pendingEchoes.length = 0
  }

  private tryOverride(): void {
    if (this.run.phase !== 'resolving' || this.run.overridesLeft <= 0) return
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
  // Resolution
  // -------------------------------------------------------------------------

  private scoringContext(): ScoringContext {
    return {
      mods: this.run.mods,
      tempScoreMult: 1,
      tempValue: 0,
      layerBonus: this.layerBonus,
      rng: deriveRng(
        this.run.seed, 'roll', this.run.benchmarkIndex,
        this.run.totals.passesFired, this.pass.struck.size,
      ),
    }
  }

  /** Boss modifiers can render the lowest layers inert. */
  private isInert(node: NodeDef): boolean {
    if (this.deadLayers <= 0 || !this.board) return false
    return node.layer >= this.board.layers - this.deadLayers
  }

  private handleEvents(): void {
    const ctx = this.scoringContext()

    for (const hit of this.events.pinHits) {
      if (this.isInert(hit.pin)) continue
      const ev = scorePin(this.pass, hit.pin, hit.orb, ctx)
      if (!ev) continue

      this.boardView.strike(hit.pin)
      this.emitPopup(ev)
      this.run.totals.pinsStruck++
      if (ev.kind === 'hallucination' || ev.kind === 'critical') this.renderer.punch(0.22)

      if (ev.kind === 'hallucination') this.audio.hallucination()
      else if (isAttentionHead(hit.pin)) this.audio.criticalTick(this.pass.chain, 0.5)
      else this.audio.pinTick(this.pass.chain, 0.3)

      if (isAttentionHead(hit.pin)) this.resolveCritical(hit.pin, hit.orb, ctx)
      this.fireSignal(hit.pin, ctx)
    }

    for (const landing of this.events.landings) {
      const boss = bossFor(this.run.benchmark)
      const ev = boss?.noBuckets && landing.pocket.kind !== 'spike'
        ? null
        : scoreLanding(this.pass, landing.pocket, landing.orb, ctx)
      this.orbView.release(landing.orb.id)

      if (returnsToken(landing.pocket) && this.physics.orbCount < LAUNCH.maxOrbsHardCap) {
        const again = this.physics.spawnOrb(
          landing.pocket.x * 0.3, LAUNCH.originY - 0.5, 0, -LAUNCH.minSpeed,
          { restitution: this.passRestitution, launchId: landing.orb.launchId, scoreScale: landing.orb.scoreScale },
        )
        this.orbView.acquire(again)
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

    for (const orb of this.events.culled) {
      this.orbView.release(orb.id)
      this.run.totals.drains++
    }
  }

  /**
   * Run the forward pass and present it. Edge flashes and popups are
   * staggered BY HOP so the player sees a wave travelling down the network;
   * the propagation itself is instantaneous and already scored.
   */
  private fireSignal(origin: NodeDef, ctx: ScoringContext): void {
    if (!this.graph) return

    // Deduplicated data and the Context Collapse boss both act here, by
    // temporarily bending the global signal constants for one wave.
    const tunable = SIGNAL as unknown as { retention: number; floor: number }
    const boss = bossFor(this.run.benchmark)
    const retention0 = tunable.retention
    const floor0 = tunable.floor
    if (boss?.signalMult && boss.signalMult !== 1) tunable.retention *= boss.signalMult
    // Deduplicated acts on the FLOOR, not on maxHops. maxHops is a backstop
    // that never binds in practice — the floor is what actually stops a wave,
    // so raising the hop cap was a no-op and the audit measured the transform
    // at exactly 0%.
    if (this.passExtraHops > 0) {
      tunable.floor = floor0 * Math.pow(SIGNAL.retention, this.passExtraHops)
    }

    propagate(this.graph, this.pass, origin, ctx, this.signal)

    tunable.retention = retention0
    tunable.floor = floor0

    if (this.signal.reached === 0) return

    for (const lit of this.signal.litEdges) {
      window.setTimeout(() => this.boardView.flashEdge(lit.index), lit.hop * VISUAL.signalHopMs)
    }
    for (const ev of this.signal.events) {
      const hop = ev.hop ?? 1
      window.setTimeout(() => {
        const node = ev.nodeId === undefined ? undefined : this.graph?.nodes.get(ev.nodeId)
        if (node) this.boardView.pulse(node)
        if (ev.points > 0) this.emitPopup(ev)
      }, hop * VISUAL.signalHopMs)
      this.run.totals.signalsFired++
    }
    if (this.signal.reached >= 8) this.renderer.punch(0.3)
    this.audio.signal(this.signal.reached)
  }

  private resolveCritical(node: NodeDef, orb: OrbHandle, ctx: ScoringContext): void {
    const outcome = resolveCriticalStrike(
      this.physics, this.pass, node, orb, ctx, this.run.mods, this.passRestitution,
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

  /** Explosive Weights damages the board for one pass only. */
  private restoreDetonated(): void {
    if (this.detonatedThisPass.length === 0) return
    for (const node of this.detonatedThisPass) {
      this.physics.restorePin(node)
      if (this.board) this.boardView.revive(node, this.board)
    }
    this.detonatedThisPass.length = 0
  }

  private emitPopup(ev: ScoreEvent): void {
    const screen = this.renderer.worldToScreen(ev.x, ev.y)
    this.hud.popup(ev, screen.x, screen.y)
  }

  private finishPass(): void {
    // A Poisoned misfire voids the whole pass, decided at launch so the
    // player knows it is coming rather than discovering it in the total.
    if (this.passIsDud) {
      this.pass.score = 0
      this.pass.echoes.length = 0
    }
    this.pendingEchoes = this.pass.echoes.slice()
    this.run.commitPass(this.pass.score, this.pass.money)

    const next: Phase = this.run.resolveAfterPass()
    this.chamberNext()
    this.syncHud()

    if (next === 'aim') {
      this.run.phase = 'aim'
      this.launcher.enabled = true
      return
    }

    if (next === 'cleared') {
      this.run.phase = 'cleared'
      this.audio.stageClear()
      const reward = this.run.applyClearRewards()
      this.syncHud()
      this.overlays.cleared(this.run, reward, () => this.openShop())
      return
    }

    this.run.phase = next
    if (next === 'ipo') {
      this.audio.stageClear()
      this.run.applyClearRewards()
    } else {
      this.audio.runFail()
    }
    this.syncHud()
    this.overlays.runEnd(
      this.run, next === 'ipo',
      () => this.startRun(mintSeed()),
      () => this.startRun(this.run.seed),
    )
  }

  // -------------------------------------------------------------------------
  // Shop
  // -------------------------------------------------------------------------

  private shopRerolls = 0

  private openShop(): void {
    this.run.phase = 'shop'
    this.shopRerolls = 0
    this.showShop()
  }

  private showShop(): void {
    const board = this.board
    if (!board) return
    const rng = deriveRng(this.run.seed, 'shop', this.run.benchmarkIndex, this.shopRerolls)
    const stock = rollStock(this.run, board, rng)
    this.overlays.shop(this.run, board, stock, this.shopRerolls, {
      buy: (offer) => this.buy(offer),
      reroll: () => { this.shopRerolls++; this.showShop() },
      leave: () => this.leaveShop(),
    })
  }

  private buy(offer: Offer): void {
    const board = this.board
    if (!board) return
    if (!this.run.canAfford(offer.price)) {
      this.audio.uiDenied()
      return
    }
    const rng = deriveRng(
      this.run.seed, 'buy', this.run.benchmarkIndex, this.run.totals.itemsBought,
    )
    const result = applyPurchase(offer, this.run, board, rng)
    if (!result.ok) {
      this.audio.uiDenied()
      this.overlays.shopMessage(result.message, false)
      return
    }
    this.run.pay(offer.price, offer.def.id)
    offer.sold = true
    this.audio.uiConfirm()

    if (result.boardChanged) {
      this.physics.loadBoard(board)
      this.boardView.build(board)
      this.boardView.setDeadLayers(this.deadLayers, board)
      this.rebuildBoardCaches()
    }
    this.overlays.shopMessage(result.message, true)
    this.showShop()
  }

  private leaveShop(): void {
    this.overlays.close()
    this.run.advanceBenchmark()
    this.beginBenchmark()
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

    if (this.run.phase === 'aim') {
      if (this.keyLeft) this.launcher.aimBy(-LAUNCH.aimSpeedKeyboard * dt)
      if (this.keyRight) this.launcher.aimBy(LAUNCH.aimSpeedKeyboard * dt)
      if (this.launcher.updateCharge(dt) && this.launcher.charge >= 1) this.tryLaunch()
    }

    if (this.run.phase === 'resolving') {
      this.physics.advance(dt, this.events)
      this.handleEvents()
      if (this.pass.ended && this.physics.orbCount > 0) {
        this.physics.despawnAllOrbs()
        this.orbView.releaseAll()
        this.hud.flash('EOS', 'var(--amber)')
      }
      if (this.physics.orbCount === 0) this.finishPass()
    }

    // Heat now tracks how hard the pass is working rather than a temperature
    // dial: a wide forward pass heats the board, a dud leaves it cold.
    const target = this.run.phase === 'resolving'
      ? Math.min(1, this.pass.signalCount / 45)
      : 0.12
    this.displayHeat += (target - this.displayHeat) * Math.min(1, dt * 4)
    this.renderer.heat = this.displayHeat
    this.background.update(t, this.displayHeat)

    // Pass the in-flight tokens so the board can compute proximity
    // excitation — the hologram's answer to a carried light.
    if (this.board) this.boardView.update(dt, this.board, this.physics?.orbs ?? [])
    this.orbView.tick(t)
    this.orbView.update(this.physics?.orbs ?? [], this.displayHeat)
    this.orbView.updateLauncher(
      this.launcher.angle, this.launcher.charge,
      this.launcher.predictPath(this.run.mods),
      this.run.phase === 'aim',
    )

    if (playing) this.syncHud()
    this.renderer.render(dt)
  }

  private syncHud(): void {
    this.hud.sync({
      run: this.run,
      loaded: this.launcher.loaded,
      upcoming: this.run.deck.peek(DECK.previewCount),
      chain: this.pass.chain,
      tierMult: this.pass.tierMult(this.run.mods),
      passScore: this.pass.score,
      signalCount: this.pass.signalCount,
      charging: this.launcher.charging,
      charge: this.launcher.charge,
    })
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  private installInput(): void {
    window.addEventListener('keydown', (e) => {
      this.audio.unlock()
      if (e.key === 'm' || e.key === 'M') {
        const muted = this.audio.toggleMute()
        this.hud.setMuted(muted)
        this.hud.flash(muted ? 'AUDIO MUTED' : 'AUDIO ON', 'var(--dim)')
        return
      }
      if (this.overlays.isOpen) {
        if (e.key === 'r' || e.key === 'R') this.startRun(mintSeed())
        return
      }
      switch (e.key) {
        case 'ArrowLeft': case 'a': case 'A':
          this.keyLeft = true; e.preventDefault(); break
        case 'ArrowRight': case 'd': case 'D':
          this.keyRight = true; e.preventDefault(); break
        case ' ':
          e.preventDefault()
          if (this.run.phase === 'aim' && !this.launcher.charging) {
            this.launcher.beginCharge()
            this.audio.chargeStart()
          }
          break
        case 'e': case 'E': this.tryOverride(); break
        case 'r': case 'R': this.startRun(mintSeed()); break
      }
    })

    window.addEventListener('keyup', (e) => {
      switch (e.key) {
        case 'ArrowLeft': case 'a': case 'A': this.keyLeft = false; break
        case 'ArrowRight': case 'd': case 'D': this.keyRight = false; break
        case ' ': if (this.launcher.charging) this.tryLaunch(); break
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
    canvas.addEventListener('pointerleave', () => {
      if (this.launcher.charging) this.tryLaunch()
    })

    document.getElementById('seed-new')?.addEventListener('click', () => this.startRun(mintSeed()))
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

  // -------------------------------------------------------------------------
  // Debug console API
  // -------------------------------------------------------------------------

  get debug() {
    const refresh = () => {
      if (!this.board) return
      this.rebuildBoardCaches()
      this.boardView.build(this.board)
      this.boardView.setDeadLayers(this.deadLayers, this.board)
      this.physics.loadBoard(this.board)
    }
    return {
      money: (n: number) => { this.run.money = n; this.syncHud() },
      level: (n: number) => {
        for (const node of this.board?.nodes ?? []) node.level = n
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
      skipTo: (index: number) => {
        this.run.benchmarkIndex = Math.max(0, Math.min(23, index))
        this.overlays.close()
        this.beginBenchmark()
      },
      deck: () => this.run.deck.cards.map((c: Card) => `#${c.id} ${cardLabel(c)}`),
      report: () => {
        const b = this.board
        if (!b) return 'no board'
        const byTransform = new Map<string, number>()
        for (const n of b.nodes) for (const t of n.transforms) {
          byTransform.set(t, (byTransform.get(t) ?? 0) + 1)
        }
        return {
          benchmark: `${this.run.benchmark.roundName} · ${this.run.benchmark.name}`,
          target: this.run.target,
          money: this.run.money,
          activations: `${this.run.activations}/${this.run.benchmarkActivations}`,
          deck: this.run.deck.size,
          nodes: b.nodes.filter((n) => !n.removed).length,
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
