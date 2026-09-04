/**
 * Resolve the active drawer tab when a script tab finishes closing.
 *
 * The close request is asynchronous, so `currentActive` must be the state at
 * settlement time rather than the tab that was active when the request began.
 */
export function activeTabAfterScriptClose(
  currentActive: string,
  closedTab: string,
  fallbackTab: string,
): string {
  return currentActive === closedTab ? fallbackTab : currentActive;
}
