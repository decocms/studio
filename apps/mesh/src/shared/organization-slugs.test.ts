import { describe, expect, test } from "bun:test";
import {
  isReservedOrganizationSlug,
  RESERVED_ORGANIZATION_SLUGS,
} from "./organization-slugs";

describe("reserved organization slugs", () => {
  test("reserves the public report namespace", () => {
    expect(RESERVED_ORGANIZATION_SLUGS).toContain("report");
    expect(isReservedOrganizationSlug("report")).toBe(true);
    expect(isReservedOrganizationSlug(" Report ")).toBe(true);
  });

  test("does not reject similar organization slugs", () => {
    expect(isReservedOrganizationSlug("reports")).toBe(false);
    expect(isReservedOrganizationSlug("report-team")).toBe(false);
    expect(isReservedOrganizationSlug(undefined)).toBe(false);
  });
});
