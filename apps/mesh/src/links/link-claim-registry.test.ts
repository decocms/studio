import { describe, expect, test } from "bun:test";
import {
  createInMemoryLinkClaimRegistry,
  type LinkClaim,
} from "./link-claim-registry";

const sampleClaim: LinkClaim = {
  podId: "pod-A",
  machineId: "m-1",
  hostname: "laptop",
  cliVersion: "1.0.0",
  previewPort: 5174,
  connectedAt: 1_700_000_000_000,
};

describe("link-claim-registry (in-memory)", () => {
  test("returns null when no claim", async () => {
    const r = createInMemoryLinkClaimRegistry();
    expect(await r.get("user-1")).toBeNull();
  });

  test("put then get round-trips the claim", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    expect(await r.get("user-1")).toEqual(sampleClaim);
  });

  test("put overwrites prior claim (last-write-wins)", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    const next = { ...sampleClaim, podId: "pod-B" };
    await r.put("user-1", next);
    expect(await r.get("user-1")).toEqual(next);
  });

  test("delete removes the claim", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    await r.delete("user-1");
    expect(await r.get("user-1")).toBeNull();
  });

  test("watch emits initial value then updates and deletes", async () => {
    const r = createInMemoryLinkClaimRegistry();
    await r.put("user-1", sampleClaim);
    const events: Array<LinkClaim | null> = [];
    const stop = r.watch("user-1", (claim) => events.push(claim));

    // Initial value.
    expect(events).toEqual([sampleClaim]);

    const next = { ...sampleClaim, podId: "pod-B" };
    await r.put("user-1", next);
    expect(events[events.length - 1]).toEqual(next);

    await r.delete("user-1");
    expect(events[events.length - 1]).toBeNull();

    stop();
  });

  test("watch stops emitting after stop()", async () => {
    const r = createInMemoryLinkClaimRegistry();
    const events: Array<LinkClaim | null> = [];
    const stop = r.watch("user-1", (c) => events.push(c));
    stop();
    await r.put("user-1", sampleClaim);
    expect(events).toEqual([null]); // only the initial null
  });
});
