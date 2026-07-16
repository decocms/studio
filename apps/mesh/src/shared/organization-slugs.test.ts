import { describe, expect, test } from "bun:test";
import {
  isReservedOrganizationSlug,
  RESERVED_ORGANIZATION_SLUGS,
} from "./organization-slugs";

describe("reserved organization slugs", () => {
  test("reserves every public first-segment namespace", () => {
    expect([...RESERVED_ORGANIZATION_SLUGS]).toEqual([
      ".well-known",
      "_admin",
      "api",
      "auth",
      "cli",
      "commerce-onboarding",
      "dbos-queue-depth",
      "health",
      "hosted-run-pending",
      "login",
      "mcp",
      "metrics",
      "oauth",
      "oauth-proxy",
      "onboarding",
      "org",
      "report",
      "reset-password",
    ]);
    expect(isReservedOrganizationSlug(" Report ")).toBe(true);
    expect(isReservedOrganizationSlug("API")).toBe(true);
  });

  test("does not reject similar organization slugs", () => {
    expect(isReservedOrganizationSlug("reports")).toBe(false);
    expect(isReservedOrganizationSlug("report-team")).toBe(false);
    expect(isReservedOrganizationSlug(undefined)).toBe(false);
  });
});
