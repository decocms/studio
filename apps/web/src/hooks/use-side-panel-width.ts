import { usePanelWidthPercent } from "@/hooks/use-panel-width-percent";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

const DEFAULT_SIDE_PANEL_WIDTH = 33;

export function useSidePanelWidth(): [number, (width: number) => void] {
  return usePanelWidthPercent(
    LOCALSTORAGE_KEYS.sidePanelWidth(),
    DEFAULT_SIDE_PANEL_WIDTH,
  );
}
