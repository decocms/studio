import { usePanelWidthPercent } from "@/web/hooks/use-panel-width-percent";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";

// Chat takes ~1/3 by default so the main panel (the agent's app / the Super
// Agent's Overview) gets most of the space. Users who drag it keep their
// persisted width.
const DEFAULT_CHAT_PANEL_WIDTH = 33;

export function useChatPanelWidth(): [number, (width: number) => void] {
  return usePanelWidthPercent(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    DEFAULT_CHAT_PANEL_WIDTH,
  );
}
