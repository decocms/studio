import { type GoalLedger, type GoalSource, UnmovedMover } from "./core";

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
}
