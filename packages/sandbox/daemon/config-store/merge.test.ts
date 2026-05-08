import { describe, expect, it } from "bun:test";
import type { TenantConfig } from "../types";
import { deepMerge } from "./merge";

describe("deepMerge", () => {
  it("returns patch when current is null", () => {
    const patch: Partial<TenantConfig> = {
      application: {
        packageManager: { name: "npm" },
        runtime: "node",
      },
    };
    const merged = deepMerge(null, patch);
    expect(merged.application?.packageManager?.name).toBe("npm");
  });

  it("preserves fields not in patch", () => {
    const current: TenantConfig = {
      git: { repository: { cloneUrl: "x", branch: "main" } },
      application: {
        packageManager: { name: "npm" },
        runtime: "node",
      },
    };
    const patch: Partial<TenantConfig> = {
      application: {
        packageManager: { name: "pnpm" },
        runtime: "node",
      },
    };
    const merged = deepMerge(current, patch);
    expect(merged.git?.repository?.cloneUrl).toBe("x");
    expect(merged.application?.packageManager?.name).toBe("pnpm");
  });

  it("absent fields don't overwrite existing ones", () => {
    const current: TenantConfig = {
      application: {
        packageManager: { name: "npm" },
        runtime: "node",
        port: 3000,
      },
    };
    const patch: Partial<TenantConfig> = {
      application: {
        packageManager: { name: "pnpm" },
        runtime: "node",
      },
    };
    const merged = deepMerge(current, patch);
    expect(merged.application?.port).toBe(3000);
    expect(merged.application?.packageManager?.name).toBe("pnpm");
  });
});
