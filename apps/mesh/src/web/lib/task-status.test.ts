import { describe, expect, test } from "bun:test";
import { getStatusConfig, STATUS_CONFIG } from "./task-status";

describe("getStatusConfig", () => {
  test("returns the matching config for each known status key", () => {
    for (const key of Object.keys(STATUS_CONFIG) as Array<
      keyof typeof STATUS_CONFIG
    >) {
      expect(getStatusConfig(key)).toBe(STATUS_CONFIG[key]);
    }
  });

  test("defaults to completed when status is undefined", () => {
    expect(getStatusConfig(undefined)).toBe(STATUS_CONFIG.completed);
  });

  test("falls back to the unknown config for an unrecognized status", () => {
    const config = getStatusConfig("bogus_status");
    expect(config.label).toBe("Unknown");
    expect(config).not.toBe(STATUS_CONFIG.completed);
  });

  test("falls back to the unknown config for an empty string", () => {
    expect(getStatusConfig("").label).toBe("Unknown");
  });
});
