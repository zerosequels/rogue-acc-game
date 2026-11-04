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

- [x] **Remove temperature** — the deck replaces the per-launch choice
- [x] Per-card deck: types, levels, transforms, random draw queue
- [x] The 6 card transforms
- [x] Shop with three precision tiers and reroll
- [x] Money: clear reward, overshoot, interest, unspent activations
- [x] 8 funding rounds x 3 benchmarks
- [x] Boss modifiers on Frontier Claim benchmarks
- [x] IPO win screen (cash out, bubble pops behind you)
- [x] Failure screen (bubble pops while you are still holding)
- [x] Full-run harness retuned against the new curve

**Pass 3 notes**

Final balance (`npm run sim`, 24 runs, random-aim bot with a naive shopping
policy): **4.2% IPO win rate, median reach Series C/D, 42 purchases per run.**
Pace runs 3 passes at Pre-Seed to ~11 at Series E — generous on-ramp, real
squeeze late.

Three problems the harness caught that playing would not have:

1. **Upgrade breadth.** `+1 level to one weight` is 1.5% of a 68-node board
   against a required ~19% per purchase. Pace drifted 3 -> 11 passes and runs
   died at Series A. Level and transform purchases now hit SEVERAL nodes, and
   precision trades breadth for choice: blind sprays wide, precise lands one
   hard. That is the mechanical meaning of the pricing axis.
2. **Deduplicated did nothing at all.** It granted `+1 maxHops`, but maxHops
   never binds — the decay FLOOR always stops a wave first. It now lowers the
   floor instead. Measured at exactly 0% before the fix.
3. **Capital starvation.** The bot ended every run at $1. Payouts, interest
   cap and the unspent bonus were all raised; purchases went 12.7 -> 42 a run.

Also: `tools/` is now inside `tsconfig.json`. Both harnesses had silently
rotted through the v2 refactor and only failed at runtime, because the
typechecker was never looking at them. A broken measuring instrument is worse
than none. `tools/upgrades.ts` was additionally auditing the DELETED v1
upgrade catalogue; it now audits the shop, and `src/config/upgrades.ts` is
gone (the surviving `Mods` bag is `src/config/mods.ts`).

---

## R1 — Holographic volume (graphics overhaul)

Proposal: https://claude.ai/code/artifact/3f1ad8fd-9c46-487d-80fe-88c272f8736c

Direction: keep the neon, give it volume. **Nothing in the chamber is lit —
every surface emits.** Flat rings became dense spheres; the wireframe moved
from geometry into the shader.

- [x] `render/shell.ts` — one emissive material for every solid
- [x] Dense sphere geometry (40x26). No visible facet anywhere
- [x] Procedural geodesic grid drawn from the surface NORMAL, not topology
- [x] Fresnel rim + object-space scan sweep
- [x] Proximity excitation: shell energy from distance to tokens in flight
- [x] Attention heads as faceted amber crystals (octahedra, grid disabled)
- [x] Nested inner shells for levelled weights
- [x] Edges as instanced cylinder conduits with travelling beads
- [x] Tokens as plasma core inside a wireframe shell
- [x] Output tokens as 3D wells with depth
- [x] Orthographic camera with a 9-degree tilt
- [x] `worldToScreen` / `screenToWorld` corrected for the tilt
- [x] `npm run smoke` green through 12 benchmarks with shop purchases

**Mechanics untouched, verified by diff.** Only `render/`, the `VISUAL` and
`COLORS` blocks, and two render calls in the frame loop changed. `src/sim/**`
has zero modifications and never reads a presentation constant, so every
harness result still stands.

**R1 notes**

- The grid is drawn from the normal rather than from mesh topology. That is
  what lets the mesh be smooth and dense while the wireframe stays crisp —
  and it makes grid density a free per-instance channel, which is how level
  is encoded alongside scale and shell count.
- Tuning the pitch demos did not transfer. A node is ~11px on screen in the
  real game against ~90px in the pitch, so the grid had to drop from 6
  divisions to 2.5 and the rim had to tighten from power 1.7 to 2.9 before
  anything read. Scale is a tuning input, not a detail.
- Additive shells accumulate, so resting energy had to come **down** (0.46 to
  0.15) or 68 overlapping shells wash the playfield into haze.
- Shells are drawn at 0.92 of their collider radius, deliberately UNDER 1.
  An additive shell larger than its collider makes passable gaps look blocked.
- The camera tilt broke both projection helpers. `worldToScreen` now goes
  through the real projection matrix and `screenToWorld` raycasts a plane;
  the previous flat remaps were wrong by the tilt, which would have drifted
  every score popup off its weight and desynced mouse aim.

## R2 — Reference-art lessons + dense lattice

Three pieces of reference art drove this pass (Yann Le Gall, matharium,
erwanrenders). The thread all three share: **structure stays thin and
neutral, energy concentrates at POINTS**, and every one of them has grain.

- [x] **Point emission.** Shells gained a tight `core` term. A uniformly
      glowing sphere washes out when 175 overlap; a hot centre inside a thin
      rim stays legible at seven pixels.
- [x] **Spectral dispersion.** The old monochrome chromatic split became a
      luminance-weighted RGB fringe with a second wide tap, so only hot
      things go prismatic and the substrate stays neutral.
- [x] **Ordered dither + film grain.** 4x4 Bayer plus animated noise. Gives
      the phosphor character and kills the banding additive blending leaves
      in dark areas.
- [x] **Tapering comet trails.** Trail length 26 -> 64, cubic falloff, plus
      ten shrinking echo shells behind the core. A line cannot narrow, so the
      taper had to be geometry.
- [x] **Instrument chrome** (`render/chrome.ts`): corner brackets,
      coordinate ticks with major/minor scale, dashed registration circle,
      slow scan sweep. Two draw calls, nothing per frame.
- [x] **Diegetic telemetry**: a coordinate lock riding the token
      (`x -6.2 y 8.2 v 13`) and `LOCK ATTN_034` when a head is struck.
- [x] **Shop UI on the same system**: corner brackets, telemetry channel
      slugs, spectral fringe on display type, shared grain and scanline
      surface via an inline SVG data URI (bundle stays asset-free).

### Denser lattice (mechanics)

- [x] Weights 0.30 -> 0.19 radius, tokens 0.25 -> 0.155
- [x] Lattice 9x8 (68 nodes) -> 14x13 (175 nodes)
- [x] `basePinValue` 10 -> 4, `criticalPinValue` 35 -> 14
- [x] `ORB.maxSpeed` 40 -> 30: at the smaller radii a 1/120 step moved 0.33
      units against a combined radius of 0.345, close enough to tunnel if CCD
      ever missed
- [x] Rebalanced and verified: **6.3% unskilled IPO rate, median reach
      benchmark 13 of 24, pace holding 4-9 passes across the whole curve** —
      flatter than the sparse board ever managed

**The bug that recurred, and the fix that ends it**

Tripling the node count silently broke shop reach for the second time.
Absolute counts meant "+1 level to 10 weights" fell from 14.7% of the board
to 5.7%, and every run died at Pre-Seed. Shop counts are now scaled by
`board.nodes.length / SHOP.referenceNodes` at purchase time, and the card
quotes the real resolved number ("+2 level to 41 weights"). Board density can
now change freely without re-tuning the catalogue.

Also found: the opener was the real killer at `baseTarget` 1500 — six passes
out of ten activations leaves no room for a bad pass, and half the runs died
on benchmark 0. The first benchmark is an on-ramp; difficulty is carried by
growth.

## R3 — Docked market, feed, target preview

- [x] **Bucket gaps fixed (gameplay bug).** Spikes were drawn at 55% width,
      leaving dead strips between pockets where a token resolved to nothing,
      fell through and was culled as stuck — a lost activation with no score
      and no feedback. Pockets now TILE the floor at uniform width, and
      `pocketAt` falls back to the nearest pocket so a shot can never vanish.
      Spikes stay hard by POSITION (never centre), not by being small enough
      to fall past.
- [x] Neon bleed dialled back: bloom 0.46 → 0.30, radius 0.55 → 0.44,
      threshold 0.42 → 0.52, dispersion 0.0055 → 0.0032.
- [x] **The shop is a docked side panel**, not a full-screen sheet.
- [x] **Fake AI news feed** (`flavor/news.ts`) streams while a round is live,
      weighted by state: tense when activations are short, triumphant when
      the target is in reach. Same panel, two modes.
- [x] **The net mutes in market mode** so the panel and the preview carry focus.
- [x] **Hover preview**: hovering a shop item lights the exact weights it
      would hit, and the card states the count.
- [x] **Precise purchases are clicked on the board**, not chosen from a list.

**Why the shop had to move**

The hover preview is the point, and a full-screen sheet made it impossible —
it covered the board, so there was nowhere to show the targets. Docking the
panel was the enabling change, not a cosmetic one. It also gave the feed
somewhere to live and made board-click targeting the obvious interaction for
precise purchases: with 175 nodes, picking from a list is unusable, but
pointing at one is trivial.

**How the preview stays honest**

Preview and purchase call the SAME `resolveTargets` with the SAME rng, both
derived through `purchaseRng(run)`. If those ever diverge the highlight
becomes a lie, so there is exactly one function that decides each. The
player now has complete information about a selection that is still random:
you choose what to buy, the machine chooses where it lands, and you can see
where before you commit.

### Not yet done (from the proposal)

- [ ] Ghost lattices receding into depth
- [ ] Depth of field focused on the play plane
- [ ] Event choreography: shell squash, ghost echo
- [ ] Picture-in-picture zoom inset (the one reference idea not yet taken —
      it is also the only one that would make per-node detail readable)
- [ ] Per-effect quality flags

---

## Standing rules

- `src/config/balance.ts` stays the only file with gameplay constants.
- `src/sim/**` imports nothing from Three.js or the DOM. This is what makes the
  headless harnesses possible, and it is how the `-28%` Explosive Weights trap
  was found. Do not break it.
- Anything that changes scoring gets measured in `npm run upgrades` or
  `npm run sim` before it is tuned by feel.
- `Math.random()` stays banned in gameplay code.
