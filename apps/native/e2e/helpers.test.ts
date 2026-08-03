/**
 * Unit tier (pure logic, no spawn/network) for `helpers.ts`'s env-resolution
 * function. Mirrors the daemon's own "swappable spawn target" coverage in
 * `packages/sandbox/daemon-e2e/daemon.e2e.test.ts` for `resolveDaemonCmd` — same
 * JSON-array-or-whitespace-split contract, applied to `LOCAL_API_E2E_CMD`.
 * Always runs (not gated by `describeLocalApi`/`LOCAL_API_E2E_CMD`): this
 * tests the resolver itself, not a running binary.
 */
import { describe, expect, it } from "bun:test";

import { resolveEmbeddedLocalApiCmd, resolveLocalApiCmd } from "./helpers";

describe("resolveLocalApiCmd", () => {
  it("returns null when unset", () => {
    expect(resolveLocalApiCmd(undefined)).toBeNull();
  });

  it("returns null for an empty/whitespace-only string", () => {
    expect(resolveLocalApiCmd("")).toBeNull();
    expect(resolveLocalApiCmd("   ")).toBeNull();
  });

  it("parses a JSON-array command verbatim (required when args contain spaces)", () => {
    expect(
      resolveLocalApiCmd('["/abs/path with spaces/local-api", "--flag"]'),
    ).toEqual(["/abs/path with spaces/local-api", "--flag"]);
  });

  it("falls back to whitespace-split for a plain string", () => {
    expect(resolveLocalApiCmd("/abs/local-api --flag value")).toEqual([
      "/abs/local-api",
      "--flag",
      "value",
    ]);
  });

  it("treats a non-string-array JSON value as a plain string to split", () => {
    // `[1,2,3]` parses as JSON but fails the "every element is a string"
    // check, so it falls through to whitespace-splitting the raw text —
    // same behavior as resolveDaemonCmd.
    expect(resolveLocalApiCmd("[1,2,3]")).toEqual(["[1,2,3]"]);
  });

  it("an explicit empty JSON array falls back to whitespace-splitting the raw text", () => {
    // `[]` parses as JSON and IS a string[] (vacuously — `.every()` on an
    // empty array is true), so the inner `parsed.length === 0` guard throws
    // — but that throw lands inside the surrounding try/catch and is
    // swallowed by the "not JSON" fallback, same as `resolveDaemonCmd` in
    // `daemon.e2e.helpers.ts`. Documenting the actual (mirrored) behavior
    // here rather than the guard's apparent intent.
    expect(resolveLocalApiCmd("[]")).toEqual(["[]"]);
  });
});

describe("resolveEmbeddedLocalApiCmd", () => {
  it("is independent from the normal local-api command", () => {
    expect(resolveEmbeddedLocalApiCmd(undefined)).toBeNull();
    expect(
      resolveEmbeddedLocalApiCmd(
        '["/abs/local-api-e2e-embedded", "--embedded"]',
      ),
    ).toEqual(["/abs/local-api-e2e-embedded", "--embedded"]);
  });
});
