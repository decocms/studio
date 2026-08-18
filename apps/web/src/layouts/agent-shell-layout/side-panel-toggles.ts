export interface SidePanelToggleSet {
  /** The CMS/vibecoding split button — one control for both modes. */
  mode: boolean;
  chat: boolean;
  /** The Code toggle has to provision a dev environment before it can open. */
  startsDevEnvironment: boolean;
}

/**
 * Which side-panel toggles the shell renders.
 *
 * A CMS project always shows the mode control, in every branch state — it IS
 * the switch, so withholding it strands the user wherever they are with no way
 * across. That is not a style preference: a sandbox-less draft without it has
 * no reachable path to vibecoding at all, and a pod-backed draft has none back
 * to content.
 *
 * Only the control's BEHAVIOUR varies with the branch — on a sandbox-less draft
 * choosing vibecoding provisions before opening. Everything that isn't a CMS
 * project keeps the single Chat toggle it has always had.
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
    return { mode: false, chat: !args.navV2, startsDevEnvironment: false };
  }
  return { mode: true, chat: false, startsDevEnvironment: args.cmsModeActive };
}
