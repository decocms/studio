import { describe, it, expect } from "bun:test";
import { createNatsConnectionProvider } from "./connection";

describe("createNatsConnectionProvider (unit)", () => {
  it("getConnection throws before init", () => {
    const provider = createNatsConnectionProvider();
    expect(() => provider.getConnection()).toThrow("Not initialized");
  });

  it("getJetStream throws before init", () => {
    const provider = createNatsConnectionProvider();
    expect(() => provider.getJetStream()).toThrow("Not initialized");
  });

  it("drain is safe to call before init (no throw)", async () => {
    const provider = createNatsConnectionProvider();
    await expect(provider.drain()).resolves.toBeUndefined();
  });

  it("drain clears state so getConnection throws after drain", async () => {
    const provider = createNatsConnectionProvider();
    await provider.drain();
    expect(() => provider.getConnection()).toThrow("Not initialized");
    expect(() => provider.getJetStream()).toThrow("Not initialized");
  });
});
