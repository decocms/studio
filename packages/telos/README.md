# `@decocms/telos`

> A small, domain-agnostic core for agents that **pursue a fixed goal**. One agent per
> tenant watches a world, measures it against a goal it did not choose, and acts to close
> the gap — until there is no gap left.

Most "agent" libraries are about *how to think* (tool loops, planners, memory). Telos is
about *what an agent is for*. It starts from a goal and builds the smallest possible machine
that strives toward it — and keeps the goal and the striving rigorously separate, so the
agent can never quietly rewrite its own purpose.

The whole core is a few hundred lines and depends only on `zod`. It knows nothing about any
particular world; you teach it one by writing a `Domain`.

---

## The idea in one minute

```
          a goal (fixed)                  the world (changes)
        ┌────────────────┐              ┌────────────────────┐
        │  UnmovedMover   │   measure   │   observe → state   │
        │  (the target)   │◀────gap─────│                     │
        └────────────────┘              └────────────────────┘
                 ▲                                 ▲
                 │ consulted every cycle           │ acted upon
                 │ (never written by the agent)    │
                 └───────────  Eudaimon  ──────────┘
                              (the agent)
```

Each cycle the agent: **observes** the world → checks if the goal is **satisfied** → if not,
measures the **gap** → **deliberates** (rule-based or with an LLM) → **acts** to shrink the
gap. When the goal is reached it says so and stops. The goal itself only ever changes when an
outside authority installs a new version — never by the agent's own hand.

---

## The philosophy (and why the names matter)

The names aren't decoration; they're the design. "Goal" turns out not to be one thing —
there are **three metaphysics of purpose**, and naming them correctly *is* the architecture:

| Picture | Goal is… | The test | You can… |
| --- | --- | --- | --- |
| **Aristotelian** (the core, below) | immanent, per-tenant, **reachable** | `satisfied(): boolean` | **reach** it |
| **Platonic** (`/demiurge`) | one transcendent, **shared** ideal | `participation(): number` | only **approach** it |
| **Socratic** (`/daimonion`, `/elenchus`) | **uncovered** by questioning; actions **guarded** | `veto(): Veto \| null` | **forbid**, or discover |

The agent skeleton (observe → consider → act) is identical in all three; the only real
difference is *what the goal is and whether you can ever arrive.* Most of what follows is the
Aristotelian core; the other two are in [Beyond the core](#beyond-the-core-three-metaphysics-of-purpose).

The four Aristotelian ideas, in plain language — you don't need to have read him:

### 1. *Telos* — the end something is *for*

**Telos** (Greek τέλος, "end" or "purpose") is the *final cause*: the goal for the sake of
which a thing acts. An acorn's telos is the oak. A knife's telos is cutting. For Aristotle,
to understand anything you ask what it's *for*. This package is named for that idea: every
agent here exists to pursue a telos, and nothing else.

### 2. The *Unmoved Mover* — the goal that causes motion without moving

Aristotle's most striking image: something can cause motion **without itself moving or
acting**, simply by being desired. A target pulls an archer's arm without lifting a finger.
The goal "moves" everything that strives toward it, while staying perfectly still.

In telos, the goal is an **`UnmovedMover`** — frozen, behaviorless data. It has no methods,
touches nothing, and is never edited. It causes the agent to act *only* by being the thing the
agent measures itself against. (When a goal needs to change, you don't mutate it — you append
a new version. More on that below.)

### 3. The *Moved Mover* — the agent that is moved, and moves the world

Between the still goal and the inert world sits the agent: it **is moved** (it perceives the
world and reacts to it) and it **moves the world** (it acts to change it). It's a *mover* —
but a *moved* one, because its motion is caused by the goal it pursues. It never originates its
own purpose.

This is the **`Eudaimon`**.

### 4. *Eudaimonia* — flourishing, the human telos

**Eudaimonia** (often translated "flourishing" or "the good life") is, for Aristotle, the
*telos of a human being* — the end all our other ends serve. A **eudaimon** is one who is
flourishing: living well by fully realizing its purpose. We name the agent `Eudaimon` because
that is exactly its job — to bring its world into flourishing, as defined by the telos it was
given. When the goal is reached, the world has, in the small precise sense the goal encoded,
*flourished*.

### How the metaphor becomes code

| Idea | In the code | What it is |
| --- | --- | --- |
| The goal / final cause (*telos*) | **`UnmovedMover<T>`** | Immutable, versioned, per-tenant target data. No behavior. Never mutated, never acts. |
| The succession of goals | **`GoalLedger<T>`** | Append-only history of `UnmovedMover` versions. A goal "changes" only by appending a new one. |
| The flourishing agent | **`Eudaimon<S,T,G>`** | Observes, measures, deliberates, acts — pursuing the current goal but never authoring it. |
| The world | **`Domain<S,T,G>`** | Everything world-specific: how to perceive it, judge it, and act in it. You write this. |
| Practical reason (*phronesis*) | **`Deliberator`** | The swappable "how to decide": a deterministic planner, or an LLM. |

> A note on *succession, not mutation.* Real goals get raised over time, but a fixed star
> shouldn't secretly move. So in telos a goal never changes in place — a new authority installs
> **v2** alongside the untouched **v1** in the ledger. The agent always pursues the latest, and
> the history of what it was striving for, and when, is preserved.

---

## Architecture

### The kernel reports; the host reacts

The package is two layers, and the seam between them is the whole point:

- **The kernel** is `Domain` + `Eudaimon.pursue()` + the `GoalLedger`/`FactStore` ports + a
  `Deliberator`. `pursue()` runs **one cycle** — observe → satisfy? → gap → deliberate → act —
  and **returns a `PursuitOutcome`** (what it did: applied/vetoed/suggested actions, a summary,
  an advisory `nextReviewMs`, any proposed goal). It never publishes, schedules, or owns a loop.
  This is what a real host depends on: it drives `pursue()` on its own clock, persists through
  its own ledger adapter, and decides what to notify from the returned outcome.
- **The single-process runtime** is `wire()` + `inMemoryBus`. It's *batteries* for a demo or a
  simple host: one `Eudaimon` per tenant in memory, a cycle fired on `state.changed`, the
  outcome fanned back out onto the bus. A durable host (DBOS, a queue, multiple pods) skips
  `wire()` entirely and calls `pursue()` directly — see [Teaching it a new world](#teaching-it-a-new-world-the-one-extension-point).

### Two causes, kept apart

Above the kernel, the core enforces one structural rule: **two causes, never crossed.** In the
single-process runtime they're two separate event subscriptions in `wire()` (`core/eudaimon.ts`);
a durable host keeps the same two paths distinct in its own orchestration:

```
  the world moved        →   state.changed   →   Eudaimon.pursue()      (the agent reacts)
  an authority decides   →   goal.updated    →   GoalLedger.install()    (a new fixed star)
```

The agent reacts to the world moving. A new *anchor* goal arrives only from an authority. **The
agent is never on the anchor-setting path.** This is what keeps the metaphor — and the safety
property — intact: an agent that pursues a goal cannot redefine the goal to declare itself
finished. (It may author *subordinate* goals beneath the anchor, if you wire a proposer; `pursue()`
returns each one in `outcome.proposal`.)

```
src/
  core/             # the Aristotelian core — depends only on zod, never `ai`
    mover.ts        #   UnmovedMover — the frozen goal
    ledger.ts       #   GoalLedger port + InMemoryGoalLedger (the default)
    domain.ts       #   Domain / Action ports — the one thing you write
    deliberator.ts  #   Deliberator port + applyAction
    events.ts       #   EventBus types + inMemoryBus (single-process runtime only)
    eudaimon.ts     #   Eudaimon (pursue → PursuitOutcome) + wire() (the runtime)
  deliberators/
    rule.ts         #   ruleDeliberator — offline, deterministic, zero dependencies
    ai.ts           #   aiDeliberator ("@decocms/telos/ai") — the ONLY file using `ai`
  extensions/
    daimonion.ts    #   the veto guardrail ("@decocms/telos/daimonion")
    elenchus.ts     #   goal-discovery dialectic, interface ("@decocms/telos/elenchus")
    demiurge.ts     #   transcendent-ideal interface, reserved ("@decocms/telos/demiurge")
  storage/
    postgres.ts     #   Postgres adapter ("@decocms/telos/postgres") — optional peer `kysely`
examples/
  run.ts            # a runnable demo
  domains/          # two example worlds (storefront, calendar) on the same core
```

Everything except the kernel is a *default you can replace*. The ledger, the bus, and the
deliberator are all ports; the in-memory implementations exist so the thing runs today, and
`@decocms/telos/postgres` is a shipped DB-backed ledger + fact store for when you need durability.
The bus and `wire()` are the single-process runtime — a durable host supplies its own.

---

## Install

```bash
bun add @decocms/telos

bun add ai      # optional — only for the LLM-driven deliberator (@decocms/telos/ai)
bun add kysely  # optional — only for the Postgres storage adapter (@decocms/telos/postgres)
```

The core depends only on `zod`. `ai` and `kysely` are **optional peer dependencies**, each
pulled by a single subpath; if you use only `ruleDeliberator` + the in-memory ledger, you pull
nothing extra.

## Quickstart

```bash
bun run example       # offline — rule-based deliberator, NO API key needed
bun run example:ai    # LLM deliberator via the AI SDK (needs a model + key)
```

The offline run drives two unrelated worlds end to end on the same core: the agent acts each
cycle, the metrics converge to the target, `unmovedMover.reached` fires, then the goal is
**raised from above** (v2) and the agent re-pursues — all without mutating a single mover.
Expected tail:

```
ledger history: v1 -> v2
final state: { conversionRate: 0.06, avgOrderValue: 95, bounceRate: 0.3, ... }
```

## Teaching it a new world (the one extension point)

A `Domain` is everything world-specific. Implement it once per world your agent should inhabit;
nothing in `core/` changes.

```ts
import {
  type Domain, wire, inMemoryBus, InMemoryGoalLedger, ruleDeliberator,
} from "@decocms/telos";

const myDomain: Domain<MyState, MyTarget, MyGap> = {
  name: "my-world",
  observe(tenant)     { /* read the current state of the world */ },
  satisfied(state, t) { /* has the goal been reached? */ },
  gap(state, t)       { /* the distance left — used in the prompt and telemetry */ },
  instructions: "Pursue the FIXED target you cannot change. Close the gap; then stop.",
  actions: [ /* Action[]: the agent's "hands" — plain async functions */ ],
  prompt(input)       { /* turn the situation into a prompt for the LLM deliberator */ },
  plan(input)         { /* optional: deterministic steps, so the offline deliberator works */ },
};

const bus = inMemoryBus<MyTarget>();
const ledger = new InMemoryGoalLedger<MyTarget>();
wire({ bus, ledger, domain: myDomain, deliberator: ruleDeliberator });

ledger.install("tenant-1", /* the goal */);       // an authority sets the fixed star
await bus.publish({ type: "state.changed", tenant: "tenant-1" });  // the world moved → pursue
```

`actions` are framework-agnostic: the rule deliberator calls them via `plan()`, and the AI
deliberator wraps each one as an LLM tool. You write the action once; both paths use it.

### Driving it yourself (durable hosts)

`wire()` is the single-process convenience. A durable host owns its own bus, scheduler, and
storage, so it skips `wire()` and drives the kernel directly — `pursue()` returns the cycle's
outcome and the host reacts to it. No fake bus, no event round-trip:

```ts
import { Eudaimon } from "@decocms/telos";

const agent = new Eudaimon({ tenant, ledger, domain: myDomain, deliberator });
const outcome = await agent.pursue();   // ONE cycle; the host owns the loop

if (outcome.satisfied) notifyReached(tenant, outcome.moverVersion);
for (const s of outcome.suggested) surfaceToUser(tenant, s.kind, s.payload);
scheduleNext(tenant, outcome.nextReviewMs);   // honor, clamp, or ignore the agent's cadence
```

This is exactly how the Studio host runs telos on DBOS: durable workflows call `pursue()` and
map `outcome` onto their own event bus + scheduler. The kernel never knew there was a queue.

> **Bring your own durable bus.** The kernel ships **no** bus — `inMemoryBus`/`wire()` are
> single-process only and are not on a durable host's path. For multi-pod or restart-surviving
> work, react to the `pursue()` outcome from your own infra (NATS, DBOS, a queue) and keep
> durable truth in your ledger/store. You only need a package-level `EventBus` — e.g. a
> NATS-backed one passed to `wire()` — if you want the built-in runtime instead of your own.

## The LLM deliberator

`@decocms/telos/ai` wraps each domain `Action` as an AI SDK v6 tool and lets a model decide
which to call, reading the gap from your `prompt`. The model is **injected** — this module
never resolves one, so it works the same standalone or inside a host application:

```ts
import { aiDeliberator } from "@decocms/telos/ai";

const deliberator = aiDeliberator({
  model,                  // an AI SDK v6 LanguageModel, or a provider/gateway string
  maxSteps: 8,            // hard cap on tool-loop steps per cycle
  maxActionsPerCycle: 5,  // optional safety rail: cap actions actually applied per cycle
});
```

## Persistence (`@decocms/telos/postgres`)

The default `InMemoryGoalLedger` keeps everything in process. For durable storage,
`@decocms/telos/postgres` is a Postgres adapter (Kysely) that — like DBOS — **owns its own
database schema** (`telos`) and migrates it itself. The host never declares telos tables or
carries telos migration files: it hands in a connection, calls `migrateTelos` once at boot,
and maps its own tenant id (e.g. an org id) to `tenant`.

One call gives you the two durable ports — migrate the schema, then build the ledger + fact
store over the host's connection:

```ts
import { initTelos } from "@decocms/telos/postgres";

const { ledger, facts } = await initTelos<MyTarget>({ db }); // migrates + builds both ports
```

`initTelos` returns **only `{ ledger, facts }`** — no bus, no scheduler. Orchestration is the
host's (it owns the loop and the event bus; see [Driving it yourself](#driving-it-yourself-durable-hosts)).
Prefer the pieces if you want to migrate and construct separately:

```ts
import {
  migrateTelos,
  createPostgresGoalLedger,
  createPostgresFactStore,
} from "@decocms/telos/postgres";

await migrateTelos(db); // idempotent; creates the `telos` schema + tables
const ledger = createPostgresGoalLedger<MyTarget>(db); // GoalLedger<T> over telos.goals
const facts = createPostgresFactStore(db); // tentative elenchus findings over telos.facts
```

- **`telos.goals`** — the append-only ledger (`tenant, version, source, target` jsonb), one
  lineage per tenant. Drops straight into `wire({ ledger })`.
- **`telos.facts`** — tentative elenchus findings (`label, value, confidence, status`) the
  tenant confirms or rejects: the persistence side of the goal-discovery dialectic.

`kysely` is an **optional peer dependency**, pulled only by this subpath — the same arrangement
as `ai` for the deliberator. The core stays IO-free.

## Self-directed goals (anchored)

By default goals come only from an authority (`goal.updated`). But you can let the **engine
author its own goals after each cycle** — *anchored* so it can never run away. Provide a
`GoalProposer`:

```ts
import { aiDeliberator } from "@decocms/telos/ai";

wire({
  bus, ledger, domain,
  deliberator: aiDeliberator({ model }),
  proposer: {
    // after a cycle, propose the next SUBORDINATE goal — or null to leave it alone.
    // `anchor` is the fixed parent telos; keep the proposal in its service.
    propose: async ({ state, current, anchor, satisfied }) => nextGoalOrNull,
  },
  // optional gate: return false to reject. Omit → proposals auto-install.
  approveGoal: async (proposed, ctx) => policy.allows(ctx.tenant, proposed),
});
```

Two levels, kept distinct in the ledger by `source`:

- **The anchor** (`source: "authority"`) — the fixed parent telos. Installed only via
  `goal.updated`; the engine can **never** overwrite it. `ledger.anchor(tenant)` returns it.
- **Subordinate goals** (`source: "engine"`) — what the proposer authors, recorded as new
  ledger versions and pursued next. `ledger.latest(tenant)` returns the current one.

The core guarantees the anchor is immovable-by-engine and that every version is audited by
`source`; keeping a subordinate goal genuinely *in service of* the anchor is the proposer's
job (it's handed the anchor to respect). This is the hierarchy of ends: the agent may set its
own lesser goals, but not the fixed end they serve.

## Beyond the core: three metaphysics of purpose

The Aristotelian core (reach an immanent, per-tenant goal) is one of three pictures of
purpose, shipped as subpaths. They are **not alternatives — they compose**, each doing the
job its metaphysics suits.

- **`@decocms/telos/daimonion`** — *the veto guardrail* (Socrates' inner sign). Apophatic:
  it only ever **forbids**, never proposes. `guardedBy(daimonion)(domain)` screens every
  action *before* its side effect; a forbidden action never runs and emits
  `eudaimon.action.vetoed`. **Built and tested.**
  > Not to be confused with the **Eudaimon** — the striving agent that *drives*. The
  > **Daimonion** is the conscience that only says *no*. Different beasts, similar Greek root.
- **`@decocms/telos/elenchus`** — *the goal-discovery dialectic* (interface). The goal is
  **uncovered by questioning**, not installed: `deliver(tenant) → GoalProposal<T>`. It births
  a candidate; an authority then installs it (the `goal.updated` path). This is the contract
  the host's onboarding "research the user → propose a goal" flow implements; the tentative
  findings it surfaces are persisted as `telos.facts` (see [Persistence](#persistence-decocmstelospostgres)).
- **`@decocms/telos/demiurge`** — *the transcendent ideal you only approach* (interface only,
  **reserved**). Plato's Form: one shared, timeless standard every tenant resembles imperfectly,
  forever. `participation(state): number` (0..1) replaces `satisfied()` — you approach, never
  arrive. No implementation yet; the shape is reserved until a real Platonic feature exists.

### How they compose — a tenant's lifecycle

```ts
// 1. Socratic intake: the goal is BORN by questioning, not installed…
const proposal = await elenchus.deliver(tenant);
await ledger.install(tenant, proposal.target); // …then an authority confirms it → the anchor

// 2. Aristotelian pursuit: the Eudaimon chases the goal — every action screened
//    by the daimonion's veto first (the conscience layers over any domain).
wire({ bus, ledger, domain: guardedBy(daimonion)(domain), deliberator });

// 3. Platonic conformance (future): a Demiurge holds the same tenant to the one
//    universal Form, regardless of that tenant's own KPI.
// const demiurge = new Demiurge(idealStorefront, craft);
```

Socratic intake births the goal → the Aristotelian Eudaimon pursues it → the Platonic
Demiurge holds it to a universal ideal → the daimonion's veto screens every action. Three
agents, three metaphysics, one platform.

### Example (future, not implemented): the Deco Store as a Form

The strongest Platonic candidate is a **quality/design-conformance** feature. There is one
ideal of *"an excellent storefront"* — fast, accessible, well-merchandised, trustworthy — that
**every** tenant's store participates in, imperfectly, forever. It is not any tenant's own
target (that's Aristotelian — "hit 6% conversion"); it's a *universal floor of good*, the same
ideal imposed gently everywhere.

```ts
import type { Form } from "@decocms/telos/demiurge";

// ONE shared, timeless ideal — not per-tenant, not versioned.
const idealStorefront: Form<Storefront> = {
  name: "deco-store/excellent-storefront",
  // 0..1 — how closely this store resembles the ideal. Approaches 1, never reaches it.
  participation: (store) => scoreAgainstIdeal(store),
};
```

A `Demiurge` would gaze at this Form and shape each tenant's store toward its likeness on a
cadence, scoring `participation` and emitting `participation.increased` — never "reached",
because no real store is ever *perfectly* excellent. (Sketch only; the interface is reserved,
the implementation is future work.)

## Invariants (don't let a refactor erode these — they *are* the design)

1. **The goal stays frozen.** `UnmovedMover` is `Object.freeze`d, all fields `readonly`. Never
   add a method that touches the world.
2. **The agent never authors its *anchor*.** `Eudaimon` re-reads `ledger.latest()` every cycle
   and holds no goal state. The anchor changes only via `goal.updated` (an authority). The
   engine may propose *subordinate* goals (see above), but it can never overwrite the fixed
   parent. If deliberation could set the anchor from what it observed, the whole thing
   collapses into a system that congratulates itself.
3. **Succession, not mutation.** A new goal is a new version; old versions stay in history,
   untouched.
4. **The core is IO-free and AI-free.** The main entrypoint never imports `ai` or `kysely` —
   only the `@decocms/telos/ai` and `@decocms/telos/postgres` subpaths may. That's what keeps
   the offline path light and the package portable.
5. **Telos owns its persistence.** The `@decocms/telos/postgres` adapter lives in its own DB
   schema (`telos`) and self-migrates; a host never declares telos tables or carries telos
   migrations. It maps its own tenant id to `tenant` and otherwise stays out of the way.

## Using telos as its own repo

It's self-contained (deps: `zod`; optional peers: `ai`, `kysely`). To lift it out of this monorepo:
inline the compiler options from the root `tsconfig.json` into this package's `tsconfig.json`
(it currently `extends` the root), add a minimal root config + CI, then
`bun install && bun test && bun run example`.

---

*The core is standalone and host-agnostic (deps: `zod`; optional peers: `ai`, `kysely`). It's
wired into the Studio host today for new-user onboarding — the elenchus researches a new
tenant, persists tentative facts, and proposes the first goal — but nothing in the core depends
on that host, and the package can be lifted into its own repo unchanged.*
