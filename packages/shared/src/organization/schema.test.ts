import { describe, expect, it } from "bun:test";
import {
  autoResolveConflictsEnabled,
  DEFAULT_ON_FLAGS,
  orgFlagEnabled,
} from "./schema";

describe("orgFlagEnabled", () => {
  it("default-on flags read as enabled unless stored exactly false", () => {
    expect(DEFAULT_ON_FLAGS.has("reviewer_enabled")).toBe(true);
    // unset / null / true → on; only explicit false opts out.
    expect(orgFlagEnabled(null, "reviewer_enabled")).toBe(true);
    expect(orgFlagEnabled(undefined, "reviewer_enabled")).toBe(true);
    expect(orgFlagEnabled({}, "reviewer_enabled")).toBe(true);
    expect(orgFlagEnabled({ reviewer_enabled: null }, "reviewer_enabled")).toBe(
      true,
    );
    expect(orgFlagEnabled({ reviewer_enabled: true }, "reviewer_enabled")).toBe(
      true,
    );
    expect(
      orgFlagEnabled({ reviewer_enabled: false }, "reviewer_enabled"),
    ).toBe(false);
  });

  it("default-off flags read as disabled unless stored exactly true", () => {
    expect(DEFAULT_ON_FLAGS.has("auto_merge")).toBe(false);
    expect(orgFlagEnabled(null, "auto_merge")).toBe(false);
    expect(orgFlagEnabled(undefined, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({}, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: null }, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: false }, "auto_merge")).toBe(false);
    expect(orgFlagEnabled({ auto_merge: true }, "auto_merge")).toBe(true);
  });

  it("auto_resolve_conflicts inherits auto_merge until set explicitly", () => {
    expect(autoResolveConflictsEnabled(null)).toBe(false);
    expect(autoResolveConflictsEnabled({})).toBe(false);
    expect(autoResolveConflictsEnabled({ auto_merge: true })).toBe(true);
    expect(autoResolveConflictsEnabled({ auto_merge: false })).toBe(false);
    // An explicit value wins in BOTH directions — that is the whole split.
    expect(
      autoResolveConflictsEnabled({
        auto_merge: true,
        auto_resolve_conflicts: false,
      }),
    ).toBe(false);
    expect(
      autoResolveConflictsEnabled({
        auto_merge: false,
        auto_resolve_conflicts: true,
      }),
    ).toBe(true);
    // Raw jsonb bypasses zod: a non-boolean is not "explicit".
    expect(
      autoResolveConflictsEnabled({
        auto_merge: true,
        auto_resolve_conflicts: "false",
      }),
    ).toBe(true);
  });

  it("a non-boolean stored value follows the branch's strict comparison", () => {
    // Reads hit raw jsonb, bypassing zod: only a strict boolean flips the gate.
    expect(
      orgFlagEnabled({ reviewer_enabled: "true" }, "reviewer_enabled"),
    ).toBe(true);
    expect(orgFlagEnabled({ auto_merge: "true" }, "auto_merge")).toBe(false);
  });
});
