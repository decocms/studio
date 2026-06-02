/**
 * ChatMainPanelGroup — two-panel resizable group (chat | main).
 *
 * Tasks panel is a separate sibling column; this group only manages
 * the working area. Keyed by virtualMcpId + taskId; remounts on switch.
 */

import {
  useEffect,
  useRef,
  useTransition,
  type PropsWithChildren,
} from "react";
import { cn } from "@deco/ui/lib/utils.js";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ImperativePanelGroupHandle,
} from "@/web/components/resizable";
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { computeChatMainSizes } from "@/web/hooks/use-layout-state";
import { ChatCenterPanel } from "@/web/layouts/chat-center-panel";
import { MainPanelContent } from "@/web/layouts/main-panel-tabs";
import { ErrorBoundary } from "@/web/components/error-boundary";

const DEFAULT_CHAT_PANEL_WIDTH = 45;

/** react-resizable-panels requires numeric defaultSize; localStorage may hold strings. */
function normalizePanelSizePercent(
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

function PersistentChatPanel({
  children,
  defaultSize,
  chatOpen,
}: PropsWithChildren<{ defaultSize: number; chatOpen: boolean }>) {
  const [_isPending, startTransition] = useTransition();
  const [storedChatPanelWidth, setChatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    chatPanelWidthInitializer,
  );
  const chatPanelWidth = normalizePanelSizePercent(
    storedChatPanelWidth,
    DEFAULT_CHAT_PANEL_WIDTH,
  );
  // Only apply the stored width when both panels are open (non-extreme default).
  // When chat is solo (100) or closed (0), the caller's defaultSize wins.
  const effectiveDefaultSize =
    defaultSize > 0 && defaultSize < 100 ? chatPanelWidth : defaultSize;
  const handleResize = (size: number) =>
    startTransition(() => {
      if (size > 0 && size < 100) setChatPanelWidth(size);
    });
  return (
    <ResizablePanel
      defaultSize={effectiveDefaultSize}
      minSize={20}
      collapsible={true}
      collapsedSize={0}
      className={cn(
        "overflow-hidden bg-sidebar",
        chatOpen ? "min-w-[348px]" : "min-w-0",
      )}
      onResize={handleResize}
      order={1}
    >
      {children}
    </ResizablePanel>
  );
}

export interface ChatMainPanelGroupProps {
  virtualMcpId: string;
  taskId: string;
  chatOpen: boolean;
  mainOpen: boolean;
  /** Optional override for the chat panel content — lets the outer layout
   * wrap ChatCenterPanel in its own Suspense/ErrorBoundary.
   * (Chat.ActiveTaskProvider is mounted by the outer layout, not here.) */
  chatContent?: React.ReactNode;
}

export function ChatMainPanelGroup({
  virtualMcpId,
  taskId,
  chatOpen,
  mainOpen,
  chatContent,
}: ChatMainPanelGroupProps) {
  const sizes = computeChatMainSizes(chatOpen, mainOpen);
  const [storedChatPanelWidth] = useLocalStorage(
    LOCALSTORAGE_KEYS.decoChatPanelWidth(),
    chatPanelWidthInitializer,
  );
  const chatPanelWidth = normalizePanelSizePercent(
    storedChatPanelWidth,
    DEFAULT_CHAT_PANEL_WIDTH,
  );
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — syncs panel layout from URL-derived state; imperative DOM API has no React 19 alternative
  useEffect(() => {
    const handle = panelGroupRef.current;
    if (!handle) return;
    const s = computeChatMainSizes(chatOpen, mainOpen);
    // When both panels are open, honor the user's persisted chat width.
    const chatSize = s.chat > 0 && s.chat < 100 ? chatPanelWidth : s.chat;
    const mainSize = s.chat > 0 && s.chat < 100 ? 100 - chatPanelWidth : s.main;
    handle.setLayout([chatSize, mainSize]);
  }, [chatOpen, mainOpen, chatPanelWidth]);

  return (
    <ResizablePanelGroup
      ref={panelGroupRef}
      key={`${virtualMcpId}-${taskId}`}
      direction="horizontal"
      className="flex-1 min-h-0 pb-1 pr-1 pl-0 pt-0"
      style={{ overflow: "visible" }}
    >
      <PersistentChatPanel defaultSize={sizes.chat} chatOpen={chatOpen}>
        <div className="h-full p-0.5 pt-0.25">
          <div className="h-full bg-background rounded-[0.75rem] overflow-hidden card-shadow">
            {chatContent ?? <ChatCenterPanel />}
          </div>
        </div>
      </PersistentChatPanel>

      <ResizableHandle className="bg-sidebar" />

      <ResizablePanel
        className="min-w-0 flex flex-col"
        order={2}
        defaultSize={sizes.main}
        style={{ overflow: "visible" }}
        collapsible={true}
        collapsedSize={0}
        minSize={20}
      >
        <div className="h-full p-0.5 pt-0.25">
          <div
            className={cn(
              "flex flex-col h-full min-h-0 bg-background overflow-hidden",
              "card-shadow",
              "transition-[border-radius] duration-200 ease-[var(--ease-out-quart)]",
              "rounded-[0.75rem]",
            )}
          >
            <div className="flex-1 min-h-0 overflow-hidden">
              <ErrorBoundary>
                <MainPanelContent taskId={taskId} virtualMcpId={virtualMcpId} />
              </ErrorBoundary>
            </div>
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
