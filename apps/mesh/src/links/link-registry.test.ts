import { beforeEach, describe, expect, it } from "bun:test";
import {
  type InMemoryLinkRegistry,
  createInMemoryLinkRegistry,
} from "./link-registry";

const sample = {
  machineId: "mach-1",
  tunnelUrl: "https://link-1.deco.host",
  linkSecret: "hashed-secret",
  cliVersion: "2.331.2",
  protocolVersion: 1,
  capabilities: ["claude-code" as const],
  createdAt: "2026-05-19T12:00:00.000Z",
};

describe("LinkRegistry (in-memory test impl)", () => {
  let registry: InMemoryLinkRegistry;
  beforeEach(() => {
    registry = createInMemoryLinkRegistry({
      ttlSeconds: 30,
      nowSeconds: () => 1000,
    });
  });

  it("returns null when no entry exists", async () => {
    expect(await registry.get("user-a")).toBeNull();
  });

  it("returns the entry after put", async () => {
    await registry.put("user-a", sample);
    const got = await registry.get("user-a");
    expect(got).toMatchObject(sample);
  });

  it("expires the entry after TTL", async () => {
    await registry.put("user-a", sample);
    registry.advanceNow(31);
    expect(await registry.get("user-a")).toBeNull();
  });

  it("refreshes TTL on put", async () => {
    await registry.put("user-a", sample);
    registry.advanceNow(20);
    await registry.put("user-a", sample); // refresh
    registry.advanceNow(20);
    expect(await registry.get("user-a")).not.toBeNull();
  });

  it("delete removes the entry immediately", async () => {
    await registry.put("user-a", sample);
    await registry.delete("user-a");
    expect(await registry.get("user-a")).toBeNull();
  });
});
