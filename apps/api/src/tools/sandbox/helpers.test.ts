import { describe, it, expect } from "bun:test";
import { readValidatedRuntimeEnv, resolveRuntimeConfig } from "./helpers";
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

  it("treats a non-numeric, empty, or out-of-range port as unset", () => {
    for (const port of ["", "abc", "0", "3.14", "70000", "-1", " 3000"]) {
      const metadata: VmMetadata = { runtime: { selected: "npm", port } };
      expect(resolveRuntimeConfig(metadata).port).toBeNull();
    }
  });

  it("keeps a valid decimal port string in 1-65535", () => {
    const metadata: VmMetadata = {
      runtime: { selected: "npm", port: "65535" },
    };
    expect(resolveRuntimeConfig(metadata).port).toBe("65535");
  });
});

describe("readValidatedRuntimeEnv", () => {
  it("returns null when metadata / runtime / array is absent", () => {
    expect(readValidatedRuntimeEnv(null)).toBeNull();
    expect(readValidatedRuntimeEnv({})).toBeNull();
    expect(readValidatedRuntimeEnv({ runtime: {} })).toBeNull();
    expect(readValidatedRuntimeEnv({ runtime: { env: "nope" } })).toBeNull();
  });

  // Feeds SANDBOX_START's secret-resolving loop; a malformed row must be dropped here, not thrown there.
  it("drops malformed entries instead of letting them through", () => {
    const result = readValidatedRuntimeEnv({
      runtime: {
        env: [
          { key: "FOO", kind: "literal", value: "bar" },
          { key: "bad key", kind: "literal", value: "x" }, // invalid key
          { key: "NO_VALUE", kind: "literal" }, // missing value
          { key: "NO_SECRET", kind: "secret" }, // missing secretId
          { key: "EMPTY_SECRET", kind: "secret", secretId: "" },
          { kind: "literal", value: "no-key" }, // missing key
          "garbage",
          null,
          { key: "SECRET_KEY", kind: "secret", secretId: "sec_1" },
        ],
      },
    });
    expect(result).toEqual([
      { key: "FOO", kind: "literal", value: "bar" },
      { key: "SECRET_KEY", kind: "secret", secretId: "sec_1" },
    ]);
  });

  it("returns null when every entry is invalid", () => {
    expect(
      readValidatedRuntimeEnv({
        runtime: { env: [{ key: "bad key", kind: "literal", value: "x" }] },
      }),
    ).toBeNull();
  });
});
