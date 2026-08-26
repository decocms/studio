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
    mainTab: null,
    ...overrides,
  };
}

describe("shouldShowTerminalDrawer", () => {
  test("shows for a sandbox session on a clonable agent", () => {
    expect(shouldShowTerminalDrawer(input())).toBe(true);
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

  test("hides under an overlay tab", () => {
    expect(shouldShowTerminalDrawer(input({ mainTab: "board" }))).toBe(false);
    expect(shouldShowTerminalDrawer(input({ mainTab: "files" }))).toBe(false);
    expect(
      shouldShowTerminalDrawer(input({ mainTab: "connect-sources" })),
    ).toBe(false);
    expect(shouldShowTerminalDrawer(input({ mainTab: "reports" }))).toBe(false);
  });

  test("shows under a non-overlay tab", () => {
    expect(shouldShowTerminalDrawer(input({ mainTab: "preview" }))).toBe(true);
    expect(shouldShowTerminalDrawer(input({ mainTab: "code" }))).toBe(true);
  });
});
