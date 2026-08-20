import { describe, expect, it } from "bun:test";
import { DEFAULT_ON_FLAGS, flagsForRepo, orgFlagEnabled } from "./schema";

describe("orgFlagEnabled", () => {
  it("default-on flags read as enabled unless stored exactly false", () => {
    expect(DEFAULT_ON_FLAGS.has("qa_agent_enabled")).toBe(true);
    // unset / null / true → on; only explicit false opts out.
    expect(orgFlagEnabled(null, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled(undefined, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled({}, "qa_agent_enabled")).toBe(true);
    expect(orgFlagEnabled({ qa_agent_enabled: null }, "qa_agent_enabled")).toBe(
      true,
    );
    expect(orgFlagEnabled({ qa_agent_enabled: true }, "qa_agent_enabled")).toBe(
      true,
    );
    expect(
      orgFlagEnabled({ qa_agent_enabled: false }, "qa_agent_enabled"),
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

  it("a non-boolean stored value follows the branch's strict comparison", () => {
    // Reads hit raw jsonb, bypassing zod: only a strict boolean flips the gate.
    expect(
      orgFlagEnabled({ qa_agent_enabled: "true" }, "qa_agent_enabled"),
    ).toBe(true);
    expect(orgFlagEnabled({ auto_merge: "true" }, "auto_merge")).toBe(false);
  });
});

describe("flagsForRepo", () => {
  const settings = {
    flags: { auto_merge: true, qa_agent_enabled: false, nav_v2: true },
    repo_flags: {
      "decocms/studio": { auto_merge: false, qa_agent_enabled: true },
    },
  };

  it("layers a repo's overrides over the org flags", () => {
    const flags = flagsForRepo(settings, "decocms/studio");
    expect(orgFlagEnabled(flags, "auto_merge")).toBe(false);
    expect(orgFlagEnabled(flags, "qa_agent_enabled")).toBe(true);
    // Not overridden → the org value (default-on, never stored false).
    expect(orgFlagEnabled(flags, "code_reviewer_enabled")).toBe(true);
    // Untouched org-only flags survive the merge.
    expect(flags.nav_v2).toBe(true);
  });

  it("a repo with no entry — and an org-wide task — reads the org flags", () => {
    expect(flagsForRepo(settings, "decocms/other")).toEqual(settings.flags);
    expect(flagsForRepo(settings, null)).toEqual(settings.flags);
    expect(flagsForRepo(settings, "  ")).toEqual(settings.flags);
    expect(flagsForRepo(null, "decocms/studio")).toEqual({});
  });

  it("matches the repo key case-insensitively", () => {
    expect(flagsForRepo(settings, "DecoCMS/Studio").auto_merge).toBe(false);
  });

  it("only booleans override: a null override inherits the org value", () => {
    const withNull = {
      flags: { auto_merge: true },
      repo_flags: { "decocms/studio": { auto_merge: null } },
    };
    expect(flagsForRepo(withNull, "decocms/studio").auto_merge).toBe(true);
  });

  it("ignores keys outside the overridable set", () => {
    const rogue = {
      flags: { nav_v2: true },
      repo_flags: { "decocms/studio": { nav_v2: false } },
    };
    expect(flagsForRepo(rogue, "decocms/studio").nav_v2).toBe(true);
  });
});
