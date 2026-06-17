import type { PodHeartbeat } from "@/nats/pod-heartbeat";

/** Deterministic, partition-free leader: lowest podId among alive pods. */
export function selectLeader(alivePods: Set<string>): string | null {
  let leader: string | null = null;
  for (const p of alivePods) if (leader === null || p < leader) leader = p;
  return leader;
}

export interface ProjectorLeadershipDeps {
  heartbeat: PodHeartbeat;
  podId: string;
  onAcquire: () => void; // start the durable consumer
  onRelease: () => void; // stop it
}

/** Re-evaluates leadership on pod death + on a slow poll (heartbeat may miss a
 *  watch event). Calls onAcquire/onRelease on transitions only. */
export class ProjectorLeadership {
  private isLeader = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private readonly deps: ProjectorLeadershipDeps) {}

  async start(): Promise<void> {
    this.deps.heartbeat.onPodDeath(() => void this.evaluate());
    await this.evaluate();
    this.timer = setInterval(() => void this.evaluate(), 15_000);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.isLeader) {
      this.isLeader = false;
      this.deps.onRelease();
    }
  }
  private async evaluate(): Promise<void> {
    const alive = await this.deps.heartbeat.listAlivePods();
    // A pod that doesn't see itself in the set treats leadership as unknown → don't claim.
    if (!alive.has(this.deps.podId)) return;
    const shouldLead = selectLeader(alive) === this.deps.podId;
    if (shouldLead && !this.isLeader) {
      this.isLeader = true;
      this.deps.onAcquire();
    } else if (!shouldLead && this.isLeader) {
      this.isLeader = false;
      this.deps.onRelease();
    }
  }
}
