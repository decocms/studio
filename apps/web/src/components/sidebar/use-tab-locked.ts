import { useEntitlements } from "@/hooks/use-entitlements";
import { featureForTab } from "@/layouts/main-panel-tabs/tab-feature";

/**
 * Whether the org's plan withholds the view a sidebar row leads to.
 *
 * One definition for both lists — the org's destinations and a project's views
 * — because a row that opens a paywall should look the same wherever it is.
 * Keyed off the row's tab id, which is what `featureForTab` already maps, so
 * the lock and the gate can never disagree about which views are gated.
 *
 * Fails OPEN like every other plan gate: no answer, no lock. The row stays
 * clickable either way — the paywall is what explains the refusal, and a row
 * that does nothing explains nothing.
 */
export function useTabLocked(): (tabId: string) => boolean {
  const { data } = useEntitlements();
  return (tabId: string) => {
    const feature = featureForTab(tabId);
    if (!feature || !data) return false;
    return data.features[feature] !== true;
  };
}
