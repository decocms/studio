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
});
