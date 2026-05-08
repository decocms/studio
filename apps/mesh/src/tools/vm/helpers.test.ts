import { describe, it, expect } from "bun:test";
import { resolveRuntimeConfig } from "./helpers";
type VmMetadata = Record<string, unknown>;

describe("resolveRuntimeConfig", () => {
  it("returns null packageManager when no runtime config is set", () => {
    const metadata: VmMetadata = {};
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBeNull();
    expect(result.runtime).toBeNull();
    expect(result.port).toBeNull();
    expect(result.runtimeBinPath).toBeNull();
  });

  it("returns null packageManager when runtime is null", () => {
    const metadata: VmMetadata = { runtime: null };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBeNull();
    expect(result.runtime).toBeNull();
  });

  it("returns null packageManager when selected is null", () => {
    const metadata: VmMetadata = { runtime: { selected: null } };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBeNull();
    expect(result.runtime).toBeNull();
  });

  it("resolves npm", () => {
    const metadata: VmMetadata = {
      runtime: { selected: "npm", port: "4000" },
    };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBe("npm");
    expect(result.runtime).toBe("node");
    expect(result.port).toBe("4000");
    expect(result.runtimeBinPath).toBeNull();
  });

  it("resolves pnpm", () => {
    const metadata: VmMetadata = { runtime: { selected: "pnpm" } };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBe("pnpm");
    expect(result.runtime).toBe("node");
    expect(result.runtimeBinPath).toBeNull();
  });

  it("resolves yarn", () => {
    const metadata: VmMetadata = { runtime: { selected: "yarn" } };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBe("yarn");
    expect(result.runtime).toBe("node");
    expect(result.runtimeBinPath).toBeNull();
  });

  it("resolves bun", () => {
    const metadata: VmMetadata = { runtime: { selected: "bun" } };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBe("bun");
    expect(result.runtime).toBe("bun");
    expect(result.runtimeBinPath).toBe("/opt/bun/bin");
  });

  it("resolves deno", () => {
    const metadata: VmMetadata = {
      runtime: { selected: "deno", port: "8000" },
    };
    const result = resolveRuntimeConfig(metadata);

    expect(result.packageManager).toBe("deno");
    expect(result.runtime).toBe("deno");
    expect(result.port).toBe("8000");
    expect(result.runtimeBinPath).toBe("/opt/deno/bin");
  });

  it("port is null when not explicitly set", () => {
    const metadata: VmMetadata = { runtime: { selected: "npm" } };
    const result = resolveRuntimeConfig(metadata);
    expect(result.port).toBeNull();
  });
});
