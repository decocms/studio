import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

const DEFAULT_BLOCKS_PANEL_WIDTH = 40;

function normalizePanelSizePercent(
  value: unknown,
  fallback = DEFAULT_BLOCKS_PANEL_WIDTH,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 100) {
    return fallback;
  }
  return numeric;
}

function blocksPanelWidthInitializer(existing: number | undefined): number {
  return normalizePanelSizePercent(existing);
}

export function useBlocksPanelWidth(): [number, (width: number) => void] {
  const [stored, setStored] = useLocalStorage(
    LOCALSTORAGE_KEYS.blocksPanelWidth(),
    blocksPanelWidthInitializer,
  );
  return [normalizePanelSizePercent(stored), setStored];
}
