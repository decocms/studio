import { describe, expect, it } from "bun:test";
import { TenantConfigStore } from "./store";

describe("TenantConfigStore.apply (env accumulation)", () => {
  it("sequential env upserts accumulate instead of replacing", async () => {
    const store = new TenantConfigStore();

    const first = await store.apply({ env: { FOO: "1" } });
    expect(first.kind).toBe("applied");

    const second = await store.apply({ env: { BAR: "2" } });
    expect(second.kind).toBe("applied");

    expect(store.read()?.env).toEqual({ FOO: "1", BAR: "2" });
  });

  it("deleting one key preserves the others across applies", async () => {
    const store = new TenantConfigStore();
    await store.apply({ env: { FOO: "1", BAR: "2", BAZ: "3" } });

    const result = await store.apply({ env: { BAR: null } });
    expect(result.kind).toBe("applied");

    expect(store.read()?.env).toEqual({ FOO: "1", BAZ: "3" });
  });

  it("deleting the last key clears env entirely", async () => {
    const store = new TenantConfigStore();
    await store.apply({ env: { FOO: "1" } });

    const result = await store.apply({ env: { FOO: null } });
    expect(result.kind).toBe("applied");

    expect(store.read()?.env).toBeUndefined();
  });

  it("deleting non-existent key is a no-op (still applied, no leakage)", async () => {
    const store = new TenantConfigStore();
    await store.apply({ env: { FOO: "1" } });

    const result = await store.apply({ env: { MISSING: null } });
    expect(result.kind).toBe("applied");

    expect(store.read()?.env).toEqual({ FOO: "1" });
  });
});
