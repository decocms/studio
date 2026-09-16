import { createContext, use, useState, type ReactNode } from "react";
import type { BreadcrumbExtension } from "./breadcrumb-model";

function createBreadcrumbStore() {
  let snapshot: ReadonlyMap<string, BreadcrumbExtension> = new Map();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(extension: BreadcrumbExtension) {
      if (snapshot.has(extension.after)) {
        throw new Error(`Two components extend breadcrumb: ${extension.after}`);
      }
      snapshot = new Map(snapshot).set(extension.after, extension);
      notify();
      return () => {
        if (snapshot.get(extension.after) !== extension) return;
        const next = new Map(snapshot);
        next.delete(extension.after);
        snapshot = next;
        notify();
      };
    },
  };
}

const BreadcrumbContext = createContext<ReturnType<
  typeof createBreadcrumbStore
> | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createBreadcrumbStore);
  return <BreadcrumbContext value={store}>{children}</BreadcrumbContext>;
}

export function useBreadcrumbStore() {
  return use(BreadcrumbContext);
}

/** A ref publishes only committed renders; React cleans up on replacement or unmount. */
export function BreadcrumbContribution(extension: BreadcrumbExtension) {
  const store = useBreadcrumbStore();
  if (!store)
    throw new Error(
      "Breadcrumb contributions require Page.Breadcrumbs.Provider",
    );
  return (
    <span
      hidden
      ref={(node) => (node ? store.register(extension) : undefined)}
    />
  );
}
