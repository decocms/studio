import { useLocalStorage } from "@/hooks/use-local-storage";

/** react-resizable-panels requires numeric defaultSize; localStorage may hold strings. */
function normalizePanelSizePercent(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return fallback;
  return n;
}

export function usePanelWidthPercent(
  key: string,
  defaultWidth: number,
): [number, (width: number) => void] {
  const [stored, setStored] = useLocalStorage(
    key,
    (existing: number | undefined) =>
      normalizePanelSizePercent(existing, defaultWidth),
  );
  return [normalizePanelSizePercent(stored, defaultWidth), setStored];
}
