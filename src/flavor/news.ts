/**
 * news.ts — the feed.
 *
 * A benchmarking game set inside an AI bubble should have the bubble talking
 * back. Headlines stream while a round is live: they are pure flavour, but
 * they make the chamber feel like it sits inside an industry rather than in
 * a vacuum, and they give the player's eye somewhere to rest between shots.
 *
 * Tone: the lab's internal feed. Half trade press, half things that should
 * not be public. Never punching at a real company or person.
 */

import type { Rng } from '../core/rng'

export type NewsTone = 'market' | 'lab' | 'rival' | 'warning' | 'absurd'

export interface Headline {
  readonly tone: NewsTone
  readonly source: string
  readonly text: string
}

const HEADLINES: readonly Headline[] = [
  { tone: 'market', source: 'WIRE', text: 'Compute futures up 14% on no disclosed news.' },
  { tone: 'market', source: 'WIRE', text: 'Analyst downgrades entire sector, then apologises, then upgrades it.' },
  { tone: 'market', source: 'WIRE', text: 'Someone has securitised a training run. It is rated AAA.' },
  { tone: 'market', source: 'WIRE', text: 'Datacentre announced in a jurisdiction with no grid connection.' },
  { tone: 'market', source: 'WIRE', text: 'Valuation now exceeds the GDP of the country hosting the cluster.' },
  { tone: 'market', source: 'WIRE', text: 'A term sheet arrives before the pitch deck does.' },

  { tone: 'lab', source: 'INTERNAL', text: 'Checkpoint 4,112 is better than 4,113. Nobody knows why. Shipping 4,112.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Someone renamed the eval suite. The numbers went up.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Loss curve is flat. Morale is also flat. Correlation unclear.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Reminder: the staging cluster is not for personal projects.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Layer 40 has started answering questions it was not asked.' },
  { tone: 'lab', source: 'INTERNAL', text: 'The sampler temperature was never turned back down. It is fine.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Weekly reminder to stop naming checkpoints after pets.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Overnight run finished early. Nobody is admitting they killed it.' },

  { tone: 'rival', source: 'COMPETITOR', text: 'Rival lab claims the benchmark. Methodology section is one sentence.' },
  { tone: 'rival', source: 'COMPETITOR', text: 'Competitor announces a model that will exist next quarter.' },
  { tone: 'rival', source: 'COMPETITOR', text: 'A startup has reimplemented your architecture, worse, for more money.' },
  { tone: 'rival', source: 'COMPETITOR', text: 'Someone published your ablation study before you did.' },
  { tone: 'rival', source: 'COMPETITOR', text: 'Three labs announce the same result within forty minutes.' },

  { tone: 'warning', source: 'RISK', text: 'Eval contamination suspected. Investigation scheduled for after launch.' },
  { tone: 'warning', source: 'RISK', text: 'Gradient norm spiked. It has been described as "characterful".' },
  { tone: 'warning', source: 'RISK', text: 'The model passed the safety eval by asking what the safety eval was.' },
  { tone: 'warning', source: 'RISK', text: 'Capability overhang detected. Memo filed. Memo not read.' },
  { tone: 'warning', source: 'RISK', text: 'Red team reports success. Red team is not available for comment.' },

  { tone: 'absurd', source: 'FEED', text: 'A chatbot has been elected to a parish council.' },
  { tone: 'absurd', source: 'FEED', text: 'Scaling law discovered, named, and disproven in the same week.' },
  { tone: 'absurd', source: 'FEED', text: 'Conference accepts a paper that is entirely a plot of its own loss.' },
  { tone: 'absurd', source: 'FEED', text: 'The word "just" is doing an enormous amount of work in this roadmap.' },
  { tone: 'absurd', source: 'FEED', text: 'Somebody asked what happens if it keeps working. Meeting ended.' },
]

/** Headlines keyed to how the benchmark is going, so the feed reacts. */
const PRESSURE_HIGH: readonly Headline[] = [
  { tone: 'warning', source: 'RISK', text: 'Activations running low. Finance has noticed.' },
  { tone: 'market', source: 'WIRE', text: 'Market opens flat, watching one benchmark.' },
  { tone: 'warning', source: 'RISK', text: 'If this one misses, the bubble gets a name.' },
]

const PRESSURE_WIN: readonly Headline[] = [
  { tone: 'market', source: 'WIRE', text: 'Early numbers leak. Compute futures jump.' },
  { tone: 'lab', source: 'INTERNAL', text: 'Someone has already screenshotted the score.' },
  { tone: 'rival', source: 'COMPETITOR', text: 'A rival quietly delays their announcement.' },
]

/**
 * Pick the next headline. Weighted by state so the feed tracks the round:
 * tense when activations are short, triumphant when the target is in reach.
 */
export function nextHeadline(
  rng: Rng,
  opts: { activations: number; allowance: number; progress: number },
): Headline {
  const short = opts.activations / Math.max(1, opts.allowance) < 0.35
  const close = opts.progress > 0.8
  if (close && rng.bool(0.45)) return rng.pick(PRESSURE_WIN)
  if (short && rng.bool(0.45)) return rng.pick(PRESSURE_HIGH)
  return rng.pick(HEADLINES)
}
