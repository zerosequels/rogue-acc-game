/**
 * board.ts — the pure data description of one model configuration.
 *
 * A Board is plain geometry and metadata: no physics handles, no meshes. The
 * physics layer consumes it to build colliders; the render layer consumes it to
 * build meshes. Keeping it inert is what lets the validator simulate a
 * candidate board cheaply and throw it away.
 */

export type PocketKind = 'spike' | 'drain' | 'pocket'

export interface PinDef {
  readonly id: number
  x: number
  y: number
  radius: number
  /** Attention heads: higher value, advance a full multiplier tier, and are the
   *  trigger for Chain Reaction and Explosive Weights. */
  critical: boolean
  /** Layer index, used for depth-tinting and flavour readouts. */
  layer: number
  /** Pruned pins stay in the array (stable ids) but are inert and invisible. */
  removed: boolean
}

export interface PocketDef {
  readonly kind: PocketKind
  /** Centre x and half-width of the pocket mouth. */
  x: number
  halfWidth: number
}

export interface Board {
  readonly seedLabel: string
  readonly layers: number
  readonly pins: PinDef[]
  readonly pockets: PocketDef[]
  /** y of the pocket floor. */
  readonly floorY: number
  /** y of the top of the pocket divider walls. */
  readonly pocketTopY: number
  readonly architecture: string
  /** Diagnostics from the validator, surfaced in the stage intro. */
  stats: BoardStats
}

export interface BoardStats {
  attempts: number
  medianPins: number
  settleRate: number
  maxAlive: number
  accepted: boolean
  /** True when generation fell back to the handcrafted safety board. */
  fallback: boolean
}

export function emptyStats(): BoardStats {
  return { attempts: 0, medianPins: 0, settleRate: 0, maxAlive: 0, accepted: false, fallback: false }
}

export function activePins(board: Board): PinDef[] {
  return board.pins.filter((p) => !p.removed)
}

export function countActive(board: Board): number {
  let n = 0
  for (const p of board.pins) if (!p.removed) n++
  return n
}
