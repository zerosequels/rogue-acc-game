/**
 * propagation.ts — the forward pass.
 *
 * A struck node fires its downward edges. Nodes in the layer below score
 * without the ball touching them, and fire their own edges in turn. Signal
 * weakens each hop and stops at a floor.
 *
 * Three properties make this safe to run inside a physics step:
 *
 *   DOWNWARD ONLY   Edges are generated layer N -> layer N+1 and never
 *                   otherwise, so the graph is a DAG by construction. There
 *                   is no cycle to guard against.
 *   SCORE ONCE      A node already scored this pass is not re-entered, so the
 *                   wavefront can never revisit and the work is bounded by
 *                   the node count regardless of how the edges are wired.
 *   BOUNDED DEPTH   Signal dies at SIGNAL.floor, and SIGNAL.maxHops caps it
 *                   independently as a backstop against a tuning mistake.
 *
 * Breadth-first rather than depth-first, deliberately: it visits nodes in hop
 * order, so the render layer can stagger the animation by hop and the player
 * sees a wave travelling down the network rather than a single frame where
 * everything lights at once.
 */

import { SIGNAL } from '../config/balance'
import { type Board, type NodeDef } from './board'
import { scoreSignal, type Pass, type ScoreEvent, type ScoringContext } from './scoring'

/** Edge lookup built once per board, so propagation never scans the list. */
export interface SignalGraph {
  /** node id -> ids of nodes it feeds. */
  readonly outputs: Map<number, number[]>
  /** node id -> the node. */
  readonly nodes: Map<number, NodeDef>
  /** "from:to" -> index into `board.edges`, for flashing the right line. */
  readonly edgeIndex: Map<string, number>
}

export function buildSignalGraph(board: Board): SignalGraph {
  const outputs = new Map<number, number[]>()
  const nodes = new Map<number, NodeDef>()
  const edgeIndex = new Map<string, number>()

  for (const n of board.nodes) {
    nodes.set(n.id, n)
    outputs.set(n.id, n.outputs)
  }
  for (let i = 0; i < board.edges.length; i++) {
    const e = board.edges[i]!
    edgeIndex.set(`${e.from}:${e.to}`, i)
  }
  return { outputs, nodes, edgeIndex }
}

export interface SignalResult {
  /** Score events in hop order, for staggered presentation. */
  events: ScoreEvent[]
  /** Indices into `board.edges` that carried signal, in hop order. */
  litEdges: { index: number; hop: number }[]
  /** Nodes reached. Useful for the harness; the game reads `events`. */
  reached: number
}

interface Frontier {
  id: number
  power: number
  hop: number
}

/**
 * Fire the network from `origin`. The origin itself must already have been
 * scored by the caller (it was a ball contact); this scores what follows.
 */
export function propagate(
  graph: SignalGraph,
  pass: Pass,
  origin: NodeDef,
  ctx: ScoringContext,
  out: SignalResult,
): SignalResult {
  out.events.length = 0
  out.litEdges.length = 0
  out.reached = 0

  let frontier: Frontier[] = [{ id: origin.id, power: 1, hop: 0 }]
  const seenThisWave = new Set<number>([origin.id])

  while (frontier.length > 0) {
    const next: Frontier[] = []

    for (const f of frontier) {
      if (f.hop >= SIGNAL.maxHops) continue

      const node = graph.nodes.get(f.id)
      if (!node || node.removed) continue

      // Residual nodes pass signal through without the usual hop loss; GELU
      // amplifies what leaves them. Both are properties of the SENDING node.
      const lossless = node.transforms.includes('residual')
      const gelu = node.transforms.includes('gelu') ? SIGNAL.geluBoost : 1
      const outgoing = f.power * (lossless ? 1 : SIGNAL.retention) * gelu

      if (outgoing < SIGNAL.floor) continue

      // An attention head fans out across every edge it has; an ordinary node
      // drives only its first two. This is what makes heads worth targeting.
      const all = graph.outputs.get(f.id) ?? []
      const targets =
        SIGNAL.headFiresAllEdges && node.transforms.includes('attention-head')
          ? all
          : all.slice(0, 2)

      for (const toId of targets) {
        if (seenThisWave.has(toId)) continue
        const target = graph.nodes.get(toId)
        if (!target || target.removed) continue

        const ei = graph.edgeIndex.get(`${f.id}:${toId}`)
        if (ei !== undefined) out.litEdges.push({ index: ei, hop: f.hop })

        // `seenThisWave` is the ONLY thing bounding this traversal, and it is
        // per-wave rather than per-pass. Signal no longer consumes nodes, so
        // a node already lit by an earlier contact's wave is lit again by
        // this one — that is the bonus working as intended. The wave still
        // cannot revisit within itself, and the graph is a DAG, so it
        // terminates regardless.
        seenThisWave.add(toId)
        const ev = scoreSignal(pass, target, outgoing, f.hop + 1, ctx)

        // Keep walking even when the node paid nothing (Dropout refused, or
        // MoE is still asleep) — the signal passes THROUGH it either way.
        next.push({ id: toId, power: outgoing, hop: f.hop + 1 })
        if (!ev) continue
        out.events.push(ev)
        out.reached++
      }
    }

    frontier = next
  }

  return out
}

export function makeSignalResult(): SignalResult {
  return { events: [], litEdges: [], reached: 0 }
}
