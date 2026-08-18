export interface SidePanelToggleSet {
  cms: boolean;
  code: boolean;
  chat: boolean;
  /** The Code toggle has to provision a dev environment before it can open. */
  startsDevEnvironment: boolean;
}

/**
 * Which side-panel toggles the shell renders.
 *
 * A CMS project always shows BOTH halves, in every branch state — the pair IS
 * the mode switch, so hiding either one strands the user on that side with no
 * way across. That is not a style preference: a sandbox-less draft that hides
 * the Code half has no reachable path to vibecoding at all, and a draft with a
 * pod that hides the CMS half has none back to content.
 *
 * Only the Code half's BEHAVIOUR varies with the branch — on a sandbox-less
 * draft it provisions before opening. Everything that isn't a CMS project keeps
 * the single Chat toggle it has always had.
 *
 * The pair is orthogonal to the first-class navigation's collapse control:
 * that answers WHETHER the side panel shows, this answers WHICH surface fills
 * it. So `navV2` retires only the bare Chat toggle, whose sole job was
 * hide/show — never the mode pair, which would leave a CMS project unable to
 * choose.
 */
export function resolveSidePanelToggles(args: {
  /** The project can edit content without a sandbox (`resolveCmsMode`). */
  cmsCapable: boolean;
  /** THIS branch is sandbox-less (`resolveCmsModeForBranch`). */
  cmsModeActive: boolean;
  /** First-class navigation: a collapse control owns panel hide/show. */
  navV2: boolean;
}): SidePanelToggleSet {
  if (!args.cmsCapable) {
    return {
      cms: false,
      code: false,
      chat: !args.navV2,
      startsDevEnvironment: false,
    };
  }
  return {
    cms: true,
    code: true,
    chat: false,
    startsDevEnvironment: args.cmsModeActive,
  };
}
