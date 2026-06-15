import { describe, expect, test } from "bun:test";
import { DEFAULT_PUBLIC_SETS, resolvePublicSets } from "./public-sets";

describe("resolvePublicSets", () => {
  test("no env → the hardcoded defaults (local studio pulls core OOTB)", () => {
    expect(resolvePublicSets(undefined)).toEqual(DEFAULT_PUBLIC_SETS);
    expect(resolvePublicSets("")).toEqual(DEFAULT_PUBLIC_SETS);
    expect(resolvePublicSets(undefined).some((s) => s.set === "core")).toBe(
      true,
    );
  });

  test("env ADDS a new set without dropping the defaults", () => {
    const out = resolvePublicSets(
      JSON.stringify([
        {
          set: "acme",
          repo: "acme/skills",
          ref: "main",
          paths: [{ from: "." }],
        },
      ]),
    );
    const names = out.map((s) => s.set).sort();
    expect(names).toContain("core");
    expect(names).toContain("acme");
  });

  test("env OVERRIDES a default by set name (env wins)", () => {
    const out = resolvePublicSets(
      JSON.stringify([
        { set: "core", repo: "acme/forked", ref: "v2", paths: [{ from: "x" }] },
      ]),
    );
    const core = out.find((s) => s.set === "core");
    expect(core).toEqual({
      set: "core",
      repo: "acme/forked",
      ref: "v2",
      paths: [{ from: "x" }],
    });
    // Still exactly one `core` (overridden, not duplicated).
    expect(out.filter((s) => s.set === "core")).toHaveLength(1);
  });

  test("malformed env → defaults only, never throws", () => {
    expect(resolvePublicSets("not json")).toEqual(DEFAULT_PUBLIC_SETS);
    expect(resolvePublicSets("{}")).toEqual(DEFAULT_PUBLIC_SETS);
    // Duplicate set names are rejected by the schema → defaults kept.
    expect(
      resolvePublicSets(
        JSON.stringify([
          { set: "dup", repo: "a/b", ref: "m", paths: [{ from: "." }] },
          { set: "dup", repo: "a/c", ref: "m", paths: [{ from: "." }] },
        ]),
      ),
    ).toEqual(DEFAULT_PUBLIC_SETS);
  });
});
