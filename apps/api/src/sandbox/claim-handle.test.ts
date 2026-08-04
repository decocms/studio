import { computeHandle } from "@decocms/sandbox/provider";
import { describe, expect, it } from "bun:test";
import { computeClaimHandle } from "./claim-handle";

describe("computeClaimHandle", () => {
  it("uses hashLen=16 regardless of the configured runner", () => {
    // Preview URLs expose the handle as a public hostname, so the hash must be
    // long enough to resist guessing at an unrate-limited gateway. The hashLen
    // does not vary by runner kind, so the handle is env-agnostic.
    const h = computeClaimHandle({
      userId: "u",
      projectRef: "agent:org:vmcp:main",
    });
    // computeHandle output: "<slug>-<hash>"; assert the hash segment length.
    const hash = h.split("-").pop()!;
    expect(hash.length).toBe(16);
  });

  it("matches what the runner composes for the same id — no branch to disagree on", () => {
    const id = {
      userId: "u",
      projectRef: "agent:org:vmcp:thread:thrd_1/conn_2",
    };
    // The proxy knows the synthetic key; the runner may only know the derived
    // git ref (`sandbox/thread-thrd_1-conn_2`). Neither can influence the
    // handle, so both sides land on the same claim name.
    expect(computeClaimHandle(id)).toBe(computeHandle(id));
  });
});
