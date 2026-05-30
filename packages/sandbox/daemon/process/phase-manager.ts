export type PhaseStatus = "running" | "done" | "failed";

export interface Phase {
  id: string;
  name: string;
  status: PhaseStatus;
  startedAt: number;
  doneAt: number | null;
  error?: string;
}

export interface PhaseManagerDeps {
  onChange?: (phases: Phase[]) => void;
}

/**
 * Lightweight in-memory phase registry. Tracks named setup phases (clone,
 * install, transition) so the LLM and the SSE stream have a structured view
 * of "what is the daemon doing right now."
 *
 * Not persisted — resets on each daemon boot.
 */
export class PhaseManager {
  private readonly all: Phase[] = [];
  private idCounter = 0;
  private readonly deps: PhaseManagerDeps;

  constructor(deps: PhaseManagerDeps = {}) {
    this.deps = deps;
  }

  begin(name: string): string {
    const id = `phase${++this.idCounter}`;
    this.all.push({
      id,
      name,
      status: "running",
      startedAt: Date.now(),
      doneAt: null,
    });
    this.emit();
    return id;
  }

  done(id: string): void {
    const t = this.findRunning(id);
    if (!t) return;
    t.status = "done";
    t.doneAt = Date.now();
    this.emit();
  }

  fail(id: string, error?: string): void {
    const t = this.findRunning(id);
    if (!t) return;
    t.status = "failed";
    t.doneAt = Date.now();
    if (error) t.error = error;
    this.emit();
  }

  list(filter?: { status?: ReadonlyArray<PhaseStatus> }): Phase[] {
    if (!filter?.status) return this.all.slice();
    return this.all.filter((t) => filter.status!.includes(t.status));
  }

  /** Running phases + last `maxFinished` completed/failed phases. */
  recent(maxFinished = 20): Phase[] {
    const running = this.all.filter((t) => t.status === "running");
    const finished = this.all
      .filter((t) => t.status !== "running")
      .slice(-maxFinished);
    return [...running, ...finished];
  }

  private findRunning(id: string): Phase | undefined {
    return this.all.find((t) => t.id === id && t.status === "running");
  }

  private emit(): void {
    this.deps.onChange?.(this.all.slice());
  }
}
