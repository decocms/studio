/**
 * Context whose value comes from a keyed source, so the state behind it resets
 * when the key changes (a thread switch) while the tree that reads it stays
 * mounted.
 *
 * Keying the provider itself resets the state by remounting every child, and
 * with a child as large as the chat layout that closes the chat and reloads
 * the open app. Here the keyed part is a sibling `source` that renders nothing
 * and publishes its value before paint; `children` render once the first value
 * is in.
 */
import {
  createContext,
  use,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Context,
  type ReactNode,
} from "react";

interface Store<T> {
  get: () => { value: T } | null;
  set: (value: T) => void;
  subscribe: (listener: () => void) => () => void;
}

function createStore<T>(): Store<T> {
  let current: { value: T } | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (value) => {
      if (current && current.value === value) return;
      current = { value };
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// Capitalized: the compiler inlines a lowercase alias into a host tag.
export function createKeyedContext<T>(ValueContext: Context<T>) {
  const StoreContext = createContext<Store<T> | null>(null);

  function Host({
    source,
    children,
  }: {
    /** Key it by whatever the state belongs to. */
    source: ReactNode;
    children: ReactNode;
  }) {
    const [store] = useState(createStore<T>);
    const entry = useSyncExternalStore(store.subscribe, store.get);
    return (
      <StoreContext value={store}>
        {source}
        {entry && <ValueContext value={entry.value}>{children}</ValueContext>}
      </StoreContext>
    );
  }

  /** Called by the source on every render. */
  function usePublish(value: T) {
    const store = use(StoreContext);
    if (!store) {
      throw new Error("A keyed context source must render inside its Host");
    }
    useLayoutEffect(() => {
      store.set(value);
    });
  }

  return { Host, usePublish };
}
