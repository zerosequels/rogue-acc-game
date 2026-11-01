# rogue/acc v2 — delivery tracker

Spec: https://claude.ai/code/artifact/a8fdadd4-a8b1-495f-b47b-a4338eac8687

This file is the contract. Each pass leaves the game playable. Check items off as
they land; do not start a pass before the previous one builds, typechecks, and
passes `npm run smoke`.

---

## Decisions (closed — do not relitigate)

| # | Decision | Answer |
|---|---|---|
| 1 | Does v1 survive? | **No.** Replace outright on `main`. History is the archive. |
| 2 | Boss modifiers on Frontier Claim? | **Yes.** In scope, Pass 3. |
| 3 | Sell upgrades back? | **No.** There is no joker system to sell. |
| 4 | Does IPO end the run? | **Yes.** IPO is the win: you cash out and the bubble pops *after* you are rich. Failing a benchmark pops it while you are still holding. |

Locked from the design interview:

- Art: neon wireframe geometry + monospace glyph annotation
- Board: one per run, persistent, ~70 nodes across 9 layers
- Edges: functional, downward-only, multi-hop, decaying
- Deck: you build it, draw order is random, per-card levels and transforms
- Activations and deck are separate resources
- Money: clear reward + overshoot + interest. $1 = $1B
- Structure: 8 funding rounds x 3 benchmarks, shop after each
- Targeting precision is a shop pricing axis (blind / banded / precise)
- Card *removal* is always precise — random deletion is pure frustration
- Temperature: cut

---

## Pass 1 — Board & art

Goal: the current game, on the new board, in the new look. No new maths, so the
art direction can be judged on its own.

- [x] Board model carries nodes (level, transforms, layer), edges, buckets (level, transform)
- [x] Fixed 9-layer lattice generator; seed varies starting state, not geometry
- [x] Edge topology: 2-3 downward links per node, no sideways, no upward
- [x] Board generated once at run start and persists across every benchmark
- [x] Validator runs once per run (can afford to be stricter)
- [x] Render: hollow rings, not filled circles
- [x] Render: edges as hairlines, one draw call (LineSegments, per-vertex colour)
- [x] Render: buckets as open wireframe boxes
- [x] Render: monospace glyph layer for levels and transform names
- [x] Background: sparse hairline grid replaces the circuit shader
- [x] Existing scoring still works end to end
- [x] `npm run smoke` green, screenshot reviewed

**Pass 1 notes**

- `critical` is gone from the model. v1's critical pin is v2's `attention-head`
  transform — same mechanical role, but now something a node can be *given*,
  which is what lets the shop sell it in Pass 3.
- Attention heads are placed **unconditionally** (`startingAttentionHeads: 3`),
  not rolled from the starter-transform pool. Rolling them allowed a board with
  zero heads, which silently removes the tier bonus, the split trigger and the
  detonation trigger from an entire run.
- Glyph labels are one `CanvasTexture` over the whole board, redrawn only on
  `markLabelsDirty()`. The lattice is fixed and labels only change on purchase,
  so 70 labels cost one quad and nothing per frame.
- Bloom had to come down hard (0.75 → 0.42, threshold 0.16 → 0.33). It was
  tuned for filled discs and was filling the rings back in, undoing the
  wireframe read.
- `BoardView.flashEdge(i)` exists and is wired but unused until Pass 2.

## Pass 2 — Signal & levels

Goal: the new scoring core, tuned. Upgrades applied by debug command, not bought.

- [x] Downward signal propagation with per-hop decay and a cutoff floor
- [x] A node scores once per pass whether struck or signalled
- [x] Node levels (`10 x level`) and the 9 node transforms
- [x] Bucket levels (`1 + 0.25 x level`) and the 7 bucket transforms
- [x] Harness extended to measure propagation yield per node (`npm run propagation`)
- [x] Propagation retention tuned in the harness before it is tuned by feel
- [x] Debug commands to grant levels/transforms for testing

**Pass 2 notes**

- Retention stayed at the spec's proposed **0.45**, but it was *measured*, not
  assumed. The sweep showed node counts STEP rather than slide, because
  retention really selects the hop count via the floor: 0.30-0.40 all give 2
  hops, 0.45-0.50 give 3, 0.55-0.60 give 4. 0.45 lands on the predicted three
  hops and lights 27 of 68 nodes.
- Signal contributes roughly two thirds of pass score, so propagation really is
  the scoring core rather than a garnish.
- Contacts DROP as retention rises (10.0 -> 4.8). Correct: a node already lit
  by signal is already scored, so the ball's later contacts on it do nothing.
- `SIGNAL.maxHops` is a backstop, not the mechanism. The floor does the real
  bounding; maxHops only catches a tuning slip.
- **GELU and Residual are multiplicative on propagation** (doubling outgoing
  strength / making a hop lossless). With both scattered plus L4 nodes, a
  debug run scored 119,773 against a 3,300 target. They will need careful
  pricing in the Pass 3 shop.
- `STAGES.baseTarget` is provisional at 4,400. Pass 3 deletes this curve.
- `tools/shot.mjs` added: boots, grants transforms, fires one pass and
  screenshots mid-propagation. The smoke test drives a whole run and is far
  too slow for visual iteration.

**Pass 2 correction — signal is a bonus, not a consumption**

Signal originally marked nodes as struck, exactly like a ball contact. That was
wrong, and the measurement showed why: contacts per pass fell from 10.0 to 4.3
as retention rose, because the ball was being starved by its own network — the
first contact ate most of the board and every later contact found it spent.

Signal now:

- does **not** consume the node (it can still be hit by the ball afterwards,
  and lit again by a later contact's wave),
- does **not** advance the multiplier tier — the ladder stays a measure of how
  well you AIMED, while signal measures how well your network is WIRED,
- pulses rather than dims in the render layer, because a dimmed node reads as
  "already used" and would tell the player the opposite of the rule.

Contacts are now a flat 10.1 at every retention. Signal activations run to ~66
per pass at 0.45 (every contact fires a wave), scaled by `SIGNAL.bonusShare`
to keep a bonus a bonus. Pace landed at 8.9 passes to clear against a target
of 8. Termination never depended on the consumption rule: `propagate` carries
its own per-wave visited set and the edge graph is a DAG by construction.

## Pass 3 — Deck, shop, money

Goal: the complete v2 loop.

- [ ] **Remove temperature** — the deck replaces the per-launch choice
- [ ] Per-card deck: types, levels, transforms, random draw queue
- [ ] The 6 card transforms
- [ ] Shop with three precision tiers and reroll
- [ ] Money: clear reward, overshoot, interest, unspent activations
- [ ] 8 funding rounds x 3 benchmarks
- [ ] Boss modifiers on Frontier Claim benchmarks
- [ ] IPO win screen (cash out, bubble pops behind you)
- [ ] Failure screen (bubble pops while you are still holding)
- [ ] Full-run harness retuned against the new curve

---

## Standing rules

- `src/config/balance.ts` stays the only file with gameplay constants.
- `src/sim/**` imports nothing from Three.js or the DOM. This is what makes the
  headless harnesses possible, and it is how the `-28%` Explosive Weights trap
  was found. Do not break it.
- Anything that changes scoring gets measured in `npm run upgrades` or
  `npm run sim` before it is tuned by feel.
- `Math.random()` stays banned in gameplay code.
