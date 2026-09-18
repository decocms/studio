import { describe, expect, test } from "bun:test";
import {
  isConfiguredDemoOrganization,
  parseDemoOrganizationId,
} from "./config";

describe("deployment demo target", () => {
  test.each([undefined, "", "   "])(
    "disables demonstrations for %p",
    (value) => {
      expect(
        isConfiguredDemoOrganization(
          parseDemoOrganizationId(value),
          "customer-org",
        ),
      ).toBe(false);
    },
  );
  test("matches one exact, case-sensitive ID", () => {
    const id = parseDemoOrganizationId("  org_123-ABC  ");
    expect(isConfiguredDemoOrganization(id, "org_123-ABC")).toBe(true);
    for (const other of [
      "org_123-abc",
      "org_123-ABC ",
      "demo-storefront",
      "customer-org",
      "",
    ])
      expect(isConfiguredDemoOrganization(id, other)).toBe(false);
  });
  test.each([
    "*",
    "org-a,org-b",
    "org-a org-b",
    "org-a\norg-b",
    "x".repeat(129),
  ])("rejects ambiguous deployment configuration %p", (value) => {
    expect(() => parseDemoOrganizationId(value)).toThrow(
      "one exact organization ID",
    );
  });
});
