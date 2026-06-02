import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

export const DEFAULT_CHAT_PANEL_WIDTH = 45;

/** react-resizable-panels requires numeric defaultSize; localStorage may hold strings. */
export function normalizePanelSizePercent(
  value: unknown,
  fallback = DEFAULT_CHAT_PANEL_WIDTH,
): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n >= 100) return fallback;
  return n;
}

function chatPanelWidthInitializer(existing: number | undefined): number {
  return normalizePanelSizePercent(existing, DEFAULT_CHAT_PANEL_WIDTH);
}

export function useChatPanelWidth(): [number, (width: number) => void] {
  const [stored, setStored] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    chatPanelWidthInitializer,
  );
  const width = normalizePanelSizePercent(stored, DEFAULT_CHAT_PANEL_WIDTH);
  return [width, setStored];
}
