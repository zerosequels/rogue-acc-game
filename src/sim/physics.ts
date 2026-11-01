/**
 * physics.ts — Rapier2D wrapper.
 *
 * Chose Rapier over cannon-es for one reason: determinism. Rapier produces
 * identical results for a given build and input sequence, which is what lets a
 * seed mean something beyond "same board layout". cannon-es makes no such
 * guarantee.
 *
 * Two rules this file enforces and nothing else may break:
 *
 *   1. FIXED TIMESTEP. The world is only ever stepped with PHYSICS.dt. Stepping
 *      with frame delta destroys determinism and makes bounce tuning
 *      framerate-dependent. The accumulator lives in `advance()`.
 *
 *   2. VELOCITY CLAMP every step. Small fast orbs against thin-ish pins is the
 *      classic tunnelling setup. CCD is on as well, but the clamp is the real
 *      insurance — and it keeps cascades readable instead of a blur.
 *
 * The same class serves the live game and the headless validator; the validator
 * just steps it without ever rendering.
 */

import RAPIER from '@dimforge/rapier2d-compat'
import { BOARD, ORB, PHYSICS, PIN } from '../config/balance'
import type { Board, PinDef, PocketDef } from './board'

let ready = false

/** Must be awaited once before any PhysicsWorld is constructed. */
export async function initPhysics(): Promise<void> {
  if (ready) return
  await RAPIER.init()
  ready = true
}

export interface OrbHandle {
  readonly id: number
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  /** Distinct pin ids already scored by THIS orb's launch (shared per launch). */
  x: number
  y: number
  vx: number
  vy: number
  age: number
  slowFor: number
  /** Generation index, used so split orbs inherit launch bookkeeping. */
  launchId: number
  alive: boolean
  /** Scales this orb's contribution — multi-orb launches pay less per orb. */
  scoreScale: number
}

export interface PinHit {
  pin: PinDef
  orb: OrbHandle
  /** World position of the contact, for popups and flashes. */
  x: number
  y: number
  speed: number
}

export interface PocketLanding {
  orb: OrbHandle
  pocket: PocketDef
}

export interface StepEvents {
  pinHits: PinHit[]
  landings: PocketLanding[]
  /** Orbs culled for being stuck or outliving ORB.maxLifetime. */
  culled: OrbHandle[]
}

export class PhysicsWorld {
  private world: RAPIER.World
  private queue: RAPIER.EventQueue
  private accumulator = 0
  private nextOrbId = 1

  /** collider handle → pin, for resolving collision events. */
  private pinByCollider = new Map<number, PinDef>()
  /** pin id → collider, so pruning/detonation can remove them. */
  private colliderByPin = new Map<number, RAPIER.Collider>()
  private orbByCollider = new Map<number, OrbHandle>()

  readonly orbs: OrbHandle[] = []
  private board: Board | null = null

  /** Reusable vectors — allocating per step in a 120Hz loop is wasteful. */
  private readonly tmp = { x: 0, y: 0 }

  constructor() {
    if (!ready) throw new Error('initPhysics() must be awaited before PhysicsWorld')
    this.world = new RAPIER.World({ x: 0, y: PHYSICS.gravity })
    this.world.timestep = PHYSICS.dt
    this.queue = new RAPIER.EventQueue(true)
  }

  // -------------------------------------------------------------------------
  // Board construction
  // -------------------------------------------------------------------------

  /** Build walls, pins and pocket dividers for a board. Replaces any previous. */
  loadBoard(board: Board): void {
    this.clear()
    this.board = board
    this.buildWalls(board)
    for (const pin of board.pins) {
      if (pin.removed) continue
      this.addPin(pin)
    }
    this.buildPocketWalls(board)
  }

  private addPin(pin: PinDef): void {
    const desc = RAPIER.ColliderDesc.ball(pin.radius)
      .setTranslation(pin.x, pin.y)
      .setRestitution(PIN.restitution)
      .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
      .setFriction(PIN.friction)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    const collider = this.world.createCollider(desc)
    this.pinByCollider.set(collider.handle, pin)
    this.colliderByPin.set(pin.id, collider)
  }

  /** Remove a pin from the sim (Prune Dead Neurons, Explosive Weights). */
  removePin(pin: PinDef): void {
    const collider = this.colliderByPin.get(pin.id)
    if (!collider) return
    this.pinByCollider.delete(collider.handle)
    this.colliderByPin.delete(pin.id)
    this.world.removeCollider(collider, false)
    pin.removed = true
  }

  /**
   * Put a detonated pin back. Explosive Weights destroys weights DURING a
   * pass only — the board is rebuilt between passes.
   *
   * Permanent destruction was measured at -28% in `tools/upgrades.ts`: paying
   * 0.75x once to delete a weight for every remaining pass of the stage is a
   * terrible trade, and it silently degraded the board as the stage went on.
   */
  restorePin(pin: PinDef): void {
    if (this.colliderByPin.has(pin.id)) return
    pin.removed = false
    this.addPin(pin)
  }

  private buildWalls(board: Board): void {
    const t = BOARD.wallThickness
    const halfW = BOARD.width / 2
    const midY = (BOARD.top + board.floorY) / 2
    const halfH = (BOARD.top - board.floorY) / 2 + t

    const make = (hx: number, hy: number, x: number, y: number) => {
      const desc = RAPIER.ColliderDesc.cuboid(hx, hy)
        .setTranslation(x, y)
        .setRestitution(PHYSICS.wallRestitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(0.05)
      this.world.createCollider(desc)
    }

    make(t / 2, halfH, -halfW + t / 2, midY) // left rail
    make(t / 2, halfH, halfW - t / 2, midY) // right rail
    make(halfW, t / 2, 0, board.floorY - t / 2) // floor
  }

  /** Dividers between bottom pockets. These are what make aiming matter. */
  private buildPocketWalls(board: Board): void {
    const h = board.pocketTopY - board.floorY
    const midY = board.floorY + h / 2
    for (const pocket of board.pockets) {
      for (const side of [-1, 1] as const) {
        const x = pocket.x + side * pocket.halfWidth
        if (Math.abs(x) >= BOARD.width / 2 - BOARD.wallThickness) continue
        const desc = RAPIER.ColliderDesc.cuboid(0.07, h / 2)
          .setTranslation(x, midY)
          .setRestitution(0.3)
          .setFriction(0.05)
        this.world.createCollider(desc)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Orbs
  // -------------------------------------------------------------------------

  spawnOrb(
    x: number,
    y: number,
    vx: number,
    vy: number,
    opts: { restitution: number; launchId: number; scoreScale: number },
  ): OrbHandle {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y)
        .setLinvel(vx, vy)
        .setLinearDamping(ORB.linearDamping)
        .setCcdEnabled(true),
    )
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(ORB.radius)
        .setRestitution(opts.restitution)
        .setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
        .setFriction(ORB.friction)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      body,
    )

    const orb: OrbHandle = {
      id: this.nextOrbId++,
      body,
      collider,
      x,
      y,
      vx,
      vy,
      age: 0,
      slowFor: 0,
      launchId: opts.launchId,
      alive: true,
      scoreScale: opts.scoreScale,
    }
    this.orbs.push(orb)
    this.orbByCollider.set(collider.handle, orb)
    return orb
  }

  despawnOrb(orb: OrbHandle): void {
    if (!orb.alive) return
    orb.alive = false
    this.orbByCollider.delete(orb.collider.handle)
    this.world.removeRigidBody(orb.body)
    const i = this.orbs.indexOf(orb)
    if (i >= 0) this.orbs.splice(i, 1)
  }

  despawnAllOrbs(): void {
    for (const orb of this.orbs.slice()) this.despawnOrb(orb)
  }

  get orbCount(): number {
    return this.orbs.length
  }

  /** Mid-air redirect (Agentic Override). Preserves speed, changes heading. */
  redirectOrb(orb: OrbHandle, angleFromDown: number, speedScale = 1): void {
    const speed = Math.hypot(orb.vx, orb.vy) * speedScale
    const vx = Math.sin(angleFromDown) * speed
    const vy = -Math.cos(angleFromDown) * speed
    orb.body.setLinvel({ x: vx, y: vy }, true)
  }

  // -------------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------------

  /**
   * Advance by real elapsed time using a fixed-step accumulator.
   * Returns everything that happened, batched.
   */
  advance(elapsed: number, out: StepEvents): StepEvents {
    out.pinHits.length = 0
    out.landings.length = 0
    out.culled.length = 0

    this.accumulator += Math.min(elapsed, 0.25)
    let steps = 0
    while (this.accumulator >= PHYSICS.dt && steps < PHYSICS.maxStepsPerFrame) {
      this.accumulator -= PHYSICS.dt
      steps++
      this.stepOnce(out)
    }
    // If we blew the step budget, drop the backlog rather than spiral.
    if (steps >= PHYSICS.maxStepsPerFrame) this.accumulator = 0
    return out
  }

  /** One fixed tick. The validator calls this directly for exact step counts. */
  stepOnce(out: StepEvents): void {
    this.world.step(this.queue)

    this.queue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return
      const pin = this.pinByCollider.get(h1) ?? this.pinByCollider.get(h2)
      if (!pin || pin.removed) return
      const orb = this.orbByCollider.get(h1) ?? this.orbByCollider.get(h2)
      if (!orb || !orb.alive) return
      out.pinHits.push({
        pin,
        orb,
        x: pin.x,
        y: pin.y,
        speed: Math.hypot(orb.vx, orb.vy),
      })
    })

    const board = this.board
    for (const orb of this.orbs.slice()) {
      if (!orb.alive) continue

      const pos = orb.body.translation(this.tmp)
      orb.x = pos.x
      orb.y = pos.y

      const vel = orb.body.linvel(this.tmp)
      let vx = vel.x
      let vy = vel.y

      // --- rule 2: clamp speed ---
      const speed = Math.hypot(vx, vy)
      if (speed > ORB.maxSpeed) {
        const k = ORB.maxSpeed / speed
        vx *= k
        vy *= k
        orb.body.setLinvel({ x: vx, y: vy }, true)
      }
      orb.vx = vx
      orb.vy = vy

      orb.age += PHYSICS.dt
      orb.slowFor = speed < ORB.stuckSpeed ? orb.slowFor + PHYSICS.dt : 0

      // --- pocket resolution: immediate on entering a channel ---
      if (board && orb.y < board.pocketTopY - 0.25) {
        const pocket = pocketAt(board, orb.x)
        if (pocket) {
          out.landings.push({ orb, pocket })
          this.despawnOrb(orb)
          continue
        }
      }

      // --- cull: stuck, expired, or escaped the board ---
      const escaped = board ? orb.y < board.floorY - 2 : orb.y < -14
      if (
        orb.slowFor > ORB.stuckSeconds ||
        orb.age > ORB.maxLifetime ||
        escaped ||
        Math.abs(orb.x) > BOARD.width
      ) {
        out.culled.push(orb)
        this.despawnOrb(orb)
      }
    }
  }

  /** Pins within `radius` of a point, for Explosive Weights. */
  pinsNear(x: number, y: number, radius: number, exclude?: PinDef): PinDef[] {
    const hits: PinDef[] = []
    const r2 = radius * radius
    for (const pin of this.pinByCollider.values()) {
      if (pin.removed || pin === exclude) continue
      const dx = pin.x - x
      const dy = pin.y - y
      if (dx * dx + dy * dy <= r2) hits.push(pin)
    }
    return hits
  }

  clear(): void {
    this.despawnAllOrbs()
    this.pinByCollider.clear()
    this.colliderByPin.clear()
    this.orbByCollider.clear()
    this.world.free()
    this.world = new RAPIER.World({ x: 0, y: PHYSICS.gravity })
    this.world.timestep = PHYSICS.dt
    this.queue.free()
    this.queue = new RAPIER.EventQueue(true)
    this.accumulator = 0
    this.board = null
  }

  dispose(): void {
    this.world.free()
    this.queue.free()
  }
}

export function makeStepEvents(): StepEvents {
  return { pinHits: [], landings: [], culled: [] }
}

/** Which pocket owns this x position, if any. */
export function pocketAt(board: Board, x: number): PocketDef | null {
  for (const p of board.pockets) {
    if (x >= p.x - p.halfWidth && x <= p.x + p.halfWidth) return p
  }
  return null
}
