let lastActivityAt = Date.now();
// false until the first successful POST /_decopilot_vm/config. Warm-pool pods
// boot with a sentinel token and sit unclaimed until mesh delivers a workload
// via postConfig; the housekeeper uses this flag to skip such pods so it
// never reaps a pod that was never given a workload.
let claimed = false;

export function bumpActivity(now: number = Date.now()): void {
  lastActivityAt = now;
}

export function markClaimed(): void {
  claimed = true;
}

export function getIdleStatus(now: number = Date.now()): {
  lastActivityAt: string;
  idleMs: number;
  claimed: boolean;
} {
  return {
    lastActivityAt: new Date(lastActivityAt).toISOString(),
    idleMs: Math.max(0, now - lastActivityAt),
    claimed,
  };
}

export function __resetActivityForTests(now: number = Date.now()): void {
  lastActivityAt = now;
  claimed = false;
}
