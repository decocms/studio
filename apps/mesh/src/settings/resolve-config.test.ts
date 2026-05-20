import { describe, it, expect } from "bun:test";
import { resolveConfig } from "./resolve-config";
import type { CliFlags } from "./types";

const baseFlags: CliFlags = {
  port: "3000",
  home: "/tmp/test-home",
  localMode: false,
  skipMigrations: false,
};

describe("resolveConfig — pod identity", () => {
  it("uses POD_NAME verbatim when set", () => {
    const { settings } = resolveConfig(baseFlags, {
      NODE_ENV: "production",
      POD_NAME: "mesh-7",
    });
    expect(settings.podName).toBe("mesh-7");
  });

  it("falls back to a random UUID in development", () => {
    const { settings } = resolveConfig(baseFlags, { NODE_ENV: "development" });
    expect(settings.podName).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("falls back to a random UUID when NODE_ENV is unset", () => {
    const { settings } = resolveConfig(baseFlags, {});
    expect(settings.podName).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("refuses to boot in production when POD_NAME is missing", () => {
    // The error message is part of the operator-facing contract: any
    // change here should be intentional (it's how the misconfigured
    // pod tells its operator what to fix). Keeping the assertion on a
    // distinctive substring rather than the full text so wording can
    // evolve without breaking the test.
    expect(() => resolveConfig(baseFlags, { NODE_ENV: "production" })).toThrow(
      /POD_NAME must be set in production/,
    );
  });

  it("refuses to boot in production when POD_NAME is set to empty string", () => {
    expect(() =>
      resolveConfig(baseFlags, { NODE_ENV: "production", POD_NAME: "" }),
    ).toThrow(/POD_NAME must be set in production/);
  });
});
