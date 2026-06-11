import { describe, expect, it } from "bun:test";
import { validateTenantConfig } from "./validate";

describe("validateTenantConfig operator", () => {
  it("accepts a valid operator", () => {
    expect(
      validateTenantConfig({
        operator: { userName: "Jane Doe", userEmail: "jane@example.com" },
      }),
    ).toEqual({ kind: "ok" });
  });

  it("rejects unsafe display names", () => {
    expect(
      validateTenantConfig({
        operator: { userName: "Jane\nEvil" },
      }),
    ).toEqual({ kind: "invalid", reason: "operator.userName is required" });
  });

  it("rejects invalid emails", () => {
    expect(
      validateTenantConfig({
        operator: { userName: "Jane Doe", userEmail: "not-an-email" },
      }),
    ).toEqual({ kind: "invalid", reason: "operator.userEmail is invalid" });
  });
});
