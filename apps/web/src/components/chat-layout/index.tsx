import type { ReactNode } from "react";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { createContext, isValidElement, use, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { Maximize01, Minimize01, XClose } from "@untitledui/icons";
import { Panel } from "@/components/panel";
import { Page } from "@/components/page";
import { SidebarThreadButtonPortal } from "@/components/sidebar/thread-button";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type GroupImperativeHandle,
} from "@/components/resizable";
import {
  computeChatLayoutPanelSizes,
  mobileSurfaceSearch,
  resolveMobileSurface,
  type ChatLayoutActions,
  type ChatLayoutState,
} from "@/hooks/use-chat-layout-state";
import { useSidePanelWidth } from "@/hooks/use-side-panel-width";
import { MainPanelBoundary, PanelLoading } from "@/layouts/main-panel-boundary";
import { useT } from "@/i18n/use-t";
import { RoutePageHeader } from "@/layouts/route-page-header";

const THREAD_PANEL_ID = "chat-layout-thread";
const CONTENT_PANEL_ID = "chat-layout-content";
const PANEL_MIN_SIZE = "320px";

interface ChatLayoutProps extends ChatLayoutState, ChatLayoutActions {
  children: ReactNode;
  /** Route identity resets a failed content body when navigation changes. */
  contentKey: string;
  contentNavigation?: ReactNode;
  /** No chat behind this layout (the account-less `/site-editor`): the thread
   *  stays closed and nothing offers to open it. */
  threadless?: boolean;
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

/** Null outside a ChatLayout (e.g. the settings route), rather than throwing —
 *  for callers that render in both. */
export function useOptionalChatLayout():
  | (ChatLayoutState & ChatLayoutActions & { threadless?: boolean })
  | null {
  return use(ChatLayoutContext);
}

function useChatLayoutContext() {
  const layout = use(ChatLayoutContext);
  if (!layout) throw new Error("ChatLayout regions require a ChatLayout");
  return layout;
}

/** Places the thread beside routed content, or selects one region on mobile. */
function ChatLayoutRoot({ children, ...layout }: ChatLayoutProps) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const [threadWidth, setThreadWidth] = useSidePanelWidth();
  const { threadOpen, contentOpen } = layout;
  const sizes = computeChatLayoutPanelSizes(layout);
  const threadSize = threadOpen && contentOpen ? threadWidth : sizes.side;
  const contentSize = 100 - threadSize;
  const synchronizeLayout = (group: GroupImperativeHandle) => {
    const current = group.getLayout();
    const currentThreadSize = current[THREAD_PANEL_ID];
    const currentContentSize = current[CONTENT_PANEL_ID];
    // A lazy destination can register its content panel after the thread panel.
    if (
      typeof currentThreadSize !== "number" ||
      typeof currentContentSize !== "number"
    ) {
      return;
    }
    // The library rounds panel percentages to three decimal places.
    if (
      Math.abs(currentThreadSize - threadSize) < 0.001 &&
      Math.abs(currentContentSize - contentSize) < 0.001
    ) {
      return;
    }
    group.setLayout({
      [THREAD_PANEL_ID]: threadSize,
      [CONTENT_PANEL_ID]: contentSize,
    });
  };
  const value = {
    ...layout,
    isMobile,
    mobileSurface: resolveMobileSurface(layout),
  };

  return (
    <ChatLayoutContext value={value}>
      {isMobile && !layout.threadless && (
        <SidebarThreadButtonPortal
          open={value.mobileSurface === "chat"}
          onToggle={() => {
            void navigate({
              to: ".",
              search: (prev) => ({
                ...prev,
                ...mobileSurfaceSearch(
                  value.mobileSurface === "chat" ? "main" : "chat",
                ),
              }),
              replace: true,
            });
          }}
        />
      )}
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
            groupRef.current = group;
            if (!group) return;
            let attached = true;
            // The library registers the group after attaching its imperative ref.
            queueMicrotask(() => {
              if (attached) synchronizeLayout(group);
            });
            return () => {
              attached = false;
              if (groupRef.current === group) groupRef.current = null;
            };
          }}
          defaultLayout={{
            [THREAD_PANEL_ID]: threadSize,
            [CONTENT_PANEL_ID]: contentSize,
          }}
          orientation="horizontal"
          data-slot="chat-layout"
          className="flex-1 min-h-0 pt-1 pb-1 pr-1 pl-0"
          style={{ overflow: "visible" }}
          onLayoutChanged={(nextLayout, { isUserInteraction }) => {
            if (!isUserInteraction) {
              const group = groupRef.current;
              if (group) synchronizeLayout(group);
              return;
            }
            const percentage = nextLayout[THREAD_PANEL_ID];
            if (
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
        {topbar}
        <Panel.Content data-testid="chat-panel">{children}</Panel.Content>
      </Panel>
    ) : null;
  }

  // Full screen unmounts the chat panel, so no drag can ever close it.
  if (!layout.threadOpen) return null;

  return (
    <>
      {layout.contentOpen && <ResizableHandle className="bg-sidebar" />}
      <ResizablePanel
        id={THREAD_PANEL_ID}
        defaultSize="33%"
        minSize={PANEL_MIN_SIZE}
        className="min-w-0 overflow-hidden bg-sidebar"
      >
        <div className="h-full min-h-0 p-0.5">
          <Panel data-testid="side-panel">
            {topbar}
            <Panel.Content data-testid="chat-panel">{children}</Panel.Content>
          </Panel>
        </div>
      </ResizablePanel>
    </>
  );
}

function LayoutButton({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
        >
          {children}
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Like an artifact: expand over the chat, or close back into it. */
function MainPanelControls() {
  const t = useT();
  const layout = useChatLayoutContext();
  if (layout.isMobile || layout.threadless) return null;
  const expanded = !layout.threadOpen;
  return (
    <div className="flex items-center gap-0.5">
      {/* Window controls sit apart from the page's own actions. */}
      <span aria-hidden className="mr-1.5 h-4 w-px shrink-0 bg-border" />
      {/* Labeled once expanded: it is the only way back to the chat. */}
      {expanded ? (
        <Button
          variant="ghost"
          size="sm"
          aria-pressed
          className="h-7 gap-1.5 px-2 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          onClick={layout.toggleFullscreen}
        >
          <Minimize01 size={16} />
          {t("page.exitFullscreen")}
        </Button>
      ) : (
        <LayoutButton
          label={t("page.enterFullscreen")}
          onClick={layout.toggleFullscreen}
        >
          <Maximize01 size={16} />
        </LayoutButton>
      )}
      <LayoutButton
        label={t("page.closeMainPanel")}
        onClick={layout.toggleContent}
      >
        <XClose size={16} />
      </LayoutButton>
    </div>
  );
}

/** The chat never closes, so a closed main panel reopens from its header. */
export function OpenMainPanelButton() {
  const t = useT();
  const isMobile = useIsMobile();
  const layout = useOptionalChatLayout();
  if (isMobile || !layout || layout.threadless || layout.contentOpen) {
    return null;
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        onClick={layout.toggleContent}
      >
        <PanelOpenIcon />
        {t("page.openMainPanel")}
      </Button>
      <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
    </>
  );
}

/** A bar with an arrow leaving it: the panel slides out from the left. */
function PanelOpenIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M4 5v14M8 12h12m0 0-6-6m6 6-6 6" />
    </svg>
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
  aside,
}: {
  children: ReactNode;
  actions?: ReactNode;
  drawer?: ReactNode;
  /** A second surface beside this one, such as a file preview. Desktop only:
   *  on mobile the route shows it its own way. */
  aside?: ReactNode;
}) {
  const layout = useChatLayoutContext();

  if (layout.isMobile && layout.mobileSurface !== "main") return null;

  const panel = (
    <Panel
      data-testid="main-panel"
      variant={layout.isMobile ? "plain" : "card"}
    >
      <Page.Breadcrumbs.Provider>
        <RoutePageHeader
          navigation={layout.contentNavigation}
          actions={actions}
          trailingActions={<MainPanelControls />}
        />
        <Panel.Content>
          <div className="min-h-0 flex-1 overflow-hidden">
            <ErrorBoundary key={layout.contentKey}>
              <MainPanelBoundary>
                <ContentBody routeId={layout.contentKey}>
                  {children}
                </ContentBody>
              </MainPanelBoundary>
            </ErrorBoundary>
          </div>
          {drawer}
        </Panel.Content>
      </Page.Breadcrumbs.Provider>
    </Panel>
  );

  if (layout.isMobile) return panel;
  if (!layout.contentOpen) return null;

  return (
    <ResizablePanel
      id={CONTENT_PANEL_ID}
      defaultSize="67%"
      minSize={PANEL_MIN_SIZE}
      className="min-w-0 overflow-hidden bg-sidebar"
    >
      {/* Flex, not a nested resizable group: that one sized itself after
          mount, so a page loading in flashed its loader in a sliver. */}
      <div className="flex h-full min-h-0">
        <div className="h-full min-h-0 min-w-0 flex-1 p-0.5">{panel}</div>
        {aside && (
          <div className="h-full min-h-0 w-[42%] min-w-80 shrink-0 p-0.5">
            <Panel data-testid="aside-panel">
              {/* Keyed like the aside itself, so opening another file clears
                  a previous one's failure. */}
              <ErrorBoundary
                key={
                  isValidElement(aside) ? (aside.key ?? undefined) : undefined
                }
              >
                <MainPanelBoundary>{aside}</MainPanelBoundary>
              </ErrorBoundary>
            </Panel>
          </div>
        )}
      </div>
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
