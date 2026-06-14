import type { Awaitable } from "./awaitable";
import type { Deliberator } from "./deliberator";
import type { Domain, PursuitContext } from "./domain";
import type { EventBus } from "./events";
import type { GoalLedger } from "./ledger";

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

// What a single pursue() cycle did. The kernel REPORTS — it never publishes. A
// host reads this and decides what to persist, notify, or schedule next; the
// in-memory `wire()` runtime turns it into bus events for the demo path.
export interface PursuitAction {
  kind: string;
  payload?: unknown;
}
export interface VetoedAction extends PursuitAction {
  reason: string;
}
// A subordinate goal the proposer authored this cycle: installed (engine version)
// or rejected by approveGoal. Absent when no proposer ran or it returned null.
export type GoalProposal<T> =
  | { target: T; version: number; installed: true }
  | { target: T; installed: false };

export interface PursuitOutcome<T, G = unknown> {
  moverVersion: number;
  satisfied: boolean;
  // Only set when the goal was not yet satisfied (a cycle deliberated).
  gap?: G;
  summary?: string;
  // The agent's advisory pause before the next cycle, if it decided one. The host
  // owns cadence — honor it, clamp it, or ignore it.
  nextReviewMs?: number;
  applied: PursuitAction[];
  vetoed: VetoedAction[];
  // "user"-audience actions the agent recommends but cannot perform itself.
  suggested: PursuitAction[];
  proposal?: GoalProposal<T>;
}

export interface EudaimonDeps<S, T, G = unknown> {
  tenant: string;
  ledger: GoalLedger<T>;
  domain: Domain<S, T, G>;
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
  private readonly deliberator: Deliberator;
  private readonly proposer?: GoalProposer<S, T>;
  private readonly approveGoal?: ApproveGoal<T>;

  constructor(deps: EudaimonDeps<S, T, G>) {
    this.tenant = deps.tenant;
    this.ledger = deps.ledger;
    this.domain = deps.domain;
    this.deliberator = deps.deliberator;
    this.proposer = deps.proposer;
    this.approveGoal = deps.approveGoal;
  }

  async pursue(): Promise<PursuitOutcome<T, G>> {
    // Re-read the goal every cycle; the agent holds no goal state.
    const mover = await this.ledger.latest(this.tenant);
    const state = await this.domain.observe(this.tenant);
    const satisfied = this.domain.satisfied(state, mover.target);

    const applied: PursuitAction[] = [];
    const vetoed: VetoedAction[] = [];
    const suggested: PursuitAction[] = [];
    let gap: G | undefined;
    let summary: string | undefined;
    let nextReviewMs: number | undefined;

    if (!satisfied) {
      gap = this.domain.gap(state, mover.target);
      const ctx: PursuitContext = {
        tenant: this.tenant,
        moverVersion: mover.version,
        record: async (kind, payload) => {
          applied.push({ kind, payload });
        },
        vetoed: async (kind, reason, payload) => {
          vetoed.push({ kind, reason, payload });
        },
        suggest: async (kind, payload) => {
          suggested.push({ kind, payload });
        },
      };

      const result = await this.deliberator.run({
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
      summary = result.summary;
      nextReviewMs = result.nextReviewMs;
    }

    const proposal = await this.maybeProposeNextGoal(
      state,
      mover.target,
      satisfied,
    );

    return {
      moverVersion: mover.version,
      satisfied,
      gap,
      summary,
      nextReviewMs,
      applied,
      vetoed,
      suggested,
      proposal,
    };
  }

  // The engine may set the next subordinate goal, but the anchor is authority-only
  // and append-only — the agent can never overwrite the fixed parent telos.
  private async maybeProposeNextGoal(
    state: S,
    current: T,
    satisfied: boolean,
  ): Promise<GoalProposal<T> | undefined> {
    if (!this.proposer) return undefined;

    const anchor = await this.ledger.anchor(this.tenant);
    const proposed = await this.proposer.propose({
      state,
      current,
      anchor: anchor.target,
      satisfied,
    });
    if (proposed === null) return undefined;

    const approved = this.approveGoal
      ? await this.approveGoal(proposed, { tenant: this.tenant })
      : true;
    if (!approved) return { target: proposed, installed: false };

    const installed = await this.ledger.install(
      this.tenant,
      proposed,
      "engine",
    );
    return { target: proposed, version: installed.version, installed: true };
  }
}

// Two causes, kept apart: the world moving drives pursuit; only an authority
// installs the anchor goal. The agent is never on the anchor-setting path (it
// may, if a proposer is wired, author subordinate goals beneath that anchor).
//
// This is the SINGLE-PROCESS runtime: it keeps one Eudaimon per tenant in memory
// and republishes each cycle's outcome to the in-memory bus. Durable hosts skip
// it — they drive `Eudaimon.pursue()` themselves and read the returned outcome.
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
      deliberator,
      proposer,
      approveGoal,
    });
    agents.set(tenant, created);
    return created;
  };

  bus.subscribe("state.changed", async ({ tenant }) => {
    const outcome = await agentFor(tenant).pursue();
    await publishOutcome(bus, tenant, outcome);
  });

  bus.subscribe("goal.updated", async ({ tenant, target }) => {
    await ledger.install(tenant, target);
  });
}

// Fan a pursue() outcome out onto the bus — the bridge from the report-only kernel
// to the event-driven single-process runtime.
async function publishOutcome<T, G>(
  bus: EventBus<T>,
  tenant: string,
  outcome: PursuitOutcome<T, G>,
): Promise<void> {
  const { moverVersion } = outcome;
  for (const a of outcome.applied)
    await bus.publish({
      type: "eudaimon.action.applied",
      tenant,
      moverVersion,
      kind: a.kind,
      payload: a.payload,
    });
  for (const v of outcome.vetoed)
    await bus.publish({
      type: "eudaimon.action.vetoed",
      tenant,
      moverVersion,
      kind: v.kind,
      reason: v.reason,
      payload: v.payload,
    });
  for (const s of outcome.suggested)
    await bus.publish({
      type: "eudaimon.action.suggested",
      tenant,
      moverVersion,
      kind: s.kind,
      payload: s.payload,
    });

  if (outcome.satisfied) {
    await bus.publish({ type: "unmovedMover.reached", tenant, moverVersion });
  } else {
    await bus.publish({
      type: "eudaimon.pursued",
      tenant,
      moverVersion,
      summary: outcome.summary ?? "",
      nextReviewMs: outcome.nextReviewMs,
    });
  }

  if (outcome.proposal?.installed) {
    await bus.publish({
      type: "eudaimon.goal.proposed",
      tenant,
      moverVersion: outcome.proposal.version,
      target: outcome.proposal.target,
    });
  } else if (outcome.proposal) {
    await bus.publish({
      type: "eudaimon.goal.rejected",
      tenant,
      target: outcome.proposal.target,
    });
  }
}
