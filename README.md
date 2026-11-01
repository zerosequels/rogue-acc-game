# rogue/acc

A browser-based neural pachinko roguelike. The board is a language model you
own and upgrade across a run: tokens of training data cascade through its
weights, activation propagates down the network, and every output token you
hit is a benchmark contribution. Clear eight funding rounds and you IPO — you
cash out and the bubble pops *after* you are rich. Miss a benchmark and it
pops while you are still holding.

Three.js · TypeScript · Vite · Rapier2D · pure client-side, no backend.

![rogue/acc board](tools/board.png)

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with HMR on http://127.0.0.1:5173 |
| `npm run dev:lan` | Same, exposed on your local network (test on a phone) |
| `npm run build` | Typecheck, then production bundle into `dist/` |
| `npm run typecheck` | `tsc --noEmit` (covers `src` **and** `tools`) |
| `npm run sim` | **Full-run sweep** — plays complete runs headlessly |
| `npm run upgrades` | **Shop audit** — every item's measured value per dollar |
| `npm run propagation` | **Signal retention sweep** |
| `npm run smoke` | Build, then drive the real game in headless Chromium |
| `npm run shot` | Build, then screenshot the board mid-propagation |

> **If `localhost:5173` refuses to connect:** Node 17+ binds the IPv6 loopback
> only, so the server lands on `[::1]` while the browser resolves `localhost`
> to `127.0.0.1`. `vite.config.ts` pins IPv4 to prevent this.

---

## How it plays

Aim with the mouse or `◄ ►`, hold `SPACE` to charge, release to fire. You do
not choose what you fire — the draw queue does — so aim is your only response
to what arrives.

| Key | Action |
| --- | --- |
| `◄ ►` / `A D` / mouse | Aim |
| `SPACE` / click | Charge and fire |
| `E` | Agentic Override — redirect a token mid-flight (if owned) |
| `M` | Mute (persists) |
| `R` | New run |
| `Enter` / `1`–`4` | Operate any sheet without the mouse |

**The run.** Eight funding rounds (Pre-Seed → IPO), three benchmarks each,
a shop after every one. Twenty-four benchmarks, twenty-four shop visits.
Frontier Claims from Seed onward carry a **boss modifier** — Compute Shortage
cuts your activations, Distribution Shift kills the bottom layers, Context
Collapse halves signal decay, Data Contamination stops buckets paying.

**Money.** One dollar is one billion dollars. You earn it from clearing,
overshooting, unspent activations, and **interest** — which is what makes the
economy a decision rather than an accumulator. Past the interest cap, hoarding
earns nothing and the money belongs in the board.

---

## The shop: precision is the price

The same effect costs more when you get to say where it lands.

| Precision | You choose | Cost | What it buys |
| --- | --- | --- | --- |
| **Blind** | nothing | ×1.0 | breadth — sprays across many weights |
| **Banded** | upper / middle / lower third | ×1.6 | depth where it matters |
| **Precise** | the exact weight, token or card | ×2.5 | combos — GELU above an attention head |

That reconciles a Balatro-style shop (choosing what to buy *is* the game) with
upgrades that land unpredictably: **you control what you build, the machine
decides where it lands — unless you pay.**

One exception, deliberately: **card removal is always precise.** Random
deletion is pure frustration, and thinning only reads as a decision when you
choose what leaves.

---

## Signal propagation

Scoring does not happen only where the ball touches. A struck node fires its
**downward** edges; nodes in the layer below score without being touched, and
fire their own edges in turn. Signal retains **45% per hop** and dies below
**8%** of the originating strike.

Three properties make this safe to run inside a physics step:

- **Downward only.** Edges are generated layer *N* → layer *N+1* and never
  otherwise, so the graph is a DAG by construction. There is no cycle to guard.
- **Score once per pass.** A node already scored is not re-entered, so the
  wavefront can never revisit and the work is bounded by node count regardless
  of wiring.
- **Bounded depth.** Signal dies at the floor; `SIGNAL.maxHops` caps it
  independently as a backstop against a tuning slip.

Retention was *measured*, not chosen. `npm run propagation` sweeps it against
real boards and real physics:

```
retention  contacts  signalled  total lit  score p50  passes to clear
   0.00      10.0        0.2       10.1        301       7.3   (edges off)
   0.35       5.5       16.4       21.9        367       6.0
   0.45       4.8       22.1       26.8        416       5.3
   0.60       4.3       25.7       29.9        517       4.3
```

Two things that table shows which intuition would have missed. **Node counts
step rather than slide** — retention really selects the *hop count* via the
floor (0.30–0.40 all give two hops, 0.45–0.50 give three, 0.55–0.60 give four).
And **contacts fall as retention rises**, because a node already lit by signal
is already scored, so the ball's later contacts on it do nothing.

At 0.45 a forward pass lights 27 of 68 nodes and signal contributes about two
thirds of the score — propagation is the scoring core, not a garnish.

## Two design decisions worth explaining

### There is no Frenzy meter, and no temperature either

**Frenzy** was in the original brief: a meter that builds during dense cascades
and multiplies score. It was cut, and the reason is not balance. A meter that
fills during a cascade is something the player *watches*, not something the
player *decides* — and in a pachinko game your entire input surface is aim,
charge, fire. Adding a bar that fills on its own does not add a decision; it
adds an animation.

**Temperature** replaced it for one version: a sampling parameter you set
before each shot, trading bounciness and score against activation cost. That
was a real decision, and it worked. It was cut anyway when the deck arrived,
because the deck does the same job better: risk is now something you *build*
(what you put in your corpus) rather than something you dial in before each
shot. Synthetic Gen rolls its value every launch; Unverified Source triples it
against a one-in-five total loss. The gamble moved from a slider into the
economy.

### Signal is a bonus, not a consumption

Signal activations originally marked nodes as struck, exactly like a ball
contact. The sweep showed the cost immediately: contacts per pass fell from
10.0 to 4.3 as retention rose, because **the ball was being starved by its own
network** — the first contact ate most of the board and every later contact
found it spent.

Signal now does not consume the node, and does not advance the multiplier
tier. The ladder stays a measure of how well you **aimed**; signal measures how
well your network is **wired**. Keeping them separate is what stops a good
build from erasing the skill component.

---

## Where the balance values live

**`src/config/balance.ts` is the only file with physics and scoring constants
in it.** Round targets live in `config/rounds.ts`, shop prices in
`config/shop.ts`. Nothing else contains a magic gameplay number.

The invariant everything hangs off:

```
ROUNDS.growth       1.285   how fast benchmark targets escalate
purchases/benchmark ~2      how often you can intervene
=> each purchase must move total power ~19%
```

**If you change `ROUNDS.growth`, shop item strength has to move with it** or
the back half of the run becomes unwinnable — the full-run sweep showed
exactly that, with pace drifting from 3 passes to 11 and every run dying at
Series A. This is the single most important coupling in the game and it is
commented at both ends.

| Where | What |
| --- | --- |
| `SIGNAL` | Retention, floor, hop cap. The most dangerous numbers here |
| `PROGRESSION` | Level caps and the bucket multiplier step |
| `TRANSFORMS` | Every node and bucket transform's payout |
| `DECK` | Starting deck size, card level step, transform parameters |
| `ECONOMY` | Activations per benchmark, payouts, interest, caps |
| `ROUNDS` | Target curve, payouts, boss assignment |
| `SHOP` | Stock size, reroll pricing |
| `BOARDGEN` | The lattice: 9 layers, 8 per row, edge wiring odds |
| `VISUAL` / `COLORS` | Bloom, glitch ceiling, shake, palette |

---

## Tuning

`npm run sim` runs the real generator, the real validator, the real physics and
the real scoring code with no renderer attached, then reports the distributions
that actually decide whether the numbers work.

```bash
npm run sim          # 24 seeds
npm run sim -- 60    # 60 seeds
```

This exists because the acceptance criteria for this game are things like
"cascades feel energetic" and "boards stay playable", which cannot be eyeballed
reliably. It paid for itself immediately: the first run showed a random-aim bot
winning **87.5%** of games and clearing stages in 3 passes instead of 8. The
cause was a single line — attention-head hits were advancing a full multiplier
tier each, so two heads on a mediocre 11-weight cascade reached the top ×3 tier.
After fixing that and recalibrating targets against measured output:

```
win rate            16.7%  (unskilled baseline)
passes per stage    p50 7
median cascade      11 weights
board fallbacks     0%
```

Read it as: an unskilled random-aim bot should win *rarely but not never*. If a
bot that does not aim clears most runs, the game has no skill ceiling.

### Shop audit

`npm run upgrades` applies every shop item to a fresh board and measures what
it actually did to a median pass, reporting **dollars per 10% of power**. An
item is priced well when it costs about the same per unit of power as its
neighbours; a conspicuously cheap row is an auto-buy and a dear one is never
worth taking.

It has found a defect every time it has been run. Most recently:

- **Deduplicated did literally nothing.** It granted `+1 maxHops` — but
  `maxHops` never binds, because the decay *floor* always stops a wave first.
  Measured at exactly 0%. It now lowers the floor instead.
- **Transform purchases were worthless.** One node of 68 measured +0–4% at
  $12–24 per 10%, against level purchases at $1.5. Blind and banded transforms
  now hit several weights; precise ones hit one, hard.
- **Precision was strictly dominated.** `+4 levels to one weight` (+4%) lost
  outright to `+1 level to ten weights` (+14%) at the same price. Precision
  has to buy real depth if it is not buying breadth.

Items the audit *structurally cannot* measure — anything paying out on a later
pass, anything variance-based, anything paying money instead of score — are
labelled `n/a` with the reason rather than being mislabelled as traps.

### The blind spot that kept producing traps

Twice now, code has been invisible to the harness and wrong because of it.

First, Chain Reaction and Explosive Weights lived in `core/game.ts`, on the
far side of the sim/render split where the headless harness could never run
them. Both read exactly 0%. Moved into `src/sim/effects.ts`, Explosive Weights
immediately measured **−28%** — it destroyed weights *permanently*, so paying
once deleted a weight for every remaining pass of the benchmark.

Second, `tools/` was outside `tsconfig.json`. Both harnesses silently rotted
through the v2 refactor and only failed at runtime, and `tools/upgrades.ts`
spent a while auditing a *deleted* upgrade catalogue. `tools/` is now
typechecked with `src`.

The lesson is the same both times: **anything on the wrong side of a
measurement boundary cannot be tested, and what cannot be tested will
eventually be wrong.**

The sim layer imports nothing from Three.js or the DOM, which is what makes the
harness possible. **Keep it that way.**

---

## Procedural boards

Each stage is a new model configuration, built layer by layer — the theme's
"layers" are literal. Each layer picks a placement pattern (`lattice`, `offset`,
`funnel`, `arc`, `cluster`, `sparse`, `colonnade`), so a board reads as a stack
of distinct structures rather than uniform noise.

One hard constraint throughout: no two weights closer than `PIN.minSpacing`,
derived from orb and pin radii so a token can always physically pass between
neighbours. Violate it and you get invisible walls that silently eat cascades.

### The validator is a crash guard, not a design system

`src/sim/validator.ts` does not try to make boards fun — the generator is
responsible for that. It only rejects boards that are *actively broken*: ones
where tokens wedge between weights forever, or where a drop falls through a gap
and strikes almost nothing.

It fires 24 probe drops across the full aim cone into a throwaway physics world
and measures median cascade length, settle rate, and max token lifetime.
Candidates that fail are regenerated, up to 10 attempts, then it falls back to a
handcrafted reference board. In the current sweep it accepts in **1.5 attempts
on average and has never needed the fallback** — but one unplayable stage in a
run is worse than any amount of sameness, so the guard stays.

The verdict is surfaced on the stage-intro screen, which doubles as flavour: the
lab checked the configuration before letting you run tokens through it.

---

## Seeds

Every random decision in gameplay flows through a seeded `sfc32` stream.
**`Math.random()` is banned from gameplay code** — the only exceptions are
minting a new seed and cosmetic popup jitter.

Streams are derived, not shared: `deriveRng(seed, 'board', 4)` gives stage 4 the
same board no matter what you picked on stages 1–3, and no matter how many times
the RNG was pulled elsewhere. That independence is what makes a seed meaningful.

The seed is in the URL (`?seed=XXXX-XXXX`), shown bottom-right, and **copy
link** puts a shareable URL on your clipboard. **Retry this seed** on the
game-over screen replays the identical run.

This is also why the physics engine is Rapier rather than cannon-es: Rapier is
deterministic for a given build, so a seed reproduces cascades and not merely
layouts. cannon-es makes no such guarantee.

---

## Architecture

```
src/
  config/
    balance.ts      physics, scoring, signal, economy constants
    rounds.ts       8 funding rounds x 3 benchmarks, and the bosses
    shop.ts         38 shop items and the precision pricing axis
    mods.ts         the flat Mods bag the sim reads
  core/
    rng.ts          seeded sfc32, derived streams
    state.ts        run model + phase machine. No Three.js, no Rapier, no DOM
    shopkeeper.ts   rolling stock, resolving targets, applying purchases
    game.ts         orchestration: physics, views, HUD, frame loop
  sim/              HEADLESS — imports nothing from Three.js or the DOM
    board.ts        inert network description
    boardgen.ts     the fixed lattice; the seed varies wiring and start state
    validator.ts    headless playability probing, once per run
    physics.ts      Rapier2D wrapper, fixed timestep, velocity clamping
    propagation.ts  the forward pass
    scoring.ts      node values, transforms, buckets, pass accumulation
    effects.ts      upgrade effects acting on the sim (splits, detonations)
    deck.ts         training data: types, levels, transforms, draw queue
    launcher.ts     aim, charge, the chambered card
  render/
    scene.ts        renderer, ortho camera, bloom + glitch, screen shake
    boardView.ts    instanced rings, hairline edges, glyph label layer
    orbView.ts      tokens, trails, launcher
    background.ts   blueprint-grid substrate
  audio/
    sound.ts        procedural WebAudio, no assets
  ui/
    hud.ts          DOM heads-up display
    overlays.ts     brief / cleared / shop / run end
  flavor/
    text.ts         player-facing copy, seeded selection
tools/
  simulate.ts       full-run sweep
  upgrades.ts       shop item value audit
  propagation.ts    signal retention sweep
  smoke.mjs         real-browser runtime test
  shot.mjs          screenshot the board mid-propagation
```

Responsibility split, so each file stays readable:

- `state.ts` decides the **rules** — can I fire, did I clear, what did I earn?
- `scoring.ts` decides the **points** — what is this weight worth right now?
- `propagation.ts` decides the **spread** — what else did that light up?
- `physics.ts` decides the **motion** — where did the token go?
- `shopkeeper.ts` decides the **market** — what is for sale, what does it do?
- `game.ts` decides the **order** — what happens next, and who gets told?

### Two invariants the physics layer enforces

1. **Fixed timestep.** The world is only ever stepped with `PHYSICS.dt`.
   Stepping with frame delta destroys determinism and makes bounce tuning
   framerate-dependent.
2. **Velocity clamp every step.** Small fast tokens against roundish weights is
   the classic tunnelling setup. CCD is on too, but the clamp is the real
   insurance — and it keeps cascades readable instead of a blur.

Weights are also deliberately *larger* than tokens (`0.3` vs `0.25` radius),
which both prevents tunnelling and makes every bounce read clearly.

### Pass resolution

A forward pass is not over when you release the launcher — it is over when the
last of its tokens leaves the board, because a benchmark spike retroactively
multiplies everything banked during that pass. Score is held uncommitted in
`Pass` until `orbCount` hits zero.

A weight scores **once per pass, not once per contact**. Without that, a token
rattling in a pocket of three weights farms them forever and the multiplier
ladder becomes meaningless. "Chain" in the HUD is therefore the count of
*distinct* weights struck.

---

## Testing

`npm run smoke` builds the game, serves `dist/`, boots it in headless Chromium,
drives real keyboard and pointer input through several passes, and fails on any
console error or page exception.

This is not ceremony. Typechecking and bundling prove nothing about a WebGL app,
and the smoke test caught two bugs that both passed `tsc` and `vite build`
cleanly:

- `active` is a **reserved word in GLSL ES**, so the entire glitch pass silently
  failed to compile.
- `vertexColors: true` on an `InstancedMesh` material makes Three look for a
  per-vertex `color` attribute that `CircleGeometry` does not have, so **every
  weight on the board rendered black**. Instance colours come from the separate
  `instanceColor` attribute and need no such flag.

Set `ACTION_SHOT=1` to also write `tools/board.png` and `tools/action.png`.

---

## Scope

**In:** the full v2 loop — 8 funding rounds x 3 benchmarks, persistent
upgradeable board, signal propagation, per-card deck with random draw, shop
with three precision tiers, money with interest, boss modifiers, seeded
determinism, wireframe art direction, procedural audio, three headless
harnesses and a browser smoke test.

**Out:** meta-progression between runs, endless mode past IPO, music.

### Known rough edges

- **The bundle is ~4 MB.** `@dimforge/rapier2d-compat` inlines its WebAssembly
  as base64. Switching to `@dimforge/rapier2d` with a wasm plugin would cut it.
- **Pace still drifts late.** 3 passes at Pre-Seed, ~11 by Series E. That is a
  defensible difficulty curve rather than flat, but it is not the 6-8 band the
  design aimed for across the whole run.
- **Several shop items are unmeasurable by the audit** and are judged only on
  the full-run sweep — anything that pays out on a *later* pass, depends on
  variance, or pays money instead of score. They are listed with reasons in
  `tools/upgrades.ts`.
- **Trajectory preview is ballistic, not collision-accurate.** Deliberate.
- **No pause**, no persistence between runs beyond the mute preference.
- **Spike magenta vs drain red is a colourblind hazard** — they should differ
  by shape, not only hue.
- **Not responsive.** The deck rail and HUD assume a desktop viewport.
