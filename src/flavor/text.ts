/**
 * text.ts — all player-facing flavour copy.
 *
 * Kept out of the systems code so the voice can be rewritten without touching
 * a single mechanic. Every selection is seeded, so a given run always tells the
 * same story.
 */

import type { Rng } from '../core/rng'

/** Stage benchmark names, in escalating order of grandiosity. */
export const BENCHMARK_NAMES: readonly string[] = [
  'Reasoning',
  'Agentic Tool Use',
  'Long Context Recall',
  'Code Synthesis',
  'Multi-Hop Retrieval',
  'Instruction Following',
  'Adversarial Robustness',
  'Frontier Capability',
]

export function benchmarkName(stage: number): string {
  return BENCHMARK_NAMES[(stage - 1) % BENCHMARK_NAMES.length]!
}

/** Short subtitle under the stage heading — the model configuration. */
const ARCHITECTURE_PREFIX = [
  'dense', 'sparse', 'mixture-of-experts', 'recurrent-residual',
  'hyper-wide', 'deep-narrow', 'distilled', 'overparameterised',
]
const ARCHITECTURE_SUFFIX = [
  'checkpoint', 'init', 'fork', 'snapshot', 'variant', 'ablation', 'rewrite',
]

export function architectureLabel(rng: Rng, layers: number, pins: number): string {
  const prefix = rng.pick(ARCHITECTURE_PREFIX)
  const suffix = rng.pick(ARCHITECTURE_SUFFIX)
  return `${prefix} ${suffix} · ${layers} layers · ${pins} parameters`
}

/** Shown on the interstitial after clearing a stage. */
const CLEAR_LINES: readonly string[] = [
  'Benchmark exceeded. The model is better than it was an hour ago, and nobody can say exactly why.',
  'Eval passed. Someone screenshots the number. It is already out of date.',
  'Capability jump confirmed. Three competitors quietly delay their launch.',
  'The loss curve bends. The bubble holds. Compute is requisitioned.',
  'Scores filed upstream. The next target was raised before you finished reading this.',
  'Signal strong through all layers. Temperature trending up. Nobody is adjusting it down.',
  'Checkpoint saved. The previous checkpoint has been quietly deleted.',
  'Stakeholders are thrilled. They have not read the eval methodology.',
  'Residual stream is singing. Gradients clean. Ship it before anyone audits it.',
  'Target cleared. A new scaling law is drafted to retroactively explain it.',
]

const CLOSE_CALL_LINES: readonly string[] = [
  'Barely. The eval passed on a rounding convention nobody will revisit.',
  'Cleared by a hair. The report will not mention the margin.',
  'Target met on the final forward pass. The graph looks confident. It is not.',
  'Scraped through. The activations are nearly gone and the bubble noticed.',
]

const DOMINANT_LINES: readonly string[] = [
  'Target obliterated. The benchmark is now considered saturated and will be retired.',
  'The number is so far past target that two researchers assume a bug. It is not a bug.',
  'Capability overhang detected. Nobody writes it down.',
  'The eval harness reports a score it was not designed to represent. Accelerate.',
]

export function clearLine(rng: Rng, score: number, target: number): string {
  const ratio = score / target
  if (ratio >= 2.0) return rng.pick(DOMINANT_LINES)
  if (ratio <= 1.12) return rng.pick(CLOSE_CALL_LINES)
  return rng.pick(CLEAR_LINES)
}

/** Shown on run failure. */
const FAIL_LINES: readonly string[] = [
  'Activations exhausted. Gradients vanish through every layer. The signal dies mid-sentence.',
  'Context exhausted. The model forgets what it was optimising for, then forgets it forgot.',
  'Dead neurons all the way down. The forward pass returns nothing anyone can use.',
  'Signal collapse. The bubble does not burst so much as exhale.',
  'No activations remain. The run is archived under a name nobody will search for.',
]

export function failLine(rng: Rng): string {
  return rng.pick(FAIL_LINES)
}

/** Shown on completing all stages. */
export const VICTORY_LINE =
  'Every benchmark exceeded. The model is unrecognisable from its initialisation, ' +
  'the temperature never came back down, and the bubble is — technically, for now — stable. ' +
  'Something in layer 40 has started answering questions it was not asked.'

/** Pre-stage one-liners, keyed loosely to how the run is going. */
const PRESSURE_LOW: readonly string[] = [
  'Compute is cheap this quarter. Push the configuration.',
  'The lab is calm. The sampler is not.',
  'Fresh initialisation. No bad habits yet.',
]
const PRESSURE_MID: readonly string[] = [
  'Targets are climbing faster than the architecture is improving.',
  'The next benchmark was written by someone who expected you to fail it.',
  'Temperature is up across the cluster. Nobody filed a ticket.',
]
const PRESSURE_HIGH: readonly string[] = [
  'Activations are thin. Every forward pass is now a budget decision.',
  'The bubble is listening. Do not miss.',
  'Low on activations, high on temperature. Historically this goes one of two ways.',
]

export function pressureLine(rng: Rng, activations: number, maxPool: number): string {
  const frac = activations / Math.max(1, maxPool)
  if (frac < 0.3) return rng.pick(PRESSURE_HIGH)
  if (frac < 0.65) return rng.pick(PRESSURE_MID)
  return rng.pick(PRESSURE_LOW)
}

/** Pocket labels on the board floor. */
export const POCKET_LABELS = {
  spike: 'BENCHMARK SPIKE',
  drain: 'DEAD NEURON',
  pocket: 'RESIDUAL',
} as const
