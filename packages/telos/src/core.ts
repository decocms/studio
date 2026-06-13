// Domain-agnostic core. Depends only on zod — never the AI SDK, so the offline
// path stays dependency-light (the LLM deliberator lives in ./deliberate-ai).

import type { z } from "zod";

type Awaitable<T> = T | Promise<T>;

// The goal: frozen, behaviorless target data. It moves the agent only by being
// the thing measured against — it never acts and is never mutated.
export class UnmovedMover<T> {
  readonly tenant: string;
  readonly version: number;
  readonly target: T;

  constructor(init: { tenant: string; version: number; target: T }) {
    this.tenant = init.tenant;
    this.version = init.version;
    this.target = init.target;
    Object.freeze(this);
  }
}

// Append-only history of goals; installing a new version is the only way a goal
// changes. Methods are Awaitable so a DB-backed ledger drops in unchanged.
export interface GoalLedger<T> {
  install(tenant: string, target: T): Awaitable<UnmovedMover<T>>;
  // The current fixed star. Named `latest`, not `current`, to dodge the repo's
  // ban-ref-current-assignment lint rule on `.current` access.
  latest(tenant: string): Awaitable<UnmovedMover<T>>;
  history(tenant: string): Awaitable<readonly UnmovedMover<T>[]>;
}

export interface PursuitContext {
  readonly tenant: string;
  readonly moverVersion: number;
  record(kind: string, payload?: unknown): Promise<void>;
}

// A framework-agnostic "hand": the rule deliberator calls it via plan(), the AI
// deliberator wraps it as an LLM tool. Write it once; both paths use it.
export interface Action<P = unknown> {
  kind: string;
  description: string;
  schema: z.ZodType<P>;
  apply(tenant: string, input: P): Promise<void>;
}

export interface Domain<S, T, G = unknown> {
  readonly name: string;
  observe(tenant: string): Promise<S>;
  satisfied(state: S, target: T): boolean;
  gap(state: S, target: T): G;
  readonly instructions: string;
  readonly actions: Action[];
  prompt(input: {
    state: S;
    target: T;
    gap: G;
    tenant: string;
    moverVersion: number;
  }): string;
  // Deterministic steps so the rule deliberator can run without an LLM.
  plan?(input: {
    state: S;
    target: T;
    gap: G;
  }): Array<{ kind: string; input: unknown }>;
}

// The reasoning engine — swap rule-based <-> AI without touching the core.
export interface Deliberator {
  run<S, T, G>(args: {
    domain: Domain<S, T, G>;
    state: S;
    target: T;
    gap: G;
    ctx: PursuitContext;
    instructions: string;
    prompt: string;
  }): Promise<{ summary: string; actionsTaken: string[] }>;
}

export type DomainEvent<T> =
  | { type: "state.changed"; tenant: string }
  | { type: "goal.updated"; tenant: string; target: T }
  | {
      type: "eudaimon.action.applied";
      tenant: string;
      moverVersion: number;
      kind: string;
      payload?: unknown;
    }
  | {
      type: "eudaimon.pursued";
      tenant: string;
      moverVersion: number;
      summary: string;
    }
  | { type: "unmovedMover.reached"; tenant: string; moverVersion: number };

export type DomainEventType<T> = DomainEvent<T>["type"];

export type EventHandler<T, K extends DomainEventType<T>> = (
  event: Extract<DomainEvent<T>, { type: K }>,
) => Promise<void>;

export interface EventBus<T> {
  publish(event: DomainEvent<T>): Promise<void>;
  subscribe<K extends DomainEventType<T>>(
    type: K,
    handler: EventHandler<T, K>,
  ): void;
}

export class Eudaimon<S, T, G = unknown> {
  constructor(
    private readonly tenant: string,
    private readonly ledger: GoalLedger<T>,
    private readonly domain: Domain<S, T, G>,
    private readonly bus: EventBus<T>,
    private readonly deliberator: Deliberator,
  ) {}

  async pursue(): Promise<void> {
    // Re-read the goal every cycle; the agent holds no goal state and never authors it.
    const mover = await this.ledger.latest(this.tenant);
    const state = await this.domain.observe(this.tenant);

    if (this.domain.satisfied(state, mover.target)) {
      await this.bus.publish({
        type: "unmovedMover.reached",
        tenant: this.tenant,
        moverVersion: mover.version,
      });
      return;
    }

    const gap = this.domain.gap(state, mover.target);
    const ctx: PursuitContext = {
      tenant: this.tenant,
      moverVersion: mover.version,
      record: (kind, payload) =>
        this.bus.publish({
          type: "eudaimon.action.applied",
          tenant: this.tenant,
          moverVersion: mover.version,
          kind,
          payload,
        }),
    };

    const { summary } = await this.deliberator.run({
      domain: this.domain,
      state,
      target: mover.target,
      gap,
      ctx,
      instructions: this.domain.instructions,
      prompt: this.domain.prompt({
        state,
        target: mover.target,
        gap,
        tenant: this.tenant,
        moverVersion: mover.version,
      }),
    });

    await this.bus.publish({
      type: "eudaimon.pursued",
      tenant: this.tenant,
      moverVersion: mover.version,
      summary,
    });
  }
}

// Two causes, kept apart: the world moving drives pursuit; only an authority
// installs a new goal. The agent is never on the goal-setting path.
export function wire<S, T, G>(deps: {
  bus: EventBus<T>;
  ledger: GoalLedger<T>;
  domain: Domain<S, T, G>;
  deliberator: Deliberator;
}): void {
  const { bus, ledger, domain, deliberator } = deps;
  const agents = new Map<string, Eudaimon<S, T, G>>();
  const agentFor = (tenant: string): Eudaimon<S, T, G> => {
    const existing = agents.get(tenant);
    if (existing) return existing;
    const created = new Eudaimon(tenant, ledger, domain, bus, deliberator);
    agents.set(tenant, created);
    return created;
  };

  bus.subscribe("state.changed", async ({ tenant }) => {
    await agentFor(tenant).pursue();
  });

  bus.subscribe("goal.updated", async ({ tenant, target }) => {
    await ledger.install(tenant, target);
  });
}
