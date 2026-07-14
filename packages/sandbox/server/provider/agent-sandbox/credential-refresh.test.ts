import { describe, expect, it } from "bun:test";
import { refreshCredentialsByConnection } from "./credential-refresh";

type Item = { id: string; conn?: string };

// Deterministic scheduler-yield so "concurrent" callbacks actually interleave
// without wall-clock timers.
const tick = () => Promise.resolve();

describe("refreshCredentialsByConnection", () => {
  it("processes items sharing a connection sequentially (no overlap)", async () => {
    const active = new Map<string, number>();
    let maxPerConn = 0;
    const items: Item[] = [
      { id: "a1", conn: "A" },
      { id: "a2", conn: "A" },
      { id: "a3", conn: "A" },
    ];
    await refreshCredentialsByConnection(
      items,
      (i) => i.conn,
      async (i) => {
        const n = (active.get(i.conn!) ?? 0) + 1;
        active.set(i.conn!, n);
        maxPerConn = Math.max(maxPerConn, n);
        await tick();
        await tick();
        active.set(i.conn!, active.get(i.conn!)! - 1);
      },
    );
    // Never two of connection A's items in flight at once.
    expect(maxPerConn).toBe(1);
  });

  it("runs distinct connections in parallel", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items: Item[] = [
      { id: "a", conn: "A" },
      { id: "b", conn: "B" },
      { id: "c", conn: "C" },
    ];
    await refreshCredentialsByConnection(
      items,
      (i) => i.conn,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        inFlight--;
      },
    );
    expect(maxInFlight).toBe(3);
  });

  it("skips items with no connection id", async () => {
    const seen: string[] = [];
    await refreshCredentialsByConnection(
      [{ id: "a", conn: "A" }, { id: "b" }, { id: "c", conn: "C" }] as Item[],
      (i) => i.conn,
      async (i) => {
        seen.push(i.id);
      },
    );
    expect(seen.sort()).toEqual(["a", "c"]);
  });

  it("isolates a failing item — others still run", async () => {
    const done: string[] = [];
    await refreshCredentialsByConnection(
      [
        { id: "a", conn: "A" },
        { id: "b", conn: "B" },
      ] as Item[],
      (i) => i.conn,
      async (i) => {
        if (i.id === "a") throw new Error("boom");
        done.push(i.id);
      },
    );
    expect(done).toEqual(["b"]);
  });
});
