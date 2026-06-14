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

The names aren't decoration; they're the design. They come from Aristotle, and you don't need
to have read him — here are the four ideas, in plain language.

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

The core enforces one structural rule above all: **two causes, kept apart.** There are exactly
two ways anything ever changes, wired as two separate event subscriptions in `core.ts`:

```
  the world moved        →   state.changed   →   Eudaimon.pursue()      (the agent reacts)
  an authority decides   →   goal.updated    →   GoalLedger.install()    (a new fixed star)
```

The agent reacts to `state.changed`. A new goal arrives only via `goal.updated`, which only an
authority emits. **The agent is never on the goal-setting path.** This is what keeps the
metaphor — and the safety property — intact: an agent that pursues a goal cannot redefine the
goal to declare itself finished.

```
src/
  core.ts             # UnmovedMover, the GoalLedger / Domain / Action / Deliberator ports,
                      #   EventBus types, Eudaimon, wire()  — depends only on zod, never `ai`
  ledger.ts           # InMemoryGoalLedger — the default, swappable for a DB-backed one
  bus.ts              # inMemoryBus — the default, swappable for Redis / SNS / PubSub
  deliberate-rule.ts  # ruleDeliberator — offline, deterministic, zero dependencies
  deliberate-ai.ts    # aiDeliberator (import: "@decocms/telos/ai") — the ONLY file using `ai`
examples/
  run.ts              # a runnable demo
  domains/            # two example worlds (storefront, content-calendar) on the same core
```

Everything except `core.ts` is a *default you can replace*. The ledger, the bus, and the
deliberator are all ports; the in-memory implementations exist so the thing runs today.

---

## Install

```bash
bun add @decocms/telos

# optional — only if you want the LLM-driven deliberator:
bun add ai
```

The core depends only on `zod`. `ai` is an **optional peer dependency** used solely by the
`@decocms/telos/ai` subpath; if you only ever use `ruleDeliberator`, you pull nothing extra.

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
nothing in `core.ts` changes.

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
4. **The core is IO-free and AI-free.** The main entrypoint never imports `ai`. Only
   `@decocms/telos/ai` may. That's what keeps the offline path light and the package portable.

## Using telos as its own repo

It's self-contained (deps: `zod`; optional peer: `ai`). To lift it out of this monorepo:
inline the compiler options from the root `tsconfig.json` into this package's `tsconfig.json`
(it currently `extends` the root), add a minimal root config + CI, then
`bun install && bun test && bun run example`.

---

*v1 — standalone and inert. Nothing in the wider codebase imports it yet; see
[`MESH-INTEGRATION.md`](./MESH-INTEGRATION.md) for how it would later attach to a host, and
[`SPEC.md`](./SPEC.md) for the full contract.*
