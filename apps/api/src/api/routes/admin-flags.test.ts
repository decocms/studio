import { describe, expect, it } from "bun:test";
import {
  CustomFlagKeySchema,
  flagsResponse,
  OrgFlagsPatchSchema,
} from "./admin-flags";

describe("flagsResponse", () => {
  it("echoes the stored boolean flags", () => {
    const { flags } = flagsResponse({
      demo_mode: true,
      hosting_enabled: false,
    });
    expect(flags).toEqual({ demo_mode: true, hosting_enabled: false });
  });

  it("returns an empty bag when nothing is stored", () => {
    expect(flagsResponse(null).flags).toEqual({});
  });

  it("echoes a non-boolean stored value instead of dropping it", () => {
    // Dropping it would silently delete it on the next replace.
    const { flags, effective } = flagsResponse({
      demo_mode: true,
      legacy: "yes",
    } as unknown as Parameters<typeof flagsResponse>[0]);
    expect(flags).toEqual({ demo_mode: true, legacy: "yes" });
    expect(effective.legacy).toBe(false);
  });

  it("resolves default-off flags to false when unset", () => {
    const { effective } = flagsResponse(null);
    expect(effective.demo_mode).toBe(false);
    expect(effective.hosting_enabled).toBe(false);
  });

  it("resolves default-on flags to true when unset", () => {
    const { effective } = flagsResponse(null);
    expect(effective.reviewer_enabled).toBe(true);
    expect(effective.cheap_reviewer_model).toBe(true);
  });

  it("honors an explicit false on a default-on flag", () => {
    const { effective } = flagsResponse({ reviewer_enabled: false });
    expect(effective.reviewer_enabled).toBe(false);
  });

  it("honors an explicit true on a default-off flag", () => {
    const { effective } = flagsResponse({ demo_mode: true });
    expect(effective.demo_mode).toBe(true);
  });

  it("includes every schema flag in the effective map", () => {
    const { effective } = flagsResponse(null);
    // A flag added to the schema must surface here without touching this route.
    expect(Object.keys(effective)).toContain("monitor_enabled");
    expect(Object.keys(effective)).toContain("reviewer_enabled");
  });

  it("surfaces a stored custom key not present in the schema", () => {
    // A custom flag resolves as default-off (enabled only when stored true).
    const { effective } = flagsResponse({
      my_custom_flag: true,
    } as Record<string, boolean>);
    expect(effective.my_custom_flag).toBe(true);
    expect(effective.demo_mode).toBe(false);
  });
});

describe("OrgFlagsPatchSchema", () => {
  it("accepts known and custom snake_case keys with boolean values", () => {
    expect(
      OrgFlagsPatchSchema.safeParse({ demo_mode: true, my_custom_flag: false })
        .success,
    ).toBe(true);
  });

  it("accepts an empty object (replace-all-with-nothing)", () => {
    expect(OrgFlagsPatchSchema.safeParse({}).success).toBe(true);
  });

  it("rejects non-boolean values", () => {
    expect(OrgFlagsPatchSchema.safeParse({ demo_mode: "yes" }).success).toBe(
      false,
    );
  });

  it("rejects keys that are not lowercase snake_case", () => {
    expect(CustomFlagKeySchema.safeParse("Bad-Key").success).toBe(false);
    expect(CustomFlagKeySchema.safeParse("has space").success).toBe(false);
    expect(CustomFlagKeySchema.safeParse("1leading").success).toBe(false);
    expect(CustomFlagKeySchema.safeParse("").success).toBe(false);
    expect(CustomFlagKeySchema.safeParse("trailing_").success).toBe(false);
    expect(CustomFlagKeySchema.safeParse("double__underscore").success).toBe(
      false,
    );
    expect(CustomFlagKeySchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(CustomFlagKeySchema.safeParse("valid_key_2").success).toBe(true);
  });
});
