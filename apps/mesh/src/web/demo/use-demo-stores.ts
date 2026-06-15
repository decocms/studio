/**
 * Demo Mode — React subscription hooks for the Director's external stores.
 * All reads go through `useSyncExternalStore` (no `useEffect`).
 */
import { useSyncExternalStore } from "react";
import type { DemoStores } from "./director-stores";

export function useCaption(stores: DemoStores): string | null {
  return useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().caption,
    () => stores.ui.get().caption,
  );
}

export function useDemoInput(stores: DemoStores, id: string): string {
  return useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().inputs[id] ?? "",
    () => stores.ui.get().inputs[id] ?? "",
  );
}

export function useCurrentOrg(stores: DemoStores): string | null {
  return useSyncExternalStore(
    stores.ui.subscribe,
    () => stores.ui.get().currentOrg,
    () => stores.ui.get().currentOrg,
  );
}

/** True when a given org's agent track is mid-stream — drives the "working in
 *  the background" pulse on inactive org tabs. */
export function useTrackBusy(stores: DemoStores, orgId: string): boolean {
  const store = stores.getChat(orgId);
  return useSyncExternalStore(
    store.subscribe,
    () =>
      store.get().status === "streaming" || store.get().status === "submitted",
    () =>
      store.get().status === "streaming" || store.get().status === "submitted",
  );
}
