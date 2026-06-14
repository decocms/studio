import type { Awaitable } from "./awaitable";
import { type GoalSource, UnmovedMover } from "./mover";

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
  // Every tenant with at least one installed goal. Lets a host iterate all goals
  // under pursuit — e.g. a safety-net sweep that re-arms a stalled pursuit loop.
  tenants(): Awaitable<string[]>;
}

// Default GoalLedger: append-only, in-memory. Swap for a DB-backed impl of the
// GoalLedger interface (Eudaimon awaits it, so an async backing is fine).
export class InMemoryGoalLedger<T> implements GoalLedger<T> {
  private readonly lineages = new Map<string, UnmovedMover<T>[]>();

  install(
    tenant: string,
    target: T,
    source: GoalSource = "authority",
  ): UnmovedMover<T> {
    const history = this.lineages.get(tenant) ?? [];
    const mover = new UnmovedMover({
      tenant,
      version: history.length + 1,
      target,
      source,
    });
    this.lineages.set(tenant, [...history, mover]);
    return mover;
  }

  latest(tenant: string): UnmovedMover<T> {
    const latest = this.lineages.get(tenant)?.at(-1);
    if (!latest) throw new Error(`no UnmovedMover for tenant ${tenant}`);
    return latest;
  }

  anchor(tenant: string): UnmovedMover<T> {
    const anchor = this.lineages
      .get(tenant)
      ?.filter((m) => m.source === "authority")
      .at(-1);
    if (!anchor)
      throw new Error(`no anchor (authority goal) for tenant ${tenant}`);
    return anchor;
  }

  history(tenant: string): readonly UnmovedMover<T>[] {
    return this.lineages.get(tenant) ?? [];
  }

  tenants(): string[] {
    return [...this.lineages.keys()];
  }
}
