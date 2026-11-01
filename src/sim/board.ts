/**
 * board.ts — the inert description of one network.
 *
 * A Board is plain data: no physics handles, no meshes. The physics layer
 * consumes it to build colliders, the render layer to build geometry, and the
 * headless harnesses to simulate it with neither. Keeping it inert is what
 * lets a candidate board be probed and thrown away cheaply.
 *
 * v2 changes the lifetime of this object completely. A board used to be
 * generated per stage and discarded; now ONE board is generated at run start
 * and carries the player's whole run — every level and transform they buy
 * lands on these objects and stays there. It is the save file.
 */

export type PocketKind = 'spike' | 'drain' | 'pocket'

/** Transformations a weight can carry. Mechanics land in Pass 2. */
export type NodeTransform =
  | 'attention-head'
  | 'residual'
  | 'layer-norm'
  | 'gelu'
  | 'dropout'
  | 'embedding'
  | 'sparse-moe'
  | 'quantised'
  | 'checkpoint'

/** Transformations an output token bucket can carry. Mechanics land in Pass 2. */
export type BucketTransform =
  | 'logit-boost'
  | 'top-k'
  | 'beam-search'
  | 'eos'
  | 'cache-hit'
  | 'nucleus'
  | 'revenue-share'

export const NODE_TRANSFORM_LABEL: Record<NodeTransform, string> = {
  'attention-head': 'ATTN',
  residual: 'RES',
  'layer-norm': 'NORM',
  gelu: 'GELU',
  dropout: 'DROP',
  embedding: 'EMB',
  'sparse-moe': 'MoE',
  quantised: 'Q8',
  checkpoint: 'CKPT',
}

export const BUCKET_TRANSFORM_LABEL: Record<BucketTransform, string> = {
  'logit-boost': 'LOGIT',
  'top-k': 'TOP-K',
  'beam-search': 'BEAM',
  eos: 'EOS',
  'cache-hit': 'CACHE',
  nucleus: 'NUCL',
  'revenue-share': 'REV',
}

export interface NodeDef {
  readonly id: number
  x: number
  y: number
  radius: number
  /** Which layer of the network this sits in. 0 is the embedding layer. */
  readonly layer: number
  /** Index within its layer, left to right. */
  readonly col: number
  /** Score level. Value is `SCORE.basePinValue * level`. */
  level: number
  /** At most two, enforced by the shop. */
  transforms: NodeTransform[]
  /** Ids of nodes in the layer below that this one feeds. Downward only. */
  outputs: number[]
  /** Pruned or otherwise disabled. Inert and invisible. */
  removed: boolean
}

export interface PocketDef {
  readonly id: number
  readonly kind: PocketKind
  x: number
  halfWidth: number
  /** Multiplier is `1 + 0.25 * level`. */
  level: number
  transform: BucketTransform | null
}

/** A directed edge, resolved to node references for the render + sim layers. */
export interface EdgeDef {
  readonly from: number
  readonly to: number
}

export interface Board {
  readonly seedLabel: string
  readonly layers: number
  readonly nodes: NodeDef[]
  readonly edges: EdgeDef[]
  readonly pockets: PocketDef[]
  readonly floorY: number
  readonly pocketTopY: number
  readonly architecture: string
  stats: BoardStats
}

export interface BoardStats {
  attempts: number
  medianPins: number
  settleRate: number
  maxAlive: number
  accepted: boolean
  fallback: boolean
}

export function emptyStats(): BoardStats {
  return {
    attempts: 0,
    medianPins: 0,
    settleRate: 0,
    maxAlive: 0,
    accepted: false,
    fallback: false,
  }
}

export function activeNodes(board: Board): NodeDef[] {
  return board.nodes.filter((n) => !n.removed)
}

export function countActive(board: Board): number {
  let n = 0
  for (const node of board.nodes) if (!node.removed) n++
  return n
}

/** Node lookup by id. Boards are small, but this is called per edge per frame. */
export function nodeIndex(board: Board): Map<number, NodeDef> {
  const map = new Map<number, NodeDef>()
  for (const n of board.nodes) map.set(n.id, n)
  return map
}

export function hasTransform(node: NodeDef, t: NodeTransform): boolean {
  return node.transforms.includes(t)
}

/**
 * v1's "critical pin" is v2's attention-head transform. Same mechanical role
 * (higher value, advances the tier, triggers splits and detonations), but it
 * is now something a node can be GIVEN rather than something it is born as —
 * which is what lets the shop sell it.
 */
export function isAttentionHead(node: NodeDef): boolean {
  return node.transforms.includes('attention-head')
}
