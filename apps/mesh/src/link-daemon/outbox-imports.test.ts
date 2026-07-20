/**
 * Guard: the durable-outbox core must stay cluster-free so the link daemon
 * bundle (`bunx decocms@latest link`, distributed to users) never drags in cluster
 * code (StudioContext, storage, API routes, @decocms/sandbox). The studio
 * cross-tree guard (src/harnesses/cross-tree-guard.test.ts) covers only the
 * @decocms/harness package tree — NOT src/link-daemon — so this is the
 * dedicated guard for the outbox slice. The outbox may import only:
 *   - bun:sqlite                (the embedded store)
 *   - @decocms/std              (sleep/retry/backoff primitives)
 *   - ../links/protocol[/relay] (wire types: RelayLine, DispatchSSEEvent)
 *   - ./outbox*                 (its own siblings)
 */
import { describe, expect, it } from "bun:test";

const OUTBOX_FILES = ["outbox.ts", "outbox-lane.ts", "outbox-runtime.ts"];

// A reach into any of these is a cluster import the daemon bundle must not carry.
const CLUSTER_IMPORT =
  /from\s+["'](?:@\/|@decocms\/sandbox|(?:\.\.\/)+(?:core|storage|api|auth|encryption|event-bus|observability|web)\/)/;

describe("durable outbox is cluster-free", () => {
  it("no outbox source imports cluster code (StudioContext/storage/api/sandbox)", async () => {
    const root = new URL("./", import.meta.url).pathname;
    const offenders: string[] = [];
    for (const file of OUTBOX_FILES) {
      const src = await Bun.file(root + file).text();
      if (CLUSTER_IMPORT.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
