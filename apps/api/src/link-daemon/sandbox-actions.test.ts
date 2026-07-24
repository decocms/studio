import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { openLinkSandboxRegistry } from "../cli/link-sandbox-registry";
import { createSandboxActions } from "./sandbox-actions";

function fakeProvider(opts: { hasHandleAfterDelete: boolean }) {
  const calls: string[] = [];
  return {
    calls,
    deleteSandbox: async (handle: string) => {
      calls.push(handle);
    },
    hasHandle: (_handle: string) => opts.hasHandleAfterDelete,
  };
}

function memRegistryWithRow(handle: string, sandboxPath: string) {
  const reg = openLinkSandboxRegistry({ path: ":memory:" });
  reg.upsert({ handle, status: "stopped", sandboxPath });
  return reg;
}

describe("createSandboxActions.removeSandbox", () => {
  it("stops, purges, and drops the row on success", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: false });
    const reg = memRegistryWithRow("h1", "/data/sandboxes/h1");
    const purged: string[] = [];

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: (p) => {
        purged.push(p);
      },
    });

    const res = await actions.removeSandbox("h1");

    expect(res).toEqual({ ok: true });
    expect(provider.calls).toEqual(["h1"]);
    expect(purged).toEqual(["/data/sandboxes/h1"]);
    expect(reg.list()).toEqual([]);
  });

  it("refuses (no purge, row kept) when a run is still in flight", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: true });
    const reg = memRegistryWithRow("h1", "/data/sandboxes/h1");
    const purged: string[] = [];

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: (p) => {
        purged.push(p);
      },
    });

    const res = await actions.removeSandbox("h1");

    expect(res).toEqual({ ok: false, error: "Can't delete — run in progress" });
    expect(purged).toEqual([]);
    expect(reg.list().map((r) => r.handle)).toEqual(["h1"]);
  });

  it("retries once when the first purge fails transiently, then succeeds", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: false });
    const reg = memRegistryWithRow("h1", "/data/sandboxes/h1");
    let attempts = 0;

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: () => {
        attempts++;
        if (attempts === 1) throw new Error("resource busy");
      },
    });

    const res = await actions.removeSandbox("h1");

    expect(res).toEqual({ ok: true });
    expect(attempts).toBe(2);
    expect(reg.list()).toEqual([]);
  });

  it("bails with the last error after two failed attempts", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: false });
    const reg = memRegistryWithRow("h1", "/data/sandboxes/h1");
    let attempts = 0;

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: () => {
        attempts++;
        throw new Error("still busy");
      },
    });

    const res = await actions.removeSandbox("h1");

    expect(res).toEqual({ ok: false, error: "still busy" });
    expect(attempts).toBe(2);
    expect(reg.list().map((r) => r.handle)).toEqual(["h1"]);
  });

  it("falls back to the computed path when there is no registry row", async () => {
    const provider = fakeProvider({ hasHandleAfterDelete: false });
    const reg = openLinkSandboxRegistry({ path: ":memory:" });
    const purged: string[] = [];

    const actions = createSandboxActions({
      provider,
      registry: reg,
      dataDir: "/data",
      purge: (p) => {
        purged.push(p);
      },
    });

    const res = await actions.removeSandbox("ghost");

    expect(res).toEqual({ ok: true });
    expect(purged).toEqual([join("/data", "sandboxes", "ghost")]);
  });
});
