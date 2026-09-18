import { describe, expect, test } from "bun:test";
import { isAutomationsNotConfiguredError } from "./automations-error";

describe("isAutomationsNotConfiguredError", () => {
  test("matches a missing-relation Postgres error", () => {
    expect(
      isAutomationsNotConfiguredError(
        new Error('relation "workflow_collection" does not exist'),
      ),
    ).toBe(true);
  });

  test("does not match an unrelated 500", () => {
    expect(isAutomationsNotConfiguredError(new Error("Tool failed"))).toBe(
      false,
    );
  });

  test("does not match an auth/permission error", () => {
    expect(isAutomationsNotConfiguredError(new Error("Forbidden"))).toBe(false);
  });

  test("does not match a non-Error value", () => {
    expect(isAutomationsNotConfiguredError("relation does not exist")).toBe(
      false,
    );
    expect(isAutomationsNotConfiguredError(undefined)).toBe(false);
  });
});
