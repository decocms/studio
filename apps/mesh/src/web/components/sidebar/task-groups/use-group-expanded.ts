import { useLocalStorage } from "@/web/hooks/use-local-storage";

const STORAGE_KEY_PREFIX = "sidebar.group.expanded.";

/**
 * Per-group expanded/collapsed state persisted in localStorage.
 *
 * `defaultExpanded` is consulted only on first read (when no value is stored).
 * Subsequent toggles are sticky across reloads.
 */
export function useGroupExpanded(
  virtualMcpId: string,
  defaultExpanded: boolean,
): [boolean, (next: boolean) => void] {
  const [expanded, setExpanded] = useLocalStorage<boolean>(
    `${STORAGE_KEY_PREFIX}${virtualMcpId}`,
    defaultExpanded,
  );
  return [expanded, setExpanded];
}
