import { afterEach, describe, expect, it } from "bun:test";
import { agentSandboxEnabled, getSettings, setGlobalSettings } from "./index";

describe("getSettings auto-init database URL fallback", () => {
  it("falls back to the local default when DATABASE_URL is set but empty", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "";
    try {
      const { getSettings } = await import("./index");
      expect(getSettings().databaseUrl).toBe(
        "postgresql://postgres:postgres@localhost:5432/postgres",
      );
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});

/**
 * The availability the task-board harness selection must honor before picking
 * `claude-code` (#6502) — the same predicate `/api/config` reports as
 * `runtime.agentSandbox`.
 */
describe("agentSandboxEnabled", () => {
  const originalSettings = getSettings();
  afterEach(() => setGlobalSettings(originalSettings));

  it("is true when the hosted sandbox is enabled outside local mode", () => {
    setGlobalSettings({
      ...originalSettings,
      localMode: false,
      agentSandboxEnabled: true,
    });
    expect(agentSandboxEnabled()).toBe(true);
  });

  it("is false when the hosted sandbox is disabled (the default)", () => {
    setGlobalSettings({
      ...originalSettings,
      localMode: false,
      agentSandboxEnabled: false,
    });
    expect(agentSandboxEnabled()).toBe(false);
  });

  it("is false in local mode even when the hosted sandbox is enabled", () => {
    setGlobalSettings({
      ...originalSettings,
      localMode: true,
      agentSandboxEnabled: true,
    });
    expect(agentSandboxEnabled()).toBe(false);
  });
});
