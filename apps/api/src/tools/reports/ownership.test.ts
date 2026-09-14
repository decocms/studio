import { describe, expect, test } from "bun:test";
import { isValidCommerceReportOwner } from "./ownership";

describe("isValidCommerceReportOwner", () => {
  test("accepts only the exact project in the current organization", () => {
    expect(
      isValidCommerceReportOwner(
        { id: "vir_owner", organization_id: "org_1" },
        "vir_owner",
        "org_1",
      ),
    ).toBe(true);
    expect(
      isValidCommerceReportOwner(
        { id: "vir_owner", organization_id: "org_2" },
        "vir_owner",
        "org_1",
      ),
    ).toBe(false);
    expect(
      isValidCommerceReportOwner(
        { id: "vir_alias_target", organization_id: "org_1" },
        "vir_alias",
        "org_1",
      ),
    ).toBe(false);
    expect(isValidCommerceReportOwner(null, "vir_missing", "org_1")).toBe(
      false,
    );
  });
});
