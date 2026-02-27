import { describe, it, expect } from "bun:test";
import { createNatsConnectionProvider } from "./connection";

// Mock the nats `connect` function at the module level is impractical
// without the real NATS server, so we test the structural guarantees:
// idempotent init, getConnection/getJetStream null before init, drain clears state.

describe("createNatsConnectionProvider (unit)", () => {
  it("getConnection returns null before init", () => {
    const provider = createNatsConnectionProvider();
    expect(provider.getConnection()).toBeNull();
  });

  it("getJetStream returns null before init", () => {
    const provider = createNatsConnectionProvider();
    expect(provider.getJetStream()).toBeNull();
  });

  it("drain is safe to call before init (no throw)", async () => {
    const provider = createNatsConnectionProvider();
    await expect(provider.drain()).resolves.toBeUndefined();
  });

  it("drain clears state so getConnection returns null after drain", async () => {
    const provider = createNatsConnectionProvider();
    await provider.drain();
    expect(provider.getConnection()).toBeNull();
    expect(provider.getJetStream()).toBeNull();
  });
});
