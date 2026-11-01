/**
 * launcher.ts — aim, charge, and the loaded card.
 *
 * Temperature is gone. It was v1's per-launch decision, and the deck replaces
 * it: what you fire is decided by the draw queue, and your only response to
 * what arrives is where you aim it. Risk is now something you BUILD (by what
 * you put in the deck) rather than something you dial in before each shot.
 *
 * The physical character of a launch therefore comes from the card: arXiv is
 * heavy and punches straight down, RLHF is light and skips wide, Synthetic
 * rolls its own value every time.
 */

import { LAUNCH, ORB, PHYSICS } from '../config/balance'
import type { Mods } from '../config/mods'
import { CARD_TYPES, cardValue, type Card } from './deck'

export interface LaunchSpec {
  orbs: { x: number; y: number; vx: number; vy: number }[]
  restitution: number
  /** The card's value multiplier, already rolled for volatile types. */
  scoreScale: number
  card: Card
  /** Extra propagation hops this token grants (Deduplicated). */
  extraHops: number
  /** This pass scores nothing (Poisoned misfire). Decided at launch. */
  poisonedDud: boolean
}

export class Launcher {
  angle = 0
  charge = 0
  charging = false
  enabled = true

  /** The card currently chambered. Set by the game from the draw queue. */
  loaded: Card | null = null

  aimBy(delta: number): void {
    this.angle = clamp(this.angle + delta, -LAUNCH.maxAngle, LAUNCH.maxAngle)
  }

  aimAt(worldX: number, worldY: number): void {
    const a = Math.atan2(worldX, -(worldY - LAUNCH.originY))
    this.angle = clamp(a, -LAUNCH.maxAngle, LAUNCH.maxAngle)
  }

  beginCharge(): void {
    if (!this.enabled) return
    this.charging = true
    this.charge = 0
  }

  updateCharge(dt: number): boolean {
    if (!this.charging) return false
    this.charge = Math.min(1, this.charge + dt / LAUNCH.chargeTime)
    return true
  }

  cancelCharge(): void {
    this.charging = false
    this.charge = 0
  }

  /**
   * Release and produce the launch spec from the chambered card.
   * `roll` supplies the volatility and misfire draws, so they stay seeded.
   */
  release(mods: Mods, roll: { next(): number; range(a: number, b: number): number }): LaunchSpec | null {
    if (!this.charging || !this.enabled || !this.loaded) return null
    this.charging = false

    const card = this.loaded
    const def = CARD_TYPES[card.type]

    const speed =
      (LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * this.charge) * def.speed
    const count = Math.max(1, Math.min(mods.orbsPerLaunch, LAUNCH.maxOrbsHardCap))

    const orbs: LaunchSpec['orbs'] = []
    for (let i = 0; i < count; i++) {
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * LAUNCH.multiOrbSpread
      const a = clamp(this.angle + offset, -LAUNCH.maxAngle, LAUNCH.maxAngle)
      orbs.push({
        x: Math.sin(a) * 0.45,
        y: LAUNCH.originY - 0.5,
        vx: Math.sin(a) * speed,
        vy: -Math.cos(a) * speed,
      })
    }

    let scoreScale = cardValue(card) * mods.orbScoreMult
    if (def.volatile) scoreScale *= roll.range(def.volatile[0], def.volatile[1])

    this.charge = 0

    return {
      orbs,
      restitution: ORB.restitution * def.bounce,
      scoreScale,
      card,
      extraHops: card.transforms.includes('deduplicated') ? 1 : 0,
      poisonedDud:
        card.transforms.includes('poisoned') && roll.next() < POISON_DUD_CHANCE,
    }
  }

  muzzle(): { x: number; y: number } {
    return { x: Math.sin(this.angle) * 1.5, y: LAUNCH.originY - Math.cos(this.angle) * 1.5 }
  }

  /**
   * Ballistic preview for Attention Mask: gravity only, no collisions.
   * Deliberately approximate — a collision-accurate preview would remove the
   * tension that makes aiming interesting.
   */
  predictPath(mods: Mods, chargeOverride?: number): { x: number; y: number }[] {
    if (!mods.showTrajectory) return []
    const def = this.loaded ? CARD_TYPES[this.loaded.type] : null
    const c = chargeOverride ?? (this.charging ? this.charge : 0.65)
    const speed =
      (LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * c) * (def?.speed ?? 1)
    let x = Math.sin(this.angle) * 0.45
    let y = LAUNCH.originY - 0.5
    let vx = Math.sin(this.angle) * speed
    let vy = -Math.cos(this.angle) * speed

    const pts: { x: number; y: number }[] = [{ x, y }]
    const steps = Math.ceil(mods.trajectorySeconds / PHYSICS.dt)
    for (let i = 0; i < steps; i++) {
      vy += PHYSICS.gravity * PHYSICS.dt
      x += vx * PHYSICS.dt
      y += vy * PHYSICS.dt
      if (i % 4 === 0) pts.push({ x, y })
      if (y < -9) break
    }
    return pts
  }
}

import { DECK } from '../config/balance'
const POISON_DUD_CHANCE = DECK.poisonedDudChance

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
