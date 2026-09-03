import { describe, expect, test } from "bun:test";
import {
  shouldShowTerminalDrawer,
  type TerminalDrawerGateInput,
} from "./terminal-drawer-gate";

function input(
  overrides: Partial<TerminalDrawerGateInput> = {},
): TerminalDrawerGateInput {
  return {
    hasClonableSource: true,
    fastPreviewActive: false,
    mainTab: "site-editor",
    ...overrides,
  };
}

describe("shouldShowTerminalDrawer", () => {
  test("shows on the Site Editor for a sandbox session on a clonable agent", () => {
    expect(shouldShowTerminalDrawer(input())).toBe(true);
  });

  // `/site-editor?main=content` is the same route as the preview.
  test("shows on the Site Editor's Content sub-view", () => {
    expect(shouldShowTerminalDrawer(input({ mainTab: "content" }))).toBe(true);
  });

  // Callers only reach this gate with visibility already on.
  test("hides for a sandbox-less Fast Preview session", () => {
    expect(shouldShowTerminalDrawer(input({ fastPreviewActive: true }))).toBe(
      false,
    );
  });

  test("hides without a clonable source", () => {
    expect(shouldShowTerminalDrawer(input({ hasClonableSource: false }))).toBe(
      false,
    );
  });

  test("hides under every view that is not the Site Editor", () => {
    for (const mainTab of [
      "overview",
      "settings",
      "git",
      "code",
      "code:src%2Fapp.tsx",
      "assets",
      "automations",
      "hosting",
      "board",
      "files",
      "connect-sources",
      "reports",
      "discover",
    ]) {
      expect(shouldShowTerminalDrawer(input({ mainTab }))).toBe(false);
    }
  });

  test("hides when the panel names no view", () => {
    expect(shouldShowTerminalDrawer(input({ mainTab: null }))).toBe(false);
  });
});
