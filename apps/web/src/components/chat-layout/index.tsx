import { createContext, use, type ReactNode } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { Panel } from "@/components/panel";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/resizable";
import {
  computeChatLayoutPanelSizes,
  resolveMobileSurface,
  type ChatLayoutActions,
  type ChatLayoutState,
} from "@/hooks/use-chat-layout-state";
import { useSidePanelWidth } from "@/hooks/use-side-panel-width";
import { MainPanelBoundary, PanelLoading } from "@/layouts/main-panel-boundary";
import { useT } from "@/i18n/use-t";
import { PanelCollapseToggle } from "./toggle-buttons";

const THREAD_PANEL_ID = "chat-layout-thread";
const CONTENT_PANEL_ID = "chat-layout-content";

interface ChatLayoutProps extends ChatLayoutState, ChatLayoutActions {
  children: ReactNode;
  /** Route identity resets a failed content body when navigation changes. */
  contentKey: string;
  contentNavigation?: ReactNode;
  contentActions?: ReactNode;
}

interface ChatLayoutContextValue extends Omit<ChatLayoutProps, "children"> {
  isMobile: boolean;
  mobileSurface: ReturnType<typeof resolveMobileSurface>;
}

const ChatLayoutContext = createContext<ChatLayoutContextValue | null>(null);

/** Visibility and presentation controls only; agent and thread data stay in their providers. */
export function useChatLayout(): ChatLayoutState & ChatLayoutActions {
  return useChatLayoutContext();
}

function useChatLayoutContext() {
  const layout = use(ChatLayoutContext);
  if (!layout) throw new Error("ChatLayout regions require a ChatLayout");
  return layout;
}

/** Places the thread beside routed content, or selects one region on mobile. */
function ChatLayoutRoot({ children, ...layout }: ChatLayoutProps) {
  const isMobile = useIsMobile();
  const [threadWidth, setThreadWidth] = useSidePanelWidth();
  const { threadOpen, contentOpen } = layout;
  const sizes = computeChatLayoutPanelSizes(layout);
  const threadSize = threadOpen && contentOpen ? threadWidth : sizes.side;
  const contentSize = 100 - threadSize;
  const value = {
    ...layout,
    isMobile,
    mobileSurface: resolveMobileSurface({
      visibility: layout,
      threadVisibilityExplicit: layout.threadVisibilityExplicit,
    }),
  };

  return (
    <ChatLayoutContext value={value}>
      {isMobile ? (
        <div
          data-slot="chat-layout"
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background"
        >
          {children}
        </div>
      ) : (
        <ResizablePanelGroup
          ref={(group) => {
            if (!group) return;
            let attached = true;
            // The library registers the group after attaching its imperative ref.
            queueMicrotask(() => {
              if (attached) {
                group.setLayout({
                  [THREAD_PANEL_ID]: threadSize,
                  [CONTENT_PANEL_ID]: contentSize,
                });
              }
            });
            return () => {
              attached = false;
            };
          }}
          defaultLayout={{
            [THREAD_PANEL_ID]: threadSize,
            [CONTENT_PANEL_ID]: contentSize,
          }}
          orientation="horizontal"
          data-slot="chat-layout"
          className="flex-1 min-h-0 pt-1 pb-1 pr-1 pl-0 [&>[data-chat-layout-panel-open]]:!min-w-[320px]"
          style={{ overflow: "visible" }}
          onLayoutChanged={(nextLayout, { isUserInteraction }) => {
            const percentage = nextLayout[THREAD_PANEL_ID];
            if (
              isUserInteraction &&
              threadOpen &&
              contentOpen &&
              typeof percentage === "number" &&
              percentage > 0 &&
              percentage < 100
            ) {
              setThreadWidth(percentage);
            }
          }}
        >
          {children}
        </ResizablePanelGroup>
      )}
    </ChatLayoutContext>
  );
}

function ChatLayoutThread({
  children,
  topbar,
}: {
  children: ReactNode;
  topbar?: ReactNode;
}) {
  const layout = useChatLayoutContext();
  if (layout.isMobile) {
    return layout.mobileSurface === "chat" ? (
      <Panel variant="plain" data-slot="chat-layout-thread">
        <Panel.Content data-testid="chat-panel">{children}</Panel.Content>
      </Panel>
    ) : null;
  }

  return (
    <>
      <ResizablePanel
        id={THREAD_PANEL_ID}
        defaultSize="33%"
        minSize="20%"
        collapsible
        collapsedSize="0%"
        data-chat-layout-panel-open={layout.threadOpen ? "" : undefined}
        className="min-w-0 overflow-hidden bg-sidebar"
      >
        <div className="h-full min-h-0 p-0.5">
          <Panel data-testid="side-panel">
            {layout.threadOpen && (
              <>
                {topbar}
                <Panel.Content data-testid="chat-panel">
                  {children}
                </Panel.Content>
              </>
            )}
          </Panel>
        </div>
      </ResizablePanel>
      <ResizableHandle className="bg-sidebar" />
    </>
  );
}

function ContentBody({
  children,
  routeId,
}: {
  children: ReactNode;
  routeId: string;
}) {
  if (
    (import.meta.env.DEV || __E2E_TEST_HOOKS__) &&
    typeof window !== "undefined" &&
    "__forceTabError" in window &&
    window.__forceTabError === routeId
  ) {
    throw new Error(`forced tab error: ${routeId}`);
  }
  return children;
}

/** Route-owned surface. Actions and drawers remain outside the failing body. */
function ChatLayoutContent({
  children,
  actions,
  drawer,
}: {
  children: ReactNode;
  actions?: ReactNode;
  drawer?: ReactNode;
}) {
  const layout = useChatLayoutContext();
  if (layout.isMobile && layout.mobileSurface !== "main") return null;

  const panel = (
    <Panel
      data-testid="main-panel"
      variant={layout.isMobile ? "plain" : "card"}
    >
      {!layout.isMobile && layout.contentOpen && (
        <Panel.Topbar>
          <Panel.Topbar.Left className="gap-0.5">
            <PanelCollapseToggle
              side="left"
              open={layout.threadOpen}
              onToggle={layout.toggleThread}
            />
            {layout.contentNavigation}
            <Panel.Topbar.Left.Target />
          </Panel.Topbar.Left>
          <Panel.Topbar.Center>
            <div className="flex min-w-0 items-center @max-sm/panel-header:hidden">
              <Panel.Topbar.Center.Target />
            </div>
          </Panel.Topbar.Center>
          <Panel.Topbar.Right>
            <Panel.Topbar.Right.Target />
            {layout.contentActions}
            {actions}
            <PanelCollapseToggle
              side="right"
              open={layout.contentOpen}
              onToggle={layout.toggleContent}
            />
          </Panel.Topbar.Right>
        </Panel.Topbar>
      )}
      <Panel.Content>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary key={layout.contentKey}>
            <MainPanelBoundary>
              <ContentBody routeId={layout.contentKey}>{children}</ContentBody>
            </MainPanelBoundary>
          </ErrorBoundary>
        </div>
        {drawer}
      </Panel.Content>
    </Panel>
  );

  return layout.isMobile ? (
    panel
  ) : (
    <ResizablePanel
      id={CONTENT_PANEL_ID}
      defaultSize="67%"
      minSize="20%"
      collapsible
      collapsedSize="0%"
      data-chat-layout-panel-open={layout.contentOpen ? "" : undefined}
      className="min-w-0 overflow-hidden bg-sidebar"
    >
      <div className="h-full min-h-0 p-0.5">{panel}</div>
    </ResizablePanel>
  );
}

/** Keeps navigation available while TanStack loads a destination's chunk. */
export function ChatLayoutPending() {
  return (
    <ChatLayoutContent>
      <PanelLoading />
    </ChatLayoutContent>
  );
}

/** Route validation and loading errors keep the content region and navigation mounted. */
export function ChatLayoutError({ error, reset }: ErrorComponentProps) {
  const t = useT();
  return (
    <ChatLayoutContent>
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center"
      >
        <h2 className="text-lg font-medium">
          {t("common.errorBoundary.somethingWentWrong")}
        </h2>
        <p className="max-w-lg whitespace-pre-wrap text-sm text-muted-foreground">
          {error.message || t("common.errorBoundary.unexpectedError")}
        </p>
        <Button variant="outline" onClick={reset}>
          {t("common.errorBoundary.tryAgain")}
        </Button>
      </div>
    </ChatLayoutContent>
  );
}

export const ChatLayout = Object.assign(ChatLayoutRoot, {
  Thread: ChatLayoutThread,
  Content: ChatLayoutContent,
});
