import { describe, expect, it } from "bun:test";
import { computeClaimHandle } from "./claim-handle";

describe("computeClaimHandle", () => {
  it("uses hashLen=16 regardless of the configured runner", () => {
    // Both live runner kinds (cluster, user-desktop) expose preview URLs as
    // public hostnames, so the handle hash must be long enough to resist
    // guessing at an unrate-limited gateway. The hashLen no longer varies by
    // kind, so the handle is env-agnostic.
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    // computeHandle output: "<slug>-<hash>"; assert the hash segment length.
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(16);
  });
});
