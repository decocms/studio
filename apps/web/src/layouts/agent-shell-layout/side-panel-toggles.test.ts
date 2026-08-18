import { describe, expect, test } from "bun:test";
import { resolveSidePanelToggles } from "./side-panel-toggles";

describe("resolveSidePanelToggles", () => {
  test("a non-CMS project keeps the single Chat toggle", () => {
    expect(
      resolveSidePanelToggles({
        cmsCapable: false,
        cmsModeActive: false,
        navV2: false,
      }),
    ).toEqual({
      cms: false,
      code: false,
      chat: true,
      startsDevEnvironment: false,
    });
  });

  test("a sandbox-less CMS draft offers both halves, Code provisioning", () => {
    expect(
      resolveSidePanelToggles({
        cmsCapable: true,
        cmsModeActive: true,
        navV2: false,
      }),
    ).toEqual({
      cms: true,
      code: true,
      chat: false,
      startsDevEnvironment: true,
    });
  });

  test("a CMS draft with a pod offers both halves, Code just opening", () => {
    expect(
      resolveSidePanelToggles({
        cmsCapable: true,
        cmsModeActive: false,
        navV2: false,
      }),
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
      navV2: false,
    });
    const after = resolveSidePanelToggles({
      cmsCapable: true,
      cmsModeActive: false,
      navV2: false,
    });
    expect({ cms: after.cms, code: after.code, chat: after.chat }).toEqual({
      cms: before.cms,
      code: before.code,
      chat: before.chat,
    });
  });
});

describe("resolveSidePanelToggles under the first-class navigation", () => {
  /** Its collapse control already owns hide/show, so the bare Chat toggle goes. */
  test("a non-CMS project drops the Chat toggle", () => {
    expect(
      resolveSidePanelToggles({
        cmsCapable: false,
        cmsModeActive: false,
        navV2: true,
      }).chat,
    ).toBe(false);
  });

  /** Collapse answers WHETHER; the pair answers WHICH. Dropping it would leave
   *  a CMS project unable to choose a surface at all. */
  test("a CMS project keeps both halves of the mode pair", () => {
    const set = resolveSidePanelToggles({
      cmsCapable: true,
      cmsModeActive: true,
      navV2: true,
    });
    expect({ cms: set.cms, code: set.code }).toEqual({ cms: true, code: true });
    expect(set.startsDevEnvironment).toBe(true);
  });
});
