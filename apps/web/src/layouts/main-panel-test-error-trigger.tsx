import type { ReactNode } from "react";

declare global {
  interface Window {
    /** E2E-only route body selected for deterministic boundary testing. */
    __forceTabError?: string;
  }
}

/**
 * Deliberately crashes a route body when the E2E harness requests it.
 *
 * Keep this inside each route-owned ErrorBoundary: the test verifies that an
 * error is isolated to the active route and that switching routes remounts a
 * healthy boundary. The branch is removed from normal production builds.
 */
export function MainPanelTestErrorTrigger({
  children,
  routeId,
}: {
  children: ReactNode;
  routeId: string;
}) {
  const e2eHooksEnabled =
    import.meta.env.DEV ||
    (typeof __E2E_TEST_HOOKS__ !== "undefined" && __E2E_TEST_HOOKS__);
  if (
    e2eHooksEnabled &&
    typeof window !== "undefined" &&
    window.__forceTabError === routeId
  ) {
    throw new Error(`forced tab error: ${routeId}`);
  }

  return children;
}
