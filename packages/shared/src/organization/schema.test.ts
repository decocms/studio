import { describe, expect, it } from "bun:test";
import {
  autoResolveConflictsEnabled,
  DEFAULT_ON_FLAGS,
  ModelSlotSchema,
  orgFlagEnabled,
  SubmoduleCredentialSchema,
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

  it("sandbox-only chats are on unless an org turned them off", () => {
    expect(orgFlagEnabled({}, "chat_harness_sandbox_only")).toBe(true);
    expect(
      orgFlagEnabled(
        { chat_harness_sandbox_only: false },
        "chat_harness_sandbox_only",
      ),
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

describe("ModelSlotSchema", () => {
  it("accepts a normal model slot", () => {
    expect(
      ModelSlotSchema.safeParse({
        keyId: "key_1",
        modelId: "claude-sonnet-5",
        title: "Sonnet 5",
      }).success,
    ).toBe(true);
  });

  it("rejects an oversized keyId, modelId, or title", () => {
    // Regression: #6961 capped every sibling free-text field but left these three unbounded.
    const longString = "x".repeat(501);
    expect(
      ModelSlotSchema.safeParse({ keyId: longString, modelId: "m" }).success,
    ).toBe(false);
    expect(
      ModelSlotSchema.safeParse({ keyId: "k", modelId: longString }).success,
    ).toBe(false);
    expect(
      ModelSlotSchema.safeParse({
        keyId: "k",
        modelId: "m",
        title: longString,
      }).success,
    ).toBe(false);
  });
});

describe("SubmoduleCredentialSchema", () => {
  it("accepts a normal host/secretId pair", () => {
    expect(
      SubmoduleCredentialSchema.safeParse({
        host: "github.com",
        secretId: "sec_1",
      }).success,
    ).toBe(true);
  });

  it("rejects an oversized host or secretId", () => {
    // Regression: these two were left unbounded, unlike every sibling settings string field.
    const longString = "x".repeat(501);
    expect(
      SubmoduleCredentialSchema.safeParse({
        host: longString.replace(/x/g, "a"),
        secretId: "sec_1",
      }).success,
    ).toBe(false);
    expect(
      SubmoduleCredentialSchema.safeParse({
        host: "github.com",
        secretId: longString,
      }).success,
    ).toBe(false);
  });
});
