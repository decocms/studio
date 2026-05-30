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

  describe("env", () => {
    it("upserts keys without touching siblings", () => {
      const merged = deepMerge(
        { env: { FOO: "1", BAR: "2" } },
        { env: { FOO: "x" } },
      );
      expect(merged.env).toEqual({ FOO: "x", BAR: "2" });
    });

    it("deletes a key when its value is null", () => {
      const merged = deepMerge(
        { env: { FOO: "1", BAR: "2" } },
        { env: { FOO: null } },
      );
      expect(merged.env).toEqual({ BAR: "2" });
    });

    it("collapses to undefined when all keys are deleted", () => {
      const merged = deepMerge({ env: { FOO: "1" } }, { env: { FOO: null } });
      expect(merged.env).toBeUndefined();
    });

    it("preserves env when patch omits it", () => {
      const merged = deepMerge(
        { env: { FOO: "1" } },
        { application: { runtime: "node" } },
      );
      expect(merged.env).toEqual({ FOO: "1" });
    });
  });
});
