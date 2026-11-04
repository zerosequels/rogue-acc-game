/**
 * boardgen.ts — builds the one network a run is played on.
 *
 * v1 generated a new board every stage from seven layer patterns. v2 does the
 * opposite: the GEOMETRY IS FIXED and the seed varies what sits on it.
 *
 * That follows directly from two design decisions that interact. A standardised
 * layout means the lattice cannot wander, and a board that persists for a whole
 * run means the player must be able to learn it. Between them there is nothing
 * left for layout randomness to do — so the seed instead decides:
 *
 *   - edge topology (which nodes feed which, within the downward constraint)
 *   - which nodes start above level 1
 *   - which nodes start pre-transformed
 *   - the arrangement of output buckets along the floor
 *
 * Two runs are recognisably the same machine, wired differently. For a model
 * architecture that is exactly the right kind of variation.
 */

import { BOARD, BOARDGEN, PIN } from '../config/balance'
import { deriveRng, type Rng } from '../core/rng'
import { architectureLabel } from '../flavor/text'
import {
  emptyStats,
  type Board,
  type BucketTransform,
  type EdgeDef,
  type NodeDef,
  type NodeTransform,
  type PocketDef,
  type PocketKind,
} from './board'

/**
 * Mild transforms the seed may hand out at run start. Attention heads are
 * NOT in this list — they are placed unconditionally, because scoring depends
 * on them existing.
 */
const STARTER_NODE_TRANSFORMS: readonly NodeTransform[] = [
  'residual',
  'layer-norm',
  'gelu',
  'checkpoint',
]

const STARTER_BUCKET_TRANSFORMS: readonly BucketTransform[] = [
  'logit-boost',
  'cache-hit',
  'nucleus',
]

/**
 * Build the run's board. Deterministic in `rng`.
 *
 * `attempt` exists only so the validator can reject a wiring and ask for
 * another; the lattice itself never changes between attempts.
 */
export function generateBoard(rng: Rng, seedLabel: string): Board {
  const layers = BOARDGEN.layers
  const perLayer = BOARDGEN.nodesPerLayer

  const pocketTopY = BOARD.bottom + BOARDGEN.pocketWallHeight
  const fieldTop = BOARD.top - 1.5
  const fieldBottom = pocketTopY + 1.0
  const fieldHeight = fieldTop - fieldBottom

  const halfSpan = BOARD.width / 2 - BOARDGEN.edgeInset
  const colStep = (halfSpan * 2) / (perLayer - 1)

  // ---- the lattice: fixed, offset rows, no jitter ------------------------
  const nodes: NodeDef[] = []
  let id = 0
  for (let layer = 0; layer < layers; layer++) {
    const y = fieldTop - (layer / (layers - 1)) * fieldHeight
    // Odd rows shift half a cell. Classic pachinko offset, and it is what
    // makes the downward edges fan into a readable lattice rather than
    // stacking into vertical columns.
    const shift = layer % 2 === 1 ? colStep / 2 : 0
    const count = layer % 2 === 1 ? perLayer - 1 : perLayer

    for (let col = 0; col < count; col++) {
      nodes.push({
        id: id++,
        x: -halfSpan + colStep * col + shift,
        y,
        radius: PIN.radius,
        layer,
        col,
        level: 1,
        transforms: [],
        outputs: [],
        removed: false,
      })
    }
  }

  // ---- edges: downward only, 2-3 per node --------------------------------
  const byLayer: NodeDef[][] = Array.from({ length: layers }, () => [])
  for (const n of nodes) byLayer[n.layer]!.push(n)

  const edges: EdgeDef[] = []
  for (let layer = 0; layer < layers - 1; layer++) {
    const below = byLayer[layer + 1]!
    for (const node of byLayer[layer]!) {
      // Candidates are the nodes in the next layer nearest in x. Restricting
      // to neighbours is what keeps the diagram legible: long diagonal edges
      // across the board would turn 70 nodes into spaghetti.
      const ranked = below
        .map((b) => ({ b, d: Math.abs(b.x - node.x) }))
        .sort((p, q) => p.d - q.d)
        .filter((c) => c.d <= colStep * 1.35)

      const want = rng.bool(BOARDGEN.thirdEdgeChance) ? 3 : 2
      for (const c of ranked.slice(0, want)) {
        node.outputs.push(c.b.id)
        edges.push({ from: node.id, to: c.b.id })
      }
    }
  }

  // ---- seeded starting state ---------------------------------------------
  // A handful of nodes begin promoted or transformed, so two runs on the same
  // lattice open with different opportunities.
  const promotable = nodes.filter((n) => n.layer > 0)
  for (const n of rng.sample(promotable, BOARDGEN.startingPromotions)) {
    n.level = 2
  }

  // Pre-transformed nodes are biased away from the bottom layer, where a
  // transform has no downstream left to act on.
  const transformable = nodes.filter((n) => n.layer > 0 && n.layer < layers - 1)
  const chosen = rng.sample(transformable, BOARDGEN.startingAttentionHeads + BOARDGEN.startingTransforms)

  // Attention heads are GUARANTEED, not rolled. They carry the tier bonus,
  // the split trigger and the detonation trigger, so a board that happens to
  // roll none loses a whole dimension of scoring. v1 always had 3-5 of them;
  // drawing them from the same random pool as the mild transforms silently
  // allowed zero.
  chosen.slice(0, BOARDGEN.startingAttentionHeads).forEach((n) => {
    n.transforms.push('attention-head')
    n.radius = PIN.criticalRadius
  })
  chosen.slice(BOARDGEN.startingAttentionHeads).forEach((n) => {
    n.transforms.push(rng.pick(STARTER_NODE_TRANSFORMS))
  })

  const pockets = generatePockets(rng)

  return {
    seedLabel,
    layers,
    nodes,
    edges,
    pockets,
    floorY: BOARD.bottom,
    pocketTopY,
    architecture: architectureLabel(rng, layers, nodes.length),
    stats: emptyStats(),
  }
}

/** Output tokens along the floor. Count is fixed; kind and state are seeded. */
function generatePockets(rng: Rng): PocketDef[] {
  const count = BOARDGEN.pocketCount
  const totalWidth = BOARD.width - BOARD.wallThickness * 2
  const slotWidth = totalWidth / count
  const left = -totalWidth / 2

  // Spikes never sit in the centre: that is where an unaimed token lands, so
  // the jackpot must be earned by aiming rather than collected by default.
  const centreSlots =
    count % 2 === 1 ? [Math.floor(count / 2)] : [count / 2 - 1, count / 2]
  const candidates: number[] = []
  for (let i = 0; i < count; i++) if (!centreSlots.includes(i)) candidates.push(i)
  const spikeSlots = new Set(
    rng.sample(candidates, rng.int(BOARDGEN.spikePocketsMin, BOARDGEN.spikePocketsMax)),
  )

  const pockets: PocketDef[] = []
  for (let i = 0; i < count; i++) {
    let kind: PocketKind
    if (spikeSlots.has(i)) kind = 'spike'
    else if (centreSlots.includes(i)) kind = 'drain'
    else kind = rng.bool(0.4) ? 'drain' : 'pocket'

    // Pockets TILE the floor: uniform width, no gaps. Narrowing the spikes
    // left dead strips between pockets where a token resolved to nothing,
    // fell through, and got culled as stuck — a dropped shot with no
    // feedback and no score, which is the worst outcome a pachinko floor
    // can produce. Spikes stay hard by POSITION (never centre), not by
    // being small enough to fall past.
    pockets.push({
      id: i,
      kind,
      x: left + slotWidth * (i + 0.5),
      halfWidth: slotWidth / 2,
      level: 1,
      transform: null,
    })
  }

  // One bucket may begin transformed, never a drain.
  const eligible = pockets.filter((p) => p.kind !== 'drain')
  if (eligible.length > 0 && rng.bool(BOARDGEN.startingBucketTransformChance)) {
    rng.pick(eligible).transform = rng.pick(STARTER_BUCKET_TRANSFORMS)
  }

  return pockets
}

/** Run-level board stream. One board per run, so the stage index is gone. */
export function boardRngFor(seed: string, attempt: number): Rng {
  return deriveRng(seed, 'board', attempt)
}
