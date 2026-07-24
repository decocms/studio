import { describe, expect, test } from "bun:test";
import { HOME_LIMIT, nextHomeIdsWithAdd } from "./add-tile-drawer";

describe("nextHomeIdsWithAdd", () => {
  test("appends when under the limit", () => {
    expect(nextHomeIdsWithAdd(["a"], "b")).toEqual(["a", "b"]);
  });

  test("is a no-op when the id is already present", () => {
    expect(nextHomeIdsWithAdd(["a", "b"], "a")).toBeNull();
  });

  test("is a no-op once the live count reaches HOME_LIMIT", () => {
    const ids = Array.from({ length: HOME_LIMIT }, (_, i) => `agent-${i}`);
    expect(nextHomeIdsWithAdd(ids, "new-agent")).toBeNull();
  });

  test("ignores dead (unresolvable) ids when checking capacity", () => {
    const ids = [
      ...Array.from({ length: HOME_LIMIT }, (_, i) => `live-${i}`),
      "dead-1",
      "dead-2",
    ];
    const validIds = new Set(ids.filter((id) => id.startsWith("live-")));
    // Every slot is already taken by a *live* agent, so still blocked...
    expect(nextHomeIdsWithAdd(ids, "new-agent", validIds)).toBeNull();

    // ...but freeing a live slot (simulating a concurrent remove that already
    // landed in the cache) lets the add through even with dead ids present.
    const withRoom = ids.filter((id) => id !== "live-0");
    expect(nextHomeIdsWithAdd(withRoom, "new-agent", validIds)).toEqual([
      ...withRoom,
      "new-agent",
    ]);
  });

  test("two concurrent adds against the same live snapshot both resolve at the limit, but applying them in sequence against fresh ids only lets the first one through", () => {
    const ids = Array.from({ length: HOME_LIMIT - 1 }, (_, i) => `agent-${i}`);
    // Simulates the writer's serialized chain: each call sees the ids left by
    // the previous one, not a stale render-time snapshot.
    const afterFirst = nextHomeIdsWithAdd(ids, "agent-x");
    expect(afterFirst).not.toBeNull();
    const afterSecond = nextHomeIdsWithAdd(afterFirst as string[], "agent-y");
    expect(afterSecond).toBeNull();
  });
});
