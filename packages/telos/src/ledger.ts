import { type GoalLedger, UnmovedMover } from "./core";

// Default GoalLedger: append-only, in-memory. Swap for a DB-backed impl of the
// GoalLedger interface (Eudaimon awaits it, so an async backing is fine).
export class InMemoryGoalLedger<T> implements GoalLedger<T> {
  private readonly lineages = new Map<string, UnmovedMover<T>[]>();

  install(tenant: string, target: T): UnmovedMover<T> {
    const history = this.lineages.get(tenant) ?? [];
    const mover = new UnmovedMover({
      tenant,
      version: history.length + 1,
      target,
    });
    this.lineages.set(tenant, [...history, mover]);
    return mover;
  }

  latest(tenant: string): UnmovedMover<T> {
    const latest = this.lineages.get(tenant)?.at(-1);
    if (!latest) throw new Error(`no UnmovedMover for tenant ${tenant}`);
    return latest;
  }

  history(tenant: string): readonly UnmovedMover<T>[] {
    return this.lineages.get(tenant) ?? [];
  }
}
