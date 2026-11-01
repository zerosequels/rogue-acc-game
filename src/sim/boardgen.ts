/**
 * boardgen.ts — procedural model configurations.
 *
 * Boards are built layer by layer (the theme's "layers" are literal here). Each
 * layer picks a placement pattern, so a board reads as a stack of distinct
 * structures rather than uniform noise — that variety is what makes two seeds
 * feel like different machines.
 *
 * Hard constraint throughout: no two pins closer than PIN.minSpacing, which is
 * derived from orb + pin radii so an orb can always physically pass between
 * neighbours. Violate it and you get invisible walls that eat cascades.
 *
 * Generation is candidate-based: produce a board, hand it to the validator, and
 * regenerate on rejection. See `validator.ts` for why that guard exists.
 */

import { BOARD, PIN, BOARDGEN } from '../config/balance'
import { deriveRng, type Rng } from '../core/rng'
import { architectureLabel } from '../flavor/text'
import { emptyStats, type Board, type PinDef, type PocketDef, type PocketKind } from './board'

type LayerPattern = 'lattice' | 'offset' | 'funnel' | 'arc' | 'cluster' | 'sparse' | 'colonnade'

const PATTERNS: readonly LayerPattern[] = [
  'lattice', 'offset', 'offset', 'funnel', 'arc', 'cluster', 'sparse', 'colonnade',
]

/** Generate one candidate board. Deterministic in `rng`. */
export function generateCandidate(rng: Rng, seedLabel: string): Board {
  const layerCount = rng.int(BOARDGEN.layersMin, BOARDGEN.layersMax)
  const targetPins = rng.int(BOARDGEN.pinCountMin, BOARDGEN.pinCountMax)

  const pocketTopY = BOARD.bottom + BOARDGEN.pocketWallHeight
  const fieldTop = BOARD.top - 1.6
  const fieldBottom = pocketTopY + 0.9
  const fieldHeight = fieldTop - fieldBottom

  const pins: PinDef[] = []
  let nextId = 0

  const halfSpan = BOARD.width / 2 - BOARDGEN.edgeInset

  for (let layer = 0; layer < layerCount; layer++) {
    // t runs 0 (top) → 1 (bottom) across the playfield.
    const t = layerCount === 1 ? 0.5 : layer / (layerCount - 1)
    const y = fieldTop - t * fieldHeight
    const pattern = rng.pick(PATTERNS)
    const perLayer = Math.max(3, Math.round(targetPins / layerCount))

    const positions = layerPositions(rng, pattern, perLayer, halfSpan, t)

    for (const px of positions) {
      const jitterScale = (2 * halfSpan) / Math.max(2, positions.length) * BOARDGEN.jitter
      const x = clamp(px + rng.gaussian(0, jitterScale * 0.5), -halfSpan, halfSpan)
      const yj = y + rng.gaussian(0, fieldHeight / layerCount * BOARDGEN.jitter * 0.5)
      if (!fits(pins, x, yj)) continue
      pins.push({
        id: nextId++,
        x,
        y: clamp(yj, fieldBottom, fieldTop),
        radius: PIN.radius,
        critical: false,
        layer,
        removed: false,
      })
    }
  }

  // Promote a handful of pins to attention heads, biased low on the board so a
  // hit still has cascade left beneath it to pay off.
  const criticalCount = rng.int(BOARDGEN.criticalPinsMin, BOARDGEN.criticalPinsMax)
  const eligible = pins.filter((p) => {
    const t = (fieldTop - p.y) / Math.max(0.001, fieldHeight)
    return t >= BOARDGEN.criticalBiasLow
  })
  const promoted = rng.sample(eligible.length >= criticalCount ? eligible : pins, criticalCount)
  for (const p of promoted) {
    p.critical = true
    p.radius = PIN.criticalRadius
  }
  // Re-check spacing after enlarging criticals; drop any that now overlap.
  for (const p of promoted) {
    for (const q of pins) {
      if (q === p || q.removed) continue
      if (dist(p, q) < p.radius + q.radius + 0.5) {
        q.removed = true
      }
    }
  }

  const pockets = generatePockets(rng)

  return {
    seedLabel,
    layers: layerCount,
    pins,
    pockets,
    floorY: BOARD.bottom,
    pocketTopY,
    architecture: architectureLabel(rng, layerCount, pins.filter((p) => !p.removed).length),
    stats: emptyStats(),
  }
}

/** X positions for one layer, in world units, before jitter. */
function layerPositions(
  rng: Rng,
  pattern: LayerPattern,
  count: number,
  halfSpan: number,
  t: number,
): number[] {
  const out: number[] = []
  const span = halfSpan * 2

  switch (pattern) {
    case 'lattice': {
      const step = span / count
      for (let i = 0; i < count; i++) out.push(-halfSpan + step * (i + 0.5))
      break
    }
    case 'offset': {
      // Classic pachinko half-offset row; the single most playable pattern.
      const step = span / count
      const shift = (t * 10) % 2 < 1 ? 0 : step / 2
      for (let i = 0; i < count; i++) {
        const x = -halfSpan + step * (i + 0.5) + shift
        if (x <= halfSpan) out.push(x)
      }
      break
    }
    case 'funnel': {
      // Denser toward the centre: concentrates cascades into the pocket field.
      const n = Math.max(3, count)
      for (let i = 0; i < n; i++) {
        const u = (i / (n - 1)) * 2 - 1
        out.push(Math.sign(u) * Math.pow(Math.abs(u), 1.55) * halfSpan)
      }
      break
    }
    case 'arc': {
      // Pins along a shallow arc — deflects orbs outward toward the rails.
      const n = Math.max(4, count)
      const dir = rng.bool() ? 1 : -1
      for (let i = 0; i < n; i++) {
        const u = (i / (n - 1)) * 2 - 1
        out.push(u * halfSpan * (0.6 + 0.4 * Math.cos(u * dir)))
      }
      break
    }
    case 'cluster': {
      const clusters = rng.int(2, 3)
      const per = Math.max(2, Math.floor(count / clusters))
      for (let c = 0; c < clusters; c++) {
        const centre = rng.range(-halfSpan * 0.8, halfSpan * 0.8)
        for (let i = 0; i < per; i++) {
          out.push(clamp(centre + rng.gaussian(0, 1.0), -halfSpan, halfSpan))
        }
      }
      break
    }
    case 'sparse': {
      // Breathing room. Gives long uninterrupted falls that build speed.
      const n = Math.max(2, Math.floor(count * 0.45))
      const step = span / n
      for (let i = 0; i < n; i++) out.push(-halfSpan + step * (i + 0.5))
      break
    }
    case 'colonnade': {
      // Vertical pairs: creates narrow channels that reward precise aiming.
      const pairs = Math.max(2, Math.floor(count / 2))
      const step = span / pairs
      for (let i = 0; i < pairs; i++) {
        const base = -halfSpan + step * (i + 0.5)
        out.push(base - 0.34)
        out.push(base + 0.34)
      }
      break
    }
  }

  return out
}

/** Bottom pockets: a mix of drains, residual pockets, and benchmark spikes. */
function generatePockets(rng: Rng): PocketDef[] {
  const count = rng.int(BOARDGEN.pocketCountMin, BOARDGEN.pocketCountMax)
  const spikeCount = rng.int(BOARDGEN.spikePocketsMin, BOARDGEN.spikePocketsMax)

  const totalWidth = BOARD.width - BOARD.wallThickness * 2
  const slotWidth = totalWidth / count
  const left = -totalWidth / 2

  // Spikes go anywhere except the two centre slots — the centre is where an
  // untargeted orb naturally lands, so the jackpot must be earned by aiming.
  const centreSlots = count % 2 === 1
    ? [Math.floor(count / 2)]
    : [count / 2 - 1, count / 2]
  const spikeCandidates: number[] = []
  for (let i = 0; i < count; i++) if (!centreSlots.includes(i)) spikeCandidates.push(i)
  const spikeSlots = new Set(rng.sample(spikeCandidates, spikeCount))

  const pockets: PocketDef[] = []
  for (let i = 0; i < count; i++) {
    let kind: PocketKind
    if (spikeSlots.has(i)) kind = 'spike'
    else if (centreSlots.includes(i)) kind = 'drain'
    else kind = rng.bool(0.4) ? 'drain' : 'pocket'

    // Spikes are narrow (hard to hit); drains are full width.
    const widthScale = kind === 'spike' ? 0.5 : 1
    pockets.push({
      kind,
      x: left + slotWidth * (i + 0.5),
      halfWidth: (slotWidth / 2) * widthScale,
    })
  }
  return pockets
}

/**
 * The handcrafted safety board. Used only if ten procedural candidates in a row
 * fail validation — which should essentially never happen, but a game that
 * cannot load a stage is worse than a game with one repeated board.
 */
export function fallbackBoard(seedLabel: string): Board {
  const pocketTopY = BOARD.bottom + BOARDGEN.pocketWallHeight
  const pins: PinDef[] = []
  let id = 0
  const halfSpan = BOARD.width / 2 - BOARDGEN.edgeInset
  const rows = 13
  const top = BOARD.top - 1.6
  const bottom = pocketTopY + 0.9

  for (let r = 0; r < rows; r++) {
    const y = top - (r / (rows - 1)) * (top - bottom)
    const cols = r % 2 === 0 ? 9 : 8
    const step = (halfSpan * 2) / cols
    const shift = r % 2 === 0 ? 0 : step / 2
    for (let c = 0; c < cols; c++) {
      const x = -halfSpan + step * (c + 0.5) + shift
      if (Math.abs(x) > halfSpan) continue
      const critical = (r === 4 && c === 2) || (r === 7 && c === 5) || (r === 10 && c === 3)
      pins.push({
        id: id++,
        x,
        y,
        radius: critical ? PIN.criticalRadius : PIN.radius,
        critical,
        layer: r,
        removed: false,
      })
    }
  }

  const totalWidth = BOARD.width - BOARD.wallThickness * 2
  const slots = 6
  const slotWidth = totalWidth / slots
  const left = -totalWidth / 2
  const kinds: PocketKind[] = ['pocket', 'spike', 'drain', 'drain', 'spike', 'pocket']
  const pockets: PocketDef[] = kinds.map((kind, i) => ({
    kind,
    x: left + slotWidth * (i + 0.5),
    halfWidth: (slotWidth / 2) * (kind === 'spike' ? 0.5 : 1),
  }))

  return {
    seedLabel,
    layers: rows,
    pins,
    pockets,
    floorY: BOARD.bottom,
    pocketTopY,
    architecture: `reference checkpoint · ${rows} layers · ${pins.length} parameters`,
    stats: { ...emptyStats(), fallback: true, accepted: true },
  }
}

/** Per-stage board RNG stream. Stage N is the same board regardless of path. */
export function boardRngFor(seed: string, stage: number, attempt: number): Rng {
  return deriveRng(seed, 'board', stage, attempt)
}

// --- helpers ---------------------------------------------------------------

function fits(pins: readonly PinDef[], x: number, y: number): boolean {
  for (const p of pins) {
    const dx = p.x - x
    const dy = p.y - y
    if (dx * dx + dy * dy < PIN.minSpacing * PIN.minSpacing) return false
  }
  return true
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
