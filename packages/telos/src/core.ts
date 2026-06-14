// Domain-agnostic core. Depends only on zod — never the AI SDK, so the offline
// path stays dependency-light (the LLM deliberator lives in ./deliberate-ai).

import type { z } from "zod";

export type Awaitable<T> = T | Promise<T>;

// Where a goal version came from. The anchor (authority) is the fixed parent
// telos; engine versions are subordinate goals the agent proposed in service of it.
export type GoalSource = "authority" | "engine";

// The goal: frozen, behaviorless target data. It moves the agent only by being
// the thing measured against — it never acts and is never mutated.
export class UnmovedMover<T> {
  readonly tenant: string;
  readonly version: number;
  readonly target: T;
  readonly source: GoalSource;

  constructor(init: {
    tenant: string;
    version: number;
    target: T;
    source?: GoalSource;
  }) {
    this.tenant = init.tenant;
    this.version = init.version;
    this.target = init.target;
    this.source = init.source ?? "authority";
    Object.freeze(this);
  }
}

// Append-only history of goals; installing a new version is the only way a goal
// changes. Methods are Awaitable so a DB-backed ledger drops in unchanged.
export interface GoalLedger<T> {
  install(
    tenant: string,
    target: T,
    source?: GoalSource,
  ): Awaitable<UnmovedMover<T>>;
  // The current working goal (latest of any source). What the agent pursues.
  // Named `latest`, not `current`, to dodge the repo's .current lint rule.
  latest(tenant: string): Awaitable<UnmovedMover<T>>;
  // The fixed parent telos: latest AUTHORITY-installed version. The engine never
  // overwrites it — that immovability is the safety spine of anchored proposing.
  anchor(tenant: string): Awaitable<UnmovedMover<T>>;
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

// Anchored self-direction: after a cycle the engine may author the next
// SUBORDINATE goal — but `anchor` (the fixed parent) is handed in so the proposal
// stays in its service. Return null to leave the goal unchanged.
export interface GoalProposer<S, T> {
  propose(input: {
    state: S;
    current: T;
    anchor: T;
    satisfied: boolean;
  }): Awaitable<T | null>;
}

// Optional gate on engine proposals. Return false to reject; omit to auto-install.
export type ApproveGoal<T> = (
  proposed: T,
  ctx: { tenant: string },
) => Awaitable<boolean>;

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
  | { type: "unmovedMover.reached"; tenant: string; moverVersion: number }
  | {
      type: "eudaimon.goal.proposed";
      tenant: string;
      moverVersion: number;
      target: T;
    }
  | { type: "eudaimon.goal.rejected"; tenant: string; target: T };

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

export interface EudaimonDeps<S, T, G = unknown> {
  tenant: string;
  ledger: GoalLedger<T>;
  domain: Domain<S, T, G>;
  bus: EventBus<T>;
  deliberator: Deliberator;
  // Omit for classic authority-only goals; provide to let the engine author
  // subordinate goals after each cycle (anchored to the authority anchor).
  proposer?: GoalProposer<S, T>;
  approveGoal?: ApproveGoal<T>;
}

export class Eudaimon<S, T, G = unknown> {
  private readonly tenant: string;
  private readonly ledger: GoalLedger<T>;
  private readonly domain: Domain<S, T, G>;
  private readonly bus: EventBus<T>;
  private readonly deliberator: Deliberator;
  private readonly proposer?: GoalProposer<S, T>;
  private readonly approveGoal?: ApproveGoal<T>;

  constructor(deps: EudaimonDeps<S, T, G>) {
    this.tenant = deps.tenant;
    this.ledger = deps.ledger;
    this.domain = deps.domain;
    this.bus = deps.bus;
    this.deliberator = deps.deliberator;
    this.proposer = deps.proposer;
    this.approveGoal = deps.approveGoal;
  }

  async pursue(): Promise<void> {
    // Re-read the goal every cycle; the agent holds no goal state.
    const mover = await this.ledger.latest(this.tenant);
    const state = await this.domain.observe(this.tenant);
    const satisfied = this.domain.satisfied(state, mover.target);

    if (satisfied) {
      await this.bus.publish({
        type: "unmovedMover.reached",
        tenant: this.tenant,
        moverVersion: mover.version,
      });
    } else {
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

    await this.maybeProposeNextGoal(state, mover.target, satisfied);
  }

  // The engine may set the next subordinate goal, but the anchor is authority-only
  // and append-only — the agent can never overwrite the fixed parent telos.
  private async maybeProposeNextGoal(
    state: S,
    current: T,
    satisfied: boolean,
  ): Promise<void> {
    if (!this.proposer) return;

    const anchor = await this.ledger.anchor(this.tenant);
    const proposed = await this.proposer.propose({
      state,
      current,
      anchor: anchor.target,
      satisfied,
    });
    if (proposed === null) return;

    const approved = this.approveGoal
      ? await this.approveGoal(proposed, { tenant: this.tenant })
      : true;
    if (!approved) {
      await this.bus.publish({
        type: "eudaimon.goal.rejected",
        tenant: this.tenant,
        target: proposed,
      });
      return;
    }

    const installed = await this.ledger.install(
      this.tenant,
      proposed,
      "engine",
    );
    await this.bus.publish({
      type: "eudaimon.goal.proposed",
      tenant: this.tenant,
      moverVersion: installed.version,
      target: proposed,
    });
  }
}

// Two causes, kept apart: the world moving drives pursuit; only an authority
// installs the anchor goal. The agent is never on the anchor-setting path (it
// may, if a proposer is wired, author subordinate goals beneath that anchor).
export function wire<S, T, G>(deps: {
  bus: EventBus<T>;
  ledger: GoalLedger<T>;
  domain: Domain<S, T, G>;
  deliberator: Deliberator;
  proposer?: GoalProposer<S, T>;
  approveGoal?: ApproveGoal<T>;
}): void {
  const { bus, ledger, domain, deliberator, proposer, approveGoal } = deps;
  const agents = new Map<string, Eudaimon<S, T, G>>();
  const agentFor = (tenant: string): Eudaimon<S, T, G> => {
    const existing = agents.get(tenant);
    if (existing) return existing;
    const created = new Eudaimon({
      tenant,
      ledger,
      domain,
      bus,
      deliberator,
      proposer,
      approveGoal,
    });
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
