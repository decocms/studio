import {
  DEFAULT_SIDE_PANEL_WIDTH,
  type SidePanelTab,
} from "@/web/hooks/use-layout-state";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

/** react-resizable-panels requires numeric defaultSize; localStorage may hold strings. */
function normalizePanelSizePercent(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return fallback;
  return n;
}

/**
 * Side panel width, persisted per surface: chat is a conversation column and
 * blocks is a fixed-width list plus a props editor, so a single shared width
 * would leave one of them cramped.
 */
export function useSidePanelWidth(
  tab: SidePanelTab,
): [number, (width: number) => void] {
  const fallback = DEFAULT_SIDE_PANEL_WIDTH[tab];
  const [stored, setStored] = useLocalStorage(
    LOCALSTORAGE_KEYS.sidePanelWidth(tab),
    (existing: number | undefined) =>
      normalizePanelSizePercent(existing, fallback),
  );
  return [normalizePanelSizePercent(stored, fallback), setStored];
}
