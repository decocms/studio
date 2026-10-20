import { createContext, type ReactNode, useContext, useState } from "react";

/**
 * Store for the expand/collapse state of `ObjectField` groups, keyed by field
 * path.
 *
 * `ObjectField` renders each object-type prop as a collapsible group. Its open
 * state used to live in local `useState`, but drilling into an array item
 * narrows `SchemaForm`'s `visibleKeys` to the active field, unmounting every
 * sibling group and destroying that state — so returning via the breadcrumb
 * collapsed everything the user had opened. Hoisting the state here, above the
 * drill-in/out boundary, keeps it alive across navigation. The provider is
 * created by the outermost `SchemaForm`, so it resets exactly when the form
 * itself resets (section switch remounts `SchemaForm` via its `formResetKey`).
 */
interface ObjectFieldExpansionStore {
  isExpanded: (path: string) => boolean;
  toggle: (path: string) => void;
}

const ObjectFieldExpansionContext =
  createContext<ObjectFieldExpansionStore | null>(null);

export function ObjectFieldExpansionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const store: ObjectFieldExpansionStore = {
    isExpanded: (path) => expanded.has(path),
    toggle: (path) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      }),
  };
  return (
    <ObjectFieldExpansionContext.Provider value={store}>
      {children}
    </ObjectFieldExpansionContext.Provider>
  );
}

/** True when an enclosing `SchemaForm` already provides an expansion store. */
export function useHasObjectFieldExpansion(): boolean {
  return useContext(ObjectFieldExpansionContext) !== null;
}

/** The nearest expansion store, or `null` when rendered without a provider. */
export function useObjectFieldExpansion(): ObjectFieldExpansionStore | null {
  return useContext(ObjectFieldExpansionContext);
}
