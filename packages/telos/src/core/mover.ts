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
