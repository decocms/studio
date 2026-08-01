import { describe, expect, test } from "bun:test";
import { LifecycleManager } from "./manager";

const noopBroadcaster = { emit: () => {} } as unknown as ConstructorParameters<
  typeof LifecycleManager
>[0]["broadcaster"];

function makeManager() {
  const seen: Array<[string, number]> = [];
  const m = new LifecycleManager({
    broadcaster: noopBroadcaster,
    onStartPhase: (status, durationMs) => seen.push([status, durationMs]),
  });
  return { m, seen };
}

describe("LifecycleManager start-phase accounting", () => {
  test("a spawned start is reported only once the probe sees the server", () => {
    const { m, seen } = makeManager();
    m.noteStartAttempt();
    // Spawning proves nothing — nothing may be reported yet.
    m.transition({ phase: "starting" });
    expect(seen).toEqual([]);

    m.transition({ phase: "running", port: 3000, htmlSupport: true });
    expect(seen.map(([status]) => status)).toEqual(["done"]);
    expect(seen[0]![1]).toBeGreaterThanOrEqual(0);
  });

  test("a dev script that dies is reported as failed, not as a healthy start", () => {
    const { m, seen } = makeManager();
    m.noteStartAttempt();
    m.transition({ phase: "start-failed", error: "exit 1" });
    expect(seen.map(([status]) => status)).toEqual(["failed"]);
  });

  test("a skipped start opens no phase", () => {
    const { m, seen } = makeManager();
    m.noteStartAttempt();
    m.cancelStartAttempt();
    m.transition({ phase: "running", port: 3000, htmlSupport: true });
    expect(seen).toEqual([]);
  });

  test("one attempt yields one report, however many times it re-enters running", () => {
    const { m, seen } = makeManager();
    m.noteStartAttempt();
    m.transition({ phase: "running", port: 3000, htmlSupport: true });
    // A crash and recovery is a restart, not a second start phase.
    m.transition({ phase: "crashed" });
    m.transition({ phase: "running", port: 3000, htmlSupport: true });
    expect(seen).toHaveLength(1);
  });

  test("transitions with no attempt open report nothing", () => {
    const { m, seen } = makeManager();
    m.transition({ phase: "running", port: 3000, htmlSupport: true });
    m.transition({ phase: "start-failed", error: "unrelated" });
    expect(seen).toEqual([]);
  });
});
