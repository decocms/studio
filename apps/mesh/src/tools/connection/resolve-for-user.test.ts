/**
 * Smoke tests for CONNECTION_RESOLVE_FOR_USER. The underlying resolution
 * logic is covered by slot-resolver.test.ts — this file only verifies the
 * tool wrapper is shaped correctly (app-only visibility, sane schemas).
 */
import { describe, expect, it } from "bun:test";
import { CONNECTION_RESOLVE_FOR_USER } from "./resolve-for-user";

describe("CONNECTION_RESOLVE_FOR_USER", () => {
  it("has app-only visibility (not exposed to AI)", () => {
    const ui = CONNECTION_RESOLVE_FOR_USER._meta?.ui as
      | { visibility?: string }
      | undefined;
    expect(ui?.visibility).toBe("app");
  });

  it("declares input and output schemas", () => {
    expect(CONNECTION_RESOLVE_FOR_USER.inputSchema).toBeDefined();
    expect(CONNECTION_RESOLVE_FOR_USER.outputSchema).toBeDefined();
  });

  it("name matches the convention used by other app-only tools", () => {
    expect(CONNECTION_RESOLVE_FOR_USER.name).toBe(
      "CONNECTION_RESOLVE_FOR_USER",
    );
  });
});
