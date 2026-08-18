import { describe, expect, test } from "bun:test";
import { resolveSidePanelToggles } from "./side-panel-toggles";

describe("resolveSidePanelToggles", () => {
  test("a non-CMS project keeps the single Chat toggle", () => {
    expect(
      resolveSidePanelToggles({ cmsCapable: false, cmsModeActive: false }),
    ).toEqual({
      cms: false,
      code: false,
      chat: true,
      startsDevEnvironment: false,
    });
  });

  test("a sandbox-less CMS draft offers both halves, Code provisioning", () => {
    expect(
      resolveSidePanelToggles({ cmsCapable: true, cmsModeActive: true }),
    ).toEqual({
      cms: true,
      code: true,
      chat: false,
      startsDevEnvironment: true,
    });
  });

  test("a CMS draft with a pod offers both halves, Code just opening", () => {
    expect(
      resolveSidePanelToggles({ cmsCapable: true, cmsModeActive: false }),
    ).toEqual({
      cms: true,
      code: true,
      chat: false,
      startsDevEnvironment: false,
    });
  });

  /**
   * The regression this rule exists for: gating a half on the branch state hid
   * the Code toggle on exactly the drafts that needed it, leaving the switch
   * reachable only by hand-editing `?sidepanel=`.
   */
  test("provisioning a sandbox never adds or removes a toggle", () => {
    const before = resolveSidePanelToggles({
      cmsCapable: true,
      cmsModeActive: true,
    });
    const after = resolveSidePanelToggles({
      cmsCapable: true,
      cmsModeActive: false,
    });
    expect({ cms: after.cms, code: after.code, chat: after.chat }).toEqual({
      cms: before.cms,
      code: before.code,
      chat: before.chat,
    });
  });
});
