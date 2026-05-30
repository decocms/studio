import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { computeClaimHandle } from "./claim-handle";

describe("computeClaimHandle", () => {
  const originalRunner = process.env.STUDIO_SANDBOX_PROVIDER;

  beforeEach(() => {
    delete process.env.STUDIO_SANDBOX_PROVIDER;
  });

  afterEach(() => {
    if (originalRunner === undefined) {
      delete process.env.STUDIO_SANDBOX_PROVIDER;
    } else {
      process.env.STUDIO_SANDBOX_PROVIDER = originalRunner;
    }
  });

  it("uses hashLen=16 when runner is cluster", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "cluster";
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    // computeHandle output: "<slug>-<hash>"; assert the hash segment length.
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(16);
  });

  it("uses hashLen=16 when runner is user-desktop", () => {
    // Same brute-force argument as cluster: the runner's preview URL
    // is a public hostname (`<handle>.localhost`), so the hash must be long
    // enough to resist guessing at an unrate-limited gateway. This also
    // keeps the cluster's claim-handle lookup in sync with what the
    // user-desktop runner stores (see desktop/runner.ts ensure()).
    process.env.STUDIO_SANDBOX_PROVIDER = "user-desktop";
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(16);
  });

  it("uses default hashLen=5 for local-docker", () => {
    process.env.STUDIO_SANDBOX_PROVIDER = "local-docker";
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(5);
  });
});
