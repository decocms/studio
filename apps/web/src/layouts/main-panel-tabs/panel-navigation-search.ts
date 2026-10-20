/**
 * Build the search state for a main-panel route transition.
 *
 * Only shell-owned state may follow a transition implicitly. Route-local
 * payload belongs to the route that consumes it and is supplied explicitly by
 * `tabRouteTarget` or a caller-provided update.
 */

type PanelNavigationSearchUpdater = (
  search: Record<string, unknown>,
) => Record<string, unknown>;

export function resolvePanelNavigationSearch(input: {
  previous: Readonly<Record<string, unknown>>;
  destination: "agent" | "organization";
  update?: PanelNavigationSearchUpdater;
}): Record<string, unknown> {
  const carriesThread = input.destination === "agent";
  const shared: Record<string, unknown> = {
    thread: carriesThread ? input.previous.thread : undefined,
    sidepanel: input.previous.sidepanel,
    /** Autosend is thread-scoped hand-off state. It must survive a view change
     * within that thread, but never outlive the thread on an org destination. */
    autosend: carriesThread ? input.previous.autosend : undefined,
  };
  const next = input.update ? input.update(shared) : shared;
  return { ...next, mainpanel: undefined };
}
