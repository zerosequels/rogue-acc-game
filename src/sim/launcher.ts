/**
 * launcher.ts — aim, charge, and temperature selection.
 *
 * The player's entire input surface is three decisions per forward pass:
 *   1. which direction  (aim)
 *   2. how hard         (charge)
 *   3. how hot          (temperature)
 *
 * Temperature is the interesting one, and the reason this game does not have a
 * Frenzy meter. A meter that fills during a cascade is something the player
 * watches; a temperature you set before firing is something the player decides.
 * Same fantasy, same escalating visuals, but the risk is chosen rather than
 * observed — and "temperature" is literally a pre-generation sampling knob, so
 * the metaphor gets more correct rather than less.
 */

import { LAUNCH, ORB, TEMPERATURES, DEFAULT_TEMP_INDEX, PHYSICS, type TemperatureTier } from '../config/balance'
import type { Mods } from '../config/upgrades'

export interface LaunchSpec {
  /** Per-orb spawn parameters, already fanned for multi-orb launches. */
  orbs: { x: number; y: number; vx: number; vy: number }[]
  restitution: number
  scoreScale: number
  tier: TemperatureTier
  cost: number
}

export class Launcher {
  /** Radians from straight down; negative is left. */
  angle = 0
  /** 0..1 */
  charge = 0
  charging = false
  tempIndex = DEFAULT_TEMP_INDEX

  /** Set false while a pass resolves, so input cannot queue a second launch. */
  enabled = true

  get tier(): TemperatureTier {
    return TEMPERATURES[this.tempIndex]!
  }

  /** Activation cost of the current temperature after upgrades. */
  costOf(tier: TemperatureTier, mods: Mods): number {
    return Math.max(1, tier.cost - mods.tempCostReduction)
  }

  availableTiers(mods: Mods): TemperatureTier[] {
    return TEMPERATURES.filter((t) => !t.locked || mods.unlockRogueTemp)
  }

  /** Clamp selection if an upgrade was lost or the tier is unaffordable. */
  normaliseSelection(mods: Mods): void {
    const tier = TEMPERATURES[this.tempIndex]
    if (!tier || (tier.locked && !mods.unlockRogueTemp)) {
      this.tempIndex = DEFAULT_TEMP_INDEX
    }
  }

  selectTemp(index: number, mods: Mods): boolean {
    const tier = TEMPERATURES[index]
    if (!tier) return false
    if (tier.locked && !mods.unlockRogueTemp) return false
    this.tempIndex = index
    return true
  }

  aimBy(delta: number): void {
    this.angle = clamp(this.angle + delta, -LAUNCH.maxAngle, LAUNCH.maxAngle)
  }

  /** Point the launcher at a world position (mouse aiming). */
  aimAt(worldX: number, worldY: number): void {
    const dx = worldX - 0
    const dy = worldY - LAUNCH.originY
    // Angle from straight down.
    const a = Math.atan2(dx, -dy)
    this.angle = clamp(a, -LAUNCH.maxAngle, LAUNCH.maxAngle)
  }

  beginCharge(): void {
    if (!this.enabled) return
    this.charging = true
    this.charge = 0
  }

  /** Advance the charge meter. Returns true while still charging. */
  updateCharge(dt: number): boolean {
    if (!this.charging) return false
    this.charge = Math.min(1, this.charge + dt / LAUNCH.chargeTime)
    return true
  }

  /** Release and produce the launch spec. Returns null if not charging. */
  release(mods: Mods): LaunchSpec | null {
    if (!this.charging || !this.enabled) return null
    this.charging = false

    const tier = this.tier
    const speed = LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * this.charge
    const count = Math.max(1, Math.min(mods.orbsPerLaunch, LAUNCH.maxOrbsHardCap))

    const orbs: LaunchSpec['orbs'] = []
    for (let i = 0; i < count; i++) {
      // Fan multi-orb launches symmetrically around the aim line.
      const offset = count === 1 ? 0 : (i - (count - 1) / 2) * LAUNCH.multiOrbSpread
      const a = clamp(this.angle + offset, -LAUNCH.maxAngle, LAUNCH.maxAngle)
      orbs.push({
        x: Math.sin(a) * 0.45,
        y: LAUNCH.originY - 0.5,
        vx: Math.sin(a) * speed,
        vy: -Math.cos(a) * speed,
      })
    }

    this.charge = 0

    return {
      orbs,
      restitution: ORB.restitution * tier.bounce,
      scoreScale: mods.orbScoreMult,
      tier,
      cost: this.costOf(tier, mods),
    }
  }

  cancelCharge(): void {
    this.charging = false
    this.charge = 0
  }

  /** Muzzle position, for rendering the launcher barrel. */
  muzzle(): { x: number; y: number } {
    return { x: Math.sin(this.angle) * 1.5, y: LAUNCH.originY - Math.cos(this.angle) * 1.5 }
  }

  /**
   * Ballistic preview for the Attention Mask upgrade: gravity only, no
   * collisions. Deliberately approximate — the flavour text says "roughly",
   * and a collision-accurate preview would remove the tension that makes
   * aiming interesting.
   */
  predictPath(mods: Mods, chargeOverride?: number): { x: number; y: number }[] {
    if (!mods.showTrajectory) return []
    const c = chargeOverride ?? (this.charging ? this.charge : 0.65)
    const speed = LAUNCH.minSpeed + (LAUNCH.maxSpeed - LAUNCH.minSpeed) * c
    let x = Math.sin(this.angle) * 0.45
    let y = LAUNCH.originY - 0.5
    let vx = Math.sin(this.angle) * speed
    let vy = -Math.cos(this.angle) * speed

    const pts: { x: number; y: number }[] = [{ x, y }]
    const steps = Math.ceil(mods.trajectorySeconds / PHYSICS.dt)
    const sub = 4 // sample every 4th step; the line stays smooth enough
    for (let i = 0; i < steps; i++) {
      vy += PHYSICS.gravity * PHYSICS.dt
      x += vx * PHYSICS.dt
      y += vy * PHYSICS.dt
      if (i % sub === 0) pts.push({ x, y })
      if (y < -9) break
    }
    return pts
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
