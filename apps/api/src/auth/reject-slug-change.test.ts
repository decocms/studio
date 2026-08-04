import { describe, expect, test } from "bun:test";
import { rejectOrganizationSlugChange } from "./reject-slug-change";

describe("rejectOrganizationSlugChange", () => {
  test("allows an update that omits the slug", () => {
    expect(() => rejectOrganizationSlugChange("acme", undefined)).not.toThrow();
  });

  test("allows resubmitting the current slug", () => {
    expect(() => rejectOrganizationSlugChange("acme", "acme")).not.toThrow();
  });

  test("rejects renaming the slug", () => {
    expect(() => rejectOrganizationSlugChange("acme", "acme-2")).toThrow(
      "Organization slug cannot be changed after creation.",
    );
  });
});
