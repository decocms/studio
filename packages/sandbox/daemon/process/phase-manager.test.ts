import { describe, expect, test } from "bun:test";
import { PhaseManager } from "./phase-manager";

describe("PhaseManager", () => {
  test("caps finished phases so a long-lived daemon doesn't leak memory", () => {
    const pm = new PhaseManager();
    for (let i = 0; i < 500; i++) {
      pm.done(pm.begin(`task-${i}`));
    }
    expect(pm.list().length).toBeLessThanOrEqual(200);
  });

  test("keeps running phases regardless of finished count", () => {
    const pm = new PhaseManager();
    const runningId = pm.begin("still-running");
    for (let i = 0; i < 500; i++) {
      pm.done(pm.begin(`task-${i}`));
    }
    expect(pm.list({ status: ["running"] }).map((p) => p.id)).toEqual([
      runningId,
    ]);
  });

  test("recent() still surfaces the newest finished phases after trimming", () => {
    const pm = new PhaseManager();
    for (let i = 0; i < 500; i++) {
      pm.done(pm.begin(`task-${i}`));
    }
    const recent = pm.recent(5);
    expect(recent.map((p) => p.name)).toEqual([
      "task-495",
      "task-496",
      "task-497",
      "task-498",
      "task-499",
    ]);
  });

  test("onFinish reports name, terminal status and a duration per phase", () => {
    const seen: Array<[string, string, number]> = [];
    const pm = new PhaseManager({
      onFinish: (name, status, durationMs) =>
        seen.push([name, status, durationMs]),
    });
    pm.done(pm.begin("clone"));
    pm.fail(pm.begin("install"), "exit 1");
    expect(seen.map(([name, status]) => [name, status])).toEqual([
      ["clone", "done"],
      ["install", "failed"],
    ]);
    expect(seen.every(([, , ms]) => ms >= 0)).toBe(true);
  });

  test("onFinish fires once per phase — a double done must not double-count", () => {
    let calls = 0;
    const pm = new PhaseManager({ onFinish: () => calls++ });
    const id = pm.begin("install");
    pm.done(id);
    pm.done(id);
    pm.fail(id, "too late");
    pm.done("never-existed");
    expect(calls).toBe(1);
  });
});
