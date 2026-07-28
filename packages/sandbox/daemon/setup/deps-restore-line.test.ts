import { describe, expect, test } from "bun:test";
import { buildDepsRestoreLine } from "./dep-metrics";

/**
 * Both failure modes here are silent. A line over the pipeline's byte cap is
 * dropped whole (that is what the chunked `sandbox.deps` format exists to
 * work around), and a credential leaking through the repo label would ship a
 * git token to the log store without anything erroring.
 */
describe("buildDepsRestoreLine", () => {
  test("emits one small parseable line, credentials stripped", () => {
    const line = buildDepsRestoreLine({
      source: "miss",
      cloneUrl:
        "https://x-access-token:ghs_SECRETVALUE@github.com/acme/site.git",
      durationMs: 42_318.7,
      bootId: "01JB0Z9K2M4N6P8Q",
    });

    // Well inside the ~600-byte budget the sibling format had to chunk for.
    expect(Buffer.byteLength(line)).toBeLessThan(300);
    expect(line).not.toContain("\n");

    const parsed = JSON.parse(line);
    expect(parsed).toEqual({
      msg: "sandbox.deps.restore",
      source: "miss",
      repo_hash: parsed.repo_hash,
      duration_ms: 42_319, // rounded — no float noise in the log store
      bootId: "01JB0Z9K2M4N6P8Q",
    });
    expect(parsed.repo_hash).toMatch(/^[0-9a-f]{16}$/);

    // The token must not survive anywhere in the line, hashed or otherwise.
    expect(line).not.toContain("ghs_SECRETVALUE");
    expect(line).not.toContain("x-access-token");
  });

  test("credentials do not change the repo identity", () => {
    const withCreds = JSON.parse(
      buildDepsRestoreLine({
        source: "l1",
        cloneUrl: "https://user:tok@github.com/acme/site.git",
        durationMs: 900,
        bootId: "b",
      }),
    );
    const without = JSON.parse(
      buildDepsRestoreLine({
        source: "l1",
        cloneUrl: "https://github.com/acme/site.git",
        durationMs: 900,
        bootId: "b",
      }),
    );
    // Otherwise a token rotation would look like a different repo and split
    // the hit rate across two series.
    expect(withCreds.repo_hash).toBe(without.repo_hash);
  });

  test("a repo-less boot still emits a countable line", () => {
    const parsed = JSON.parse(
      buildDepsRestoreLine({
        source: "miss",
        cloneUrl: undefined,
        durationMs: 1,
        bootId: "b",
      }),
    );
    expect(parsed.repo_hash).toBe("unknown");
  });
});
