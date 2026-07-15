import { usePanelWidthPercent } from "@/web/hooks/use-panel-width-percent";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

const DEFAULT_BLOCKS_PANEL_WIDTH = 40;

export function useBlocksPanelWidth(): [number, (width: number) => void] {
  return usePanelWidthPercent(
    LOCALSTORAGE_KEYS.blocksPanelWidth(),
    DEFAULT_BLOCKS_PANEL_WIDTH,
  );
}
