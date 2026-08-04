import { describe, expect, it } from "bun:test";
import type { SandboxId } from "../types";
import { computeHandle, hashSandboxId } from "./handle";

const idFor = (projectRef: string, userId = "u_1"): SandboxId => ({
  userId,
  projectRef,
});

const ID = idFor("agent:org:vmcp:deco/mellow-flint");

describe("computeHandle", () => {
  it("strips the prefix before the last `/` from the branch slug", () => {
    expect(computeHandle(ID)).toMatch(/^mellow-flint-[0-9a-f]{16}$/);
  });

  it("strips multi-segment prefixes, keeping only the last segment", () => {
    const handle = computeHandle(
      idFor("agent:org:vmcp:tlgimenes/unified-sandbox-daemon"),
    );
    expect(handle).toMatch(/^unified-sandbox-daemon-[0-9a-f]{16}$/);
  });

  it("lowercases and replaces non-alphanumeric chars with `-`", () => {
    expect(computeHandle(idFor("agent:org:vmcp:Foo_Bar.Baz"))).toMatch(
      /^foo-bar-baz-[0-9a-f]{16}$/,
    );
  });

  it("collapses repeated separators and trims leading/trailing dashes", () => {
    expect(
      computeHandle(idFor("agent:org:vmcp:feat///___refactor---")),
    ).toMatch(/^refactor-[0-9a-f]{16}$/);
  });

  it("truncates the slug to 24 chars before joining the hash", () => {
    const handle = computeHandle(
      idFor("agent:org:vmcp:a-very-long-branch-name-that-exceeds-the-limit"),
    );
    const match = handle.match(/^([a-z0-9-]+)-([0-9a-f]{16})$/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(24);
    expect(match![1]!.endsWith("-")).toBe(false);
  });

  it("slugs a thread ref from its threadId", () => {
    expect(computeHandle(idFor("thread:thr_xyz"))).toMatch(
      /^thr-xyz-[0-9a-f]{16}$/,
    );
  });

  it("keeps the connection id as the slug for a thread-scoped branch", () => {
    // `thread:<threadId>/<connId>` — last `/`-segment wins, and the ":" inside
    // the branch must not be mistaken for a ref delimiter.
    const handle = computeHandle(
      idFor("agent:org:vmcp:thread:thrd_abc/conn_Def456"),
    );
    expect(handle).toMatch(/^conn-def456-[0-9a-f]{16}$/);
  });

  it("returns s-<hash> for a ref in neither encoding (DNS-1035: must start with letter)", () => {
    expect(computeHandle(idFor("legacy-opaque-ref"))).toMatch(
      /^s-[0-9a-f]{16}$/,
    );
  });

  it("returns s-<hash> when the ref's branch sanitizes to empty", () => {
    expect(computeHandle(idFor("agent:org:vmcp:///"))).toMatch(
      /^s-[0-9a-f]{16}$/,
    );
  });

  it("is deterministic for the same id", () => {
    const ref = "agent:org:vmcp:deco/foo";
    expect(computeHandle(idFor(ref))).toBe(computeHandle(idFor(ref)));
  });

  it("hashes the SandboxId, so different users with the same branch differ", () => {
    const ref = "agent:org:vmcp:deco/foo";
    const a = computeHandle(idFor(ref, "u_1"));
    const b = computeHandle(idFor(ref, "u_2"));
    expect(a).not.toBe(b);
    // ...but they share the slug.
    expect(a.split("-").slice(0, -1).join("-")).toBe(
      b.split("-").slice(0, -1).join("-"),
    );
  });

  it("hash is the 16-char hashSandboxId of the id", () => {
    expect(computeHandle(ID).endsWith(`-${hashSandboxId(ID)}`)).toBe(true);
  });

  // The regression this signature exists to prevent. Prod 2026-08-04: the
  // synthetic isolation key and its derived git ref hash identically (same
  // projectRef) but used to slug differently, yielding `conn-rot3ncf1…-<hash>`
  // and `thread-4719cbc0…-<hash>` — two claims, two pods, one logical sandbox,
  // both pushing the same git branch. With the branch argument gone there is no
  // input that can split one ref into two names.
  it("one ref yields exactly one handle", () => {
    const ref = "agent:org:vmcp:thread:4719cbc0-cebb-44ac/conn_RoT3ncf1";
    const handle = computeHandle(idFor(ref));
    expect(computeHandle(idFor(ref))).toBe(handle);
    expect(handle).toContain(hashSandboxId(idFor(ref)));
  });
});
