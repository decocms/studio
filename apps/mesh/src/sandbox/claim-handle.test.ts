import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { computeClaimHandle } from "./claim-handle";

describe("computeClaimHandle", () => {
  const originalRunner = process.env.STUDIO_SANDBOX_RUNNER;

  beforeEach(() => {
    delete process.env.STUDIO_SANDBOX_RUNNER;
  });

  afterEach(() => {
    if (originalRunner === undefined) {
      delete process.env.STUDIO_SANDBOX_RUNNER;
    } else {
      process.env.STUDIO_SANDBOX_RUNNER = originalRunner;
    }
  });

  it("uses hashLen=16 when runner is agent-sandbox", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "agent-sandbox";
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    // computeHandle output: "<slug>-<hash>"; assert the hash segment length.
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(16);
  });

  it("uses hashLen=16 when runner is remote-user", () => {
    // Same brute-force argument as agent-sandbox: the runner's preview URL
    // is a public hostname (`<handle>.deco.host`), so the hash must be long
    // enough to resist guessing at an unrate-limited gateway. This also
    // keeps the cluster's claim-handle lookup in sync with what the
    // remote-user runner stores (see remote-user/runner.ts ensure()).
    process.env.STUDIO_SANDBOX_RUNNER = "remote-user";
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(16);
  });

  it("uses default hashLen=5 for docker", () => {
    process.env.STUDIO_SANDBOX_RUNNER = "docker";
    const h = computeClaimHandle({ userId: "u", projectRef: "p" }, "main");
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(5);
  });
});
