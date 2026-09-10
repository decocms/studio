import { describe, expect, test } from "bun:test";
import { DESTINATION_ROUTE, routeExistsInScope } from "./use-destination-route";

const SCOPE = "vir_scope";

/** The one fact behind two behaviours: which rows the sidebar drops
 *  (`nav-destinations.tsx`), and where `useExitProjectScope` lands. Leaving a
 *  project un-narrows the page you are on, EXCEPT on a page that cannot exist
 *  for the org — that one has to relocate to Home, because the nav has just
 *  dropped the only row that reached it. */
describe("routeExistsInScope", () => {
  test("Reports is project-only: it exists scoped, not for the org", () => {
    expect(routeExistsInScope(DESTINATION_ROUTE.reports, SCOPE)).toBe(true);
    expect(routeExistsInScope(DESTINATION_ROUTE.reports, null)).toBe(false);
  });

  test("Library is org-only: the mirror of Reports", () => {
    expect(routeExistsInScope(DESTINATION_ROUTE.library, null)).toBe(true);
    expect(routeExistsInScope(DESTINATION_ROUTE.library, SCOPE)).toBe(false);
  });

  /** Everything else un-narrows in place — the property the exit hook exists
   *  for. Turning any of these into a jump to Home would throw it away. */
  test.each([
    ["Home", DESTINATION_ROUTE.home],
    ["Tasks", DESTINATION_ROUTE.tasks],
    ["Agents", DESTINATION_ROUTE.agents],
    ["Discover", DESTINATION_ROUTE.discover],
    ["the org index", DESTINATION_ROUTE.orgIndex],
    ["the legacy thread route", DESTINATION_ROUTE.legacyThread],
  ])("%s exists on both sides of the scope", (_name, path) => {
    expect(routeExistsInScope(path, SCOPE)).toBe(true);
    expect(routeExistsInScope(path, null)).toBe(true);
  });

  /** A path nobody registered is not a page a scope can invalidate: unknown
   *  means unbound, so an unrecognised route un-narrows rather than bouncing
   *  the user to Home for a reason no one can see. */
  test("an unknown path is unbound", () => {
    expect(routeExistsInScope("/$org/not-a-destination", SCOPE)).toBe(true);
    expect(routeExistsInScope("/$org/not-a-destination", null)).toBe(true);
  });
});
