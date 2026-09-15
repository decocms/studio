import { describe, expect, test } from "bun:test";
import {
  shouldShowSiteEditorDrawer,
  type SiteEditorDrawerAvailability,
} from "./drawer-availability";

function availability(
  overrides: Partial<SiteEditorDrawerAvailability> = {},
): SiteEditorDrawerAvailability {
  return {
    hasClonableSource: true,
    runtime: "sandbox",
    ...overrides,
  };
}

describe("shouldShowSiteEditorDrawer", () => {
  test("shows for every nested Site Editor view in a sandbox session", () => {
    expect(shouldShowSiteEditorDrawer(availability())).toBe(true);
  });

  test("hides for a sandbox-less CMS session", () => {
    expect(shouldShowSiteEditorDrawer(availability({ runtime: "cms" }))).toBe(
      false,
    );
  });

  test("hides when neither the agent nor thread has a clonable source", () => {
    expect(
      shouldShowSiteEditorDrawer(availability({ hasClonableSource: false })),
    ).toBe(false);
  });
});
