import { describe, expect, it } from "bun:test";
import {
  autoResolveConflictsEnabled,
  BrandContextSchema,
  DEFAULT_ON_FLAGS,
  ModelSlotSchema,
  orgFlagEnabled,
} from "./schema";

function baseBrandContext(overrides: Record<string, unknown> = {}) {
  return {
    id: "brand_1",
    name: "Acme",
    domain: "acme.com",
    overview: "An acme company",
    ...overrides,
  };
}

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

describe("BrandContextSchema JSON field caps", () => {
  it("accepts metadata and images within the caps", () => {
    const result = BrandContextSchema.safeParse(
      baseBrandContext({
        metadata: { tone: "playful" },
        images: [{ url: "https://example.com/a.png" }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an oversized metadata blob", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = BrandContextSchema.safeParse(
      baseBrandContext({ metadata: huge }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects more than 50 images", () => {
    const images = Array(51).fill({ url: "https://example.com/a.png" });
    const result = BrandContextSchema.safeParse(baseBrandContext({ images }));
    expect(result.success).toBe(false);
  });

  it("rejects an oversized images blob within the count cap", () => {
    // Unlike metadata, images had a count cap but no byte cap.
    const images = [{ blob: "x".repeat(300 * 1024) }];
    const result = BrandContextSchema.safeParse(baseBrandContext({ images }));
    expect(result.success).toBe(false);
  });

  it("rejects an oversized overview, name, domain, or logo URL", () => {
    expect(
      BrandContextSchema.safeParse(
        baseBrandContext({ overview: "x".repeat(5001) }),
      ).success,
    ).toBe(false);
    expect(
      BrandContextSchema.safeParse(baseBrandContext({ name: "x".repeat(501) }))
        .success,
    ).toBe(false);
    expect(
      BrandContextSchema.safeParse(
        baseBrandContext({ domain: "x".repeat(501) }),
      ).success,
    ).toBe(false);
    expect(
      BrandContextSchema.safeParse(baseBrandContext({ logo: "x".repeat(501) }))
        .success,
    ).toBe(false);
  });

  it("rejects an oversized font family or color value", () => {
    expect(
      BrandContextSchema.safeParse(
        baseBrandContext({ fonts: { heading: "x".repeat(501) } }),
      ).success,
    ).toBe(false);
    expect(
      BrandContextSchema.safeParse(
        baseBrandContext({ colors: { primary: "x".repeat(501) } }),
      ).success,
    ).toBe(false);
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
