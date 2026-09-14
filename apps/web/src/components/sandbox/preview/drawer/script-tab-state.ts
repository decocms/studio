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

/** Implements the horizontal ARIA tabs keyboard model with wrapping arrows. */
export function drawerTabIndexForKey(
  key: string,
  currentIndex: number,
  tabCount: number,
): number | null {
  if (tabCount <= 0 || currentIndex < 0) return null;
  switch (key) {
    case "ArrowLeft":
      return (currentIndex - 1 + tabCount) % tabCount;
    case "ArrowRight":
      return (currentIndex + 1) % tabCount;
    case "Home":
      return 0;
    case "End":
      return tabCount - 1;
    default:
      return null;
  }
}
