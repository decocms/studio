import { describe, expect, it } from "bun:test";
import { computeHandle, hashSandboxId } from "./handle";
import type { SandboxId } from "../types";

const ID: SandboxId = {
  userId: "u_1",
  projectRef: "agent:org:vmcp:deco/mellow-flint",
};

describe("computeHandle", () => {
  it("strips the prefix before the last `/` from the branch slug", () => {
    const handle = computeHandle(ID, "deco/mellow-flint");
    expect(handle).toMatch(/^mellow-flint-[0-9a-f]{5}$/);
  });

  it("strips multi-segment prefixes, keeping only the last segment", () => {
    const handle = computeHandle(ID, "tlgimenes/unified-sandbox-daemon");
    expect(handle).toMatch(/^unified-sandbox-daemon-[0-9a-f]{5}$/);
  });

  it("lowercases and replaces non-alphanumeric chars with `-`", () => {
    const handle = computeHandle(ID, "Foo_Bar.Baz");
    expect(handle).toMatch(/^foo-bar-baz-[0-9a-f]{5}$/);
  });

  it("collapses repeated separators and trims leading/trailing dashes", () => {
    const handle = computeHandle(ID, "feat///___refactor---");
    expect(handle).toMatch(/^refactor-[0-9a-f]{5}$/);
  });

  it("truncates the slug to 24 chars before joining the hash", () => {
    const handle = computeHandle(
      ID,
      "a-very-long-branch-name-that-exceeds-the-limit",
    );
    const match = handle.match(/^([a-z0-9-]+)-([0-9a-f]{5})$/);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(24);
    expect(match![1]!.endsWith("-")).toBe(false);
  });

  it("returns s-<hash> when branch is null (DNS-1035: must start with letter)", () => {
    const handle = computeHandle(ID, null);
    expect(handle).toMatch(/^s-[0-9a-f]{5}$/);
  });

  it("returns s-<hash> when branch is undefined", () => {
    const handle = computeHandle(ID);
    expect(handle).toMatch(/^s-[0-9a-f]{5}$/);
  });

  it("returns s-<hash> when branch is empty string", () => {
    const handle = computeHandle(ID, "");
    expect(handle).toMatch(/^s-[0-9a-f]{5}$/);
  });

  it("returns s-<hash> when branch sanitizes to empty", () => {
    const handle = computeHandle(ID, "///");
    expect(handle).toMatch(/^s-[0-9a-f]{5}$/);
  });

  it("returns s-<hash> when branch is whitespace-only", () => {
    const handle = computeHandle(ID, "   ");
    expect(handle).toMatch(/^s-[0-9a-f]{5}$/);
  });

  it("is deterministic for the same (id, branch) pair", () => {
    const a = computeHandle(ID, "deco/foo");
    const b = computeHandle(ID, "deco/foo");
    expect(a).toBe(b);
  });

  it("uses the SandboxId for the hash, so different ids with the same slug differ", () => {
    const handleA = computeHandle(ID, "deco/foo");
    const handleB = computeHandle(
      { userId: "u_2", projectRef: "agent:org:vmcp:deco/foo" },
      "deco/foo",
    );
    expect(handleA).not.toBe(handleB);
    expect(handleA.split("-").slice(0, -1).join("-")).toBe(
      handleB.split("-").slice(0, -1).join("-"),
    );
  });

  it("hash matches the first 5 chars of hashSandboxId for the same id", () => {
    const handle = computeHandle(ID, "deco/foo");
    const expectedHash = hashSandboxId(ID, 5);
    expect(handle.endsWith(`-${expectedHash}`)).toBe(true);
  });

  it("honors a custom hashLen (used by runners exposing handles publicly)", () => {
    const handle = computeHandle(ID, "deco/mellow-flint", { hashLen: 16 });
    expect(handle).toMatch(/^mellow-flint-[0-9a-f]{16}$/);
    expect(handle.endsWith(`-${hashSandboxId(ID, 16)}`)).toBe(true);
  });

  it("returns s-<hash> of the requested length when branch is empty", () => {
    const handle = computeHandle(ID, null, { hashLen: 16 });
    expect(handle).toMatch(/^s-[0-9a-f]{16}$/);
    expect(handle).toBe(`s-${hashSandboxId(ID, 16)}`);
  });
});
