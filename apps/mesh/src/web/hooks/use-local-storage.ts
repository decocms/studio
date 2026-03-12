// oxlint-disable-next-line ban-use-effect/ban-use-effect
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

function safeParse<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/**
 * Initialize value from localStorage using the initializer
 * Handles reading, applying initializer, and saving back if needed
 */
function initializeFromStorage<T>(
  key: string,
  initializer: T | ((existing: T | undefined) => T),
): T {
  const item = localStorage.getItem(key);
  const existing = item ? safeParse<T>(item) : undefined;

  // Call initializer (value or function)
  const next =
    typeof initializer === "function"
      ? (initializer as (existing: T | undefined) => T)(existing)
      : (existing ?? initializer);

  // If the initializer changed the value (migration or default), save it back
  if (existing === undefined || next !== existing) {
    try {
      const stringified = JSON.stringify(next);
      localStorage.setItem(key, stringified);
    } catch {
      // Ignore errors during migration or initial save
    }
  }

  return next;
}

export function useLocalStorage<T>(
  key: string,
  initializer: T | ((existing: T | undefined) => T),
): [T, (value: T | ((prev: T) => T)) => void] {
  const queryClientInstance = useQueryClient();
  const queryKey = ["localStorage", key] as const;

  // Use TanStack Query to read from localStorage
  const { data: value } = useQuery({
    queryKey,
    queryFn: () => initializeFromStorage(key, initializer),
    initialData: () => initializeFromStorage(key, initializer),
    staleTime: Infinity, // localStorage doesn't change unless we update it
    gcTime: Infinity, // Keep in cache indefinitely
  });

  // Listen for external storage changes (e.g. from plugin components)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const qk = ["localStorage", key] as const;
    const handler = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        const parsed = safeParse<T>(e.newValue);
        if (parsed !== undefined) {
          queryClientInstance.setQueryData(qk, parsed);
        }
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, [key, queryClientInstance]);

  // Mutation to write to localStorage
  const mutation = useMutation({
    mutationFn: async (newValue: T) => {
      const stringified = JSON.stringify(newValue);
      localStorage.setItem(key, stringified);
      return newValue;
    },
    onSuccess: (newValue) => {
      // Update the query cache optimistically
      queryClientInstance.setQueryData(queryKey, newValue);
    },
  });

  // Setter that updates localStorage via mutation
  const setLocalStorageValue = (updater: T | ((prev: T) => T)) => {
    const current = queryClientInstance.getQueryData<T>(queryKey);
    // If for some reason current is undefined (shouldn't happen due to initialData),
    // we fall back to initializer logic or just throw/ignore.
    // Assuming initialData guarantees T.
    const next =
      typeof updater === "function"
        ? (updater as (prev: T) => T)(current as T)
        : updater;

    mutation.mutate(next);
  };

  // Return the value from query (guaranteed to be T due to initialData)
  return [value as T, setLocalStorageValue];
}
