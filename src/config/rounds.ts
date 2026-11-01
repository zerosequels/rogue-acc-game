/**
 * rounds.ts — funding rounds, their benchmarks, and the bosses.
 *
 * Eight funding rounds, three benchmarks each, a shop after every one:
 * twenty-four benchmarks and twenty-four shop visits per run.
 *
 * Targets grow by a single factor per benchmark and that figure is THE
 * invariant the economy hangs off. With 23 shop visits before IPO, average
 * player power must grow by roughly the same factor per visit, which is what
 * every shop price is sized against.
 *
 * IPO is the win: you cash out and the bubble pops after you are rich.
 * Failing a benchmark pops it while you are still holding.
 */

export type BenchmarkKind = 'internal' | 'public' | 'frontier'

export interface BenchmarkDef {
  readonly round: number
  readonly index: number
  readonly kind: BenchmarkKind
  readonly roundName: string
  readonly name: string
  readonly target: number
  readonly payout: number
  readonly boss: BossId | null
}

export const ROUND_NAMES = [
  'Pre-Seed', 'Seed', 'Series A', 'Series B',
  'Series C', 'Series D', 'Series E', 'IPO',
] as const

export const BENCHMARK_NAMES: Record<BenchmarkKind, string> = {
  internal: 'Internal Eval',
  public: 'Public Benchmark',
  frontier: 'Frontier Claim',
}

export const ROUNDS = {
  count: 8,
  perRound: 3,
  /** Stage-1 target. Calibrated from `npm run propagation`. */
  baseTarget: 900,
  /** Per-benchmark growth. See the invariant note above. */
  growth: 1.285,
  /** Payout by benchmark kind, plus one per funding round reached. */
  payout: { internal: 5, public: 7, frontier: 10 } as Record<BenchmarkKind, number>,
  payoutPerRound: 1.0,
} as const

const KINDS: BenchmarkKind[] = ['internal', 'public', 'frontier']

/** Flat index 0..23 for a benchmark. */
export function benchmarkIndex(round: number, within: number): number {
  return (round - 1) * ROUNDS.perRound + within
}

export function totalBenchmarks(): number {
  return ROUNDS.count * ROUNDS.perRound
}

export function benchmarkAt(flatIndex: number): BenchmarkDef {
  const clamped = Math.max(0, Math.min(totalBenchmarks() - 1, flatIndex))
  const round = Math.floor(clamped / ROUNDS.perRound) + 1
  const within = clamped % ROUNDS.perRound
  const kind = KINDS[within]!

  const raw = ROUNDS.baseTarget * Math.pow(ROUNDS.growth, clamped)
  const target = roundNicely(raw)
  const payout = Math.round(ROUNDS.payout[kind] + (round - 1) * ROUNDS.payoutPerRound)

  return {
    round,
    index: within,
    kind,
    roundName: ROUND_NAMES[round - 1] ?? `Round ${round}`,
    name: BENCHMARK_NAMES[kind],
    target,
    payout,
    // Bosses sit on Frontier Claims only. The first one is left clean so the
    // player meets the mechanic after they understand the base game.
    boss: kind === 'frontier' && round > 1 ? bossForRound(round) : null,
  }
}

/** Readable figures: no 1,959.9999 in the HUD. */
function roundNicely(n: number): number {
  if (n < 1000) return Math.round(n / 10) * 10
  if (n < 10000) return Math.round(n / 50) * 50
  if (n < 100000) return Math.round(n / 500) * 500
  if (n < 1000000) return Math.round(n / 5000) * 5000
  return Math.round(n / 50000) * 50000
}

// ---------------------------------------------------------------------------
// Bosses — Frontier Claim modifiers
//
// Balatro's difficulty lives in its boss blinds, and the equivalent here is a
// constraint that invalidates one habit for a single benchmark. Each is a
// plausible failure of a real training run, which does the flavour for free.
// ---------------------------------------------------------------------------

export type BossId =
  | 'compute-shortage'
  | 'distribution-shift'
  | 'red-team'
  | 'context-collapse'
  | 'data-contamination'
  | 'alignment-tax'
  | 'capability-overhang'

export interface BossDef {
  readonly id: BossId
  readonly name: string
  readonly description: string
  /** Activations are multiplied by this for the benchmark. */
  readonly activationMult: number
  /** Layers from the bottom rendered inert. */
  readonly deadLayers: number
  /** Signal retention multiplier. */
  readonly signalMult: number
  /** Multiplies the benchmark target. */
  readonly targetMult: number
  /** Buckets other than drains pay nothing. */
  readonly noBuckets: boolean
  /** Poisoned cards fail twice as often. */
  readonly doublePoison: boolean
}

function boss(
  id: BossId,
  name: string,
  description: string,
  over: Partial<Omit<BossDef, 'id' | 'name' | 'description'>>,
): BossDef {
  return {
    id, name, description,
    activationMult: 1,
    deadLayers: 0,
    signalMult: 1,
    targetMult: 1,
    noBuckets: false,
    doublePoison: false,
    ...over,
  }
}

export const BOSSES: Record<BossId, BossDef> = {
  'compute-shortage': boss(
    'compute-shortage', 'Compute Shortage',
    'The cluster is oversubscribed. You get 60% of your activations.',
    { activationMult: 0.6 },
  ),
  'distribution-shift': boss(
    'distribution-shift', 'Distribution Shift',
    'The bottom two layers are inert. Nothing scores down there.',
    { deadLayers: 2 },
  ),
  'red-team': boss(
    'red-team', 'Red Team',
    'Poisoned data fails twice as often, and the target is 15% higher.',
    { doublePoison: true, targetMult: 1.15 },
  ),
  'context-collapse': boss(
    'context-collapse', 'Context Collapse',
    'Signal decays twice as fast. Your wiring barely carries.',
    { signalMult: 0.5 },
  ),
  'data-contamination': boss(
    'data-contamination', 'Data Contamination',
    'Output tokens pay nothing. Score has to come from the network.',
    { noBuckets: true },
  ),
  'alignment-tax': boss(
    'alignment-tax', 'Alignment Tax',
    'The target is 40% higher. Safety work does not ship itself.',
    { targetMult: 1.4 },
  ),
  'capability-overhang': boss(
    'capability-overhang', 'Capability Overhang',
    'Three quarters of your activations, and the bottom layer is inert.',
    { activationMult: 0.75, deadLayers: 1 },
  ),
}

const BOSS_ORDER: BossId[] = [
  'compute-shortage',
  'distribution-shift',
  'context-collapse',
  'red-team',
  'data-contamination',
  'alignment-tax',
  'capability-overhang',
]

function bossForRound(round: number): BossId {
  return BOSS_ORDER[(round - 2) % BOSS_ORDER.length]!
}

export function bossFor(def: BenchmarkDef): BossDef | null {
  return def.boss ? BOSSES[def.boss] : null
}
