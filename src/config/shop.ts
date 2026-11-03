/**
 * shop.ts — what you can buy, and what precision costs.
 *
 * SIZING NOTE. Benchmark targets grow by a fixed factor and there are roughly
 * two purchases per benchmark, so each purchase has to move total power by
 * about 19%. On a 68-node board, "+1 level to one weight" moves it by about
 * 1.5% — the full-run sweep showed pace drifting from 3 passes to 11 and runs
 * dying at Series A because of exactly this. Level purchases therefore hit
 * SEVERAL weights, and precision is what trades breadth for choice: a blind
 * upgrade sprays, a precise one lands exactly where you want but on fewer.
 *
 * The defining idea, and the one the player should feel immediately:
 * **targeting precision is a pricing axis.** The same effect costs more when
 * you get to say where it lands.
 *
 *   blind   x1.0   the machine chooses
 *   banded  x1.6   you choose upper / middle / lower third
 *   precise x2.5   you name the exact node
 *
 * That turns "where does this land" from a global rule into something you
 * spend money on, and it is what reconciles a Balatro-style shop (choosing
 * what to buy IS the game) with upgrades that land unpredictably.
 *
 * One exception, deliberately: **card removal is always precise.** Random
 * deletion is pure frustration, and thinning only reads as a decision when
 * you choose what leaves.
 */

import type { BucketTransform, NodeTransform } from '../sim/board'
import type { CardTransform, CardType } from '../sim/deck'

export type Precision = 'blind' | 'banded' | 'precise'

export const PRECISION_MULT: Record<Precision, number> = {
  blind: 1.0,
  banded: 1.6,
  precise: 2.5,
}

export const PRECISION_LABEL: Record<Precision, string> = {
  blind: 'random target',
  banded: 'choose a band',
  precise: 'choose the target',
}

/** Vertical third of the network a banded purchase may aim at. */
export type Band = 'upper' | 'middle' | 'lower'

export type ShopEffect =
  /** `count` is how MANY weights it hits — see the note below. */
  | { kind: 'node-level'; amount: number; count: number }
  | { kind: 'node-transform'; transform: NodeTransform; count: number }
  | { kind: 'bucket-level'; amount: number; count: number }
  | { kind: 'bucket-transform'; transform: BucketTransform }
  | { kind: 'card-level'; amount: number; count: number }
  | { kind: 'card-transform'; transform: CardTransform }
  | { kind: 'card-add'; cardType: CardType; count: number }
  | { kind: 'card-remove' }
  | { kind: 'activations'; amount: number }

export interface ShopItemDef {
  readonly id: string
  readonly name: string
  readonly flavor: string
  readonly effect: ShopEffect
  readonly precision: Precision
  /** Price before the precision multiplier. */
  readonly basePrice: number
  /** Relative chance of appearing in stock. */
  readonly weight: number
  /** Cap on how many times this may be bought in a run. 0 = unlimited. */
  readonly maxBuys: number
}

export function priceOf(item: ShopItemDef): number {
  return Math.max(1, Math.round(item.basePrice * PRECISION_MULT[item.precision]))
}

function item(
  id: string,
  name: string,
  flavor: string,
  effect: ShopEffect,
  precision: Precision,
  basePrice: number,
  weight = 10,
  maxBuys = 0,
): ShopItemDef {
  return { id, name, flavor, effect, precision, basePrice, weight, maxBuys }
}

export const SHOP_ITEMS: readonly ShopItemDef[] = [
  // ---- weights: levels, at all three precisions -------------------------
  item('grad-step', 'Gradient Step', 'a step down the loss surface. several weights feel it.',
    { kind: 'node-level', amount: 1, count: 10 }, 'blind', 2, 14),
  item('targeted-finetune', 'Targeted Finetune', 'you picked the layer. that is most of the battle.',
    { kind: 'node-level', amount: 1, count: 6 }, 'banded', 2, 11),
  item('manual-intervention', 'Manual Intervention', 'a researcher reached in and turned one dial all the way.',
    { kind: 'node-level', amount: 7, count: 1 }, 'precise', 2, 8),
  item('bulk-pretrain', 'Bulk Pretrain', 'everything goes up. nobody knows which part helped.',
    { kind: 'node-level', amount: 2, count: 16 }, 'blind', 6, 7),
  item('scaling-law', 'Scaling Law', 'the only reliable finding in the field.',
    { kind: 'node-level', amount: 1, count: 999 }, 'blind', 11, 5, 4),

  // ---- weights: transforms ----------------------------------------------
  item('attention-graft', 'Attention Graft', 'bolted on an extra head. it works, somehow.',
    { kind: 'node-transform', transform: 'attention-head', count: 3 }, 'blind', 5, 9),
  item('architecture-edit', 'Architecture Edit', 'you know exactly which weight you are editing. that is rare.',
    { kind: 'node-transform', transform: 'attention-head', count: 1 }, 'precise', 2, 6),
  item('residual-patch', 'Residual Patch', 'the signal stops forgetting on its way down.',
    { kind: 'node-transform', transform: 'residual', count: 3 }, 'banded', 2, 8),
  item('gelu-swap', 'GELU Swap', 'a better nonlinearity. the downstream notices.',
    { kind: 'node-transform', transform: 'gelu', count: 3 }, 'banded', 2, 7),
  item('layer-norm-insert', 'LayerNorm Insert', 'stabilise the layer and everything in it lifts.',
    { kind: 'node-transform', transform: 'layer-norm', count: 2 }, 'banded', 2, 8),
  item('dropout-layer', 'Dropout', 'sometimes it does not fire. when it does, it is worth it.',
    { kind: 'node-transform', transform: 'dropout', count: 4 }, 'blind', 2, 7),
  item('embedding-table', 'Embedding Table', 'the first thing the model sees is worth four of the rest.',
    { kind: 'node-transform', transform: 'embedding', count: 1 }, 'precise', 2, 5),
  item('moe-router', 'MoE Router', 'inert until the layer is busy, then enormous.',
    { kind: 'node-transform', transform: 'sparse-moe', count: 1 }, 'precise', 2, 5),
  item('checkpoint-save', 'Checkpoint', 'pays again next pass. the lab calls this efficiency.',
    { kind: 'node-transform', transform: 'checkpoint', count: 3 }, 'blind', 3, 6),
  item('quantise', 'Quantise', 'half the value, a fraction of the cost to improve.',
    { kind: 'node-transform', transform: 'quantised', count: 2 }, 'banded', 2, 4),

  // ---- output tokens ------------------------------------------------------
  item('wider-vocab', 'Wider Vocab', 'the output distribution has more room in it.',
    { kind: 'bucket-level', amount: 1, count: 3 }, 'blind', 2, 10),
  item('decode-tuning', 'Decode Tuning', 'you chose which token to sharpen.',
    { kind: 'bucket-level', amount: 3, count: 1 }, 'precise', 2, 7),
  item('logit-boost', 'Logit Boost', 'double this token and do not explain why.',
    { kind: 'bucket-transform', transform: 'logit-boost' }, 'precise', 2, 6),
  item('top-k-sampling', 'Top-K Sampling', 'pays enormously, but only after a long pass.',
    { kind: 'bucket-transform', transform: 'top-k' }, 'precise', 3, 5),
  item('beam-search', 'Beam Search', 'the token comes back for another go.',
    { kind: 'bucket-transform', transform: 'beam-search' }, 'precise', 3, 4),
  item('eos-token', 'EOS Token', 'ends the pass early and banks it at triple.',
    { kind: 'bucket-transform', transform: 'eos' }, 'precise', 3, 4),
  item('kv-cache', 'KV Cache', 'pays out again next pass, wherever you land.',
    { kind: 'bucket-transform', transform: 'cache-hit' }, 'blind', 3, 5),
  item('nucleus-sampling', 'Nucleus Sampling', 'between a fifth and quadruple. good luck.',
    { kind: 'bucket-transform', transform: 'nucleus' }, 'blind', 2, 5),
  item('revenue-share', 'Revenue Share', 'this token pays in dollars as well as score.',
    { kind: 'bucket-transform', transform: 'revenue-share' }, 'precise', 3, 5),

  // ---- the deck -----------------------------------------------------------
  item('scrape-crawl', 'Scrape: Common Crawl', 'more of the same. a great deal more.',
    { kind: 'card-add', cardType: 'common-crawl', count: 2 }, 'blind', 2, 9),
  item('scrape-arxiv', 'Scrape: arXiv', 'dense, heavy, and it punches through layers.',
    { kind: 'card-add', cardType: 'arxiv', count: 2 }, 'blind', 3, 8),
  item('generate-synthetic', 'Generate: Synthetic', 'the model writes its own training data. nothing bad has ever come of this.',
    { kind: 'card-add', cardType: 'synthetic', count: 2 }, 'blind', 3, 7),
  item('collect-rlhf', 'Collect: RLHF', 'expensive per token, light on the board.',
    { kind: 'card-add', cardType: 'rlhf', count: 2 }, 'blind', 3, 7),
  // Removal is ALWAYS precise. See the note at the top of this file.
  item('data-cleaning', 'Data Cleaning', 'delete the worst thing in your corpus.',
    { kind: 'card-remove' }, 'precise', 1, 10),
  item('curriculum', 'Curriculum Learning', 'one card gets properly trained on.',
    { kind: 'card-level', amount: 3, count: 1 }, 'precise', 2, 9),
  item('epoch', 'Another Epoch', 'run the whole corpus through again.',
    { kind: 'card-level', amount: 1, count: 6 }, 'blind', 3, 8),
  item('dedup-pass', 'Dedup Pass', 'the signal from this data reaches one layer further.',
    { kind: 'card-transform', transform: 'deduplicated' }, 'precise', 2, 6),
  item('tokeniser-fix', 'Tokeniser Fix', 'splits in two on first contact.',
    { kind: 'card-transform', transform: 'tokenised' }, 'precise', 3, 5),
  item('curate', 'Human Curation', 'expensive, slow, and it removes the floor.',
    { kind: 'card-transform', transform: 'curated' }, 'precise', 2, 5),
  item('web-scale', 'Web-Scale Filtering', 'every contact counts double toward the tier.',
    { kind: 'card-transform', transform: 'web-scale' }, 'precise', 3, 5),
  item('poison', 'Unverified Source', 'triple value. one in five passes is a total loss.',
    { kind: 'card-transform', transform: 'poisoned' }, 'blind', 2, 5),
  item('distil', 'Distillation', 'half value, but it comes straight back round.',
    { kind: 'card-transform', transform: 'distilled' }, 'precise', 2, 5),

  // ---- the budget ---------------------------------------------------------
  item('more-compute', 'Compute Allocation', 'one more forward pass, every benchmark, for ever.',
    { kind: 'activations', amount: 1 }, 'blind', 4, 10),
  item('datacenter', 'New Datacenter', 'three more. the energy grid will cope.',
    { kind: 'activations', amount: 3 }, 'blind', 10, 4, 3),
]

export const SHOP = {
  /** Items offered per visit. */
  stock: 4,
  /**
   * Node count the `count` fields below were tuned against.
   *
   * Every node-targeting count is scaled by `board.nodes.length / this` at
   * purchase time. Absolute counts have now broken TWICE when the lattice
   * changed size — once at 68 nodes, where "+1 level to one weight" was 1.5%
   * of the board against a required ~19% per purchase, and again when the
   * board went dense and the same counts silently fell to a third of their
   * intended reach. Scaling them removes the whole class of failure.
   */
  referenceNodes: 68,
  /** First reroll price, rising by `rerollStep` each time within a visit. */
  rerollBase: 1,
  rerollStep: 1,
} as const
