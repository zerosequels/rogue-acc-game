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

- [ ] Board model carries nodes (level, transforms, layer), edges, buckets (level, transform)
- [ ] Fixed 9-layer lattice generator; seed varies starting state, not geometry
- [ ] Edge topology: 2-3 downward links per node, no sideways, no upward
- [ ] Board generated once at run start and persists across every benchmark
- [ ] Validator runs once per run (can afford to be stricter)
- [ ] Render: hollow rings, not filled circles
- [ ] Render: edges as hairlines, one draw call
- [ ] Render: buckets as open wireframe boxes
- [ ] Render: monospace glyph layer for levels and transform names
- [ ] Background: sparse hairline grid replaces the circuit shader
- [ ] Existing scoring still works end to end
- [ ] `npm run smoke` green, screenshot reviewed

## Pass 2 — Signal & levels

Goal: the new scoring core, tuned. Upgrades applied by debug command, not bought.

- [ ] Downward signal propagation with per-hop decay and a cutoff floor
- [ ] A node scores once per pass whether struck or signalled
- [ ] Node levels (`10 x level`) and the 9 node transforms
- [ ] Bucket levels (`1 + 0.25 x level`) and the 7 bucket transforms
- [ ] Harness extended to measure propagation yield per node
- [ ] Propagation retention tuned in the harness before it is tuned by feel
- [ ] Debug commands to grant levels/transforms for testing

## Pass 3 — Deck, shop, money

Goal: the complete v2 loop.

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
