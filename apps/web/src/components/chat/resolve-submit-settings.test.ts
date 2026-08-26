import { describe, expect, test } from "bun:test";

import { resolveSubmitSettings } from "./resolve-submit-settings";

describe("resolveSubmitSettings", () => {
  const globals = { branch: "feature-x" };

  test("no active thread: carries the branch", () => {
    const out = resolveSubmitSettings({ thread: null, globals });
    expect(out).toEqual({
      branch: "feature-x",
    });
  });

  test("unlocked thread with harness_id null: carries the branch", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: null,
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({
      branch: "feature-x",
    });
  });

  test("locked thread: omits harness and branch (server reads from row)", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "claude-code",
        branch: "main",
      },
      globals,
    });
    expect(out).toEqual({});
  });

  test("locked thread with a null branch: still omits everything", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "decopilot",
        branch: null,
      },
      globals,
    });
    expect(out).toEqual({});
  });

  test("locked thread strips the hosted defaults", () => {
    const out = resolveSubmitSettings({
      thread: {
        harness_id: "codex",
        branch: "main",
      },
      globals: { branch: "different-branch" },
    });
    expect(Object.keys(out)).toEqual([]);
  });

  test("no active thread + no branch: sends the null branch", () => {
    const out = resolveSubmitSettings({
      thread: null,
      globals: { branch: null },
    });
    expect(out).toEqual({
      branch: null,
    });
  });
});
