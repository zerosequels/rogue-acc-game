/**
 * validator.ts — headless playability guard for generated boards.
 *
 * This is NOT a design system. The generator is responsible for making boards
 * that are fun; this only rejects boards that are actively broken — ones where
 * orbs wedge between pins forever, or where a drop falls through a gap and
 * strikes almost nothing. A good generator still emits those occasionally, and
 * one unplayable stage in a run is worse than any amount of sameness.
 *
 * Method: fire VALIDATOR.probeDrops orbs across the full aim cone into a
 * throwaway physics world, step each for at most probeSeconds, and measure
 *
 *   medianPins  — is there actually a cascade here?
 *   settleRate  — do orbs reach the bottom, or do they wedge?
 *   maxAlive    — did anything run to the lifetime ceiling?
 *
 * Probes use a dedicated RNG stream, so validation never perturbs the board or
 * upgrade streams. Budget is ~24 drops x 960 steps ≈ 23k steps, a few ms.
 */

import { LAUNCH, ORB, PHYSICS, VALIDATOR } from '../config/balance'
import { deriveRng } from '../core/rng'
import type { Board, BoardStats } from './board'
import { makeStepEvents, PhysicsWorld, type StepEvents } from './physics'

export interface ProbeResult {
  pinsHit: number
  settled: boolean
  aliveFor: number
}

/**
 * Simulate probe drops against `board`. Mutates nothing on the board except
 * `stats`. The caller owns accept/reject.
 */
export function probeBoard(board: Board, seed: string, attempt: number): BoardStats {
  const world = new PhysicsWorld()
  const events: StepEvents = makeStepEvents()
  const rng = deriveRng(seed, 'validate', attempt)
  const maxSteps = Math.ceil(VALIDATOR.probeSeconds / PHYSICS.dt)

  const results: ProbeResult[] = []

  for (let i = 0; i < VALIDATOR.probeDrops; i++) {
    // Rebuild the board each probe so pin state and bodies are pristine.
    world.loadBoard(board)

    // Sweep the aim cone evenly, with jitter, so we test the whole input space
    // rather than only the straight-down case.
    const spread = (i / Math.max(1, VALIDATOR.probeDrops - 1)) * 2 - 1
    const angle = spread * LAUNCH.maxAngle * 0.92 + rng.gaussian(0, 0.04)
    const speed = rng.range(LAUNCH.minSpeed, LAUNCH.maxSpeed)

    world.spawnOrb(
      Math.sin(angle) * 0.4,
      LAUNCH.originY - 0.5,
      Math.sin(angle) * speed,
      -Math.cos(angle) * speed,
      { restitution: ORB.restitution, launchId: 0, scoreScale: 1 },
    )

    const seen = new Set<number>()
    let settled = false
    let steps = 0

    for (; steps < maxSteps; steps++) {
      world.stepOnce(events)
      for (const hit of events.pinHits) seen.add(hit.pin.id)
      if (events.landings.length > 0) {
        settled = true
        break
      }
      if (events.culled.length > 0) {
        // A culled orb is a wedge or an escape — explicitly not settled.
        break
      }
      if (world.orbCount === 0) break
    }

    results.push({
      pinsHit: seen.size,
      settled,
      aliveFor: steps * PHYSICS.dt,
    })
    world.despawnAllOrbs()
  }

  world.dispose()

  const pinCounts = results.map((r) => r.pinsHit).sort((a, b) => a - b)
  const mid = Math.floor(pinCounts.length / 2)
  const medianPins =
    pinCounts.length === 0
      ? 0
      : pinCounts.length % 2 === 1
        ? pinCounts[mid]!
        : (pinCounts[mid - 1]! + pinCounts[mid]!) / 2

  const settleRate = results.filter((r) => r.settled).length / Math.max(1, results.length)
  const maxAlive = results.reduce((m, r) => Math.max(m, r.aliveFor), 0)

  const accepted =
    medianPins >= VALIDATOR.minMedianPins &&
    settleRate >= VALIDATOR.minSettleRate &&
    maxAlive < VALIDATOR.maxAliveSeconds

  return { attempts: attempt + 1, medianPins, settleRate, maxAlive, accepted, fallback: false }
}
