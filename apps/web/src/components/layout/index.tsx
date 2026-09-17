import { createContext, use, type ReactNode } from "react";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
  useSidebar,
} from "@decocms/ui/components/sidebar.tsx";
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@decocms/ui/components/sheet.tsx";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { Panel } from "@/components/panel";
import { LayoutLeft } from "@untitledui/icons";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useCompactPageLayout } from "@/hooks/use-preferences";
import { useInSettings } from "@/hooks/use-in-settings";
import { SidebarResizeHandle } from "@/components/sidebar/sidebar-resize-handle";
import { SidebarThreadButtonProvider } from "@/components/sidebar/thread-button";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useSidebarResize } from "@/hooks/use-sidebar-resize";
import { useT } from "@/i18n/use-t.ts";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

const LayoutContext = createContext<{
  isMobile: boolean;
  resize: ReturnType<typeof useSidebarResize>;
} | null>(null);

function useLayout() {
  const context = use(LayoutContext);
  if (!context) throw new Error("Layout regions require a Layout");
  return context;
}

/** Application frame shared by every destination, including settings. */
function LayoutRoot({
  children,
  notice,
}: {
  children: ReactNode;
  notice?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const compact = useCompactPageLayout();
  const inSettings = useInSettings();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    LOCALSTORAGE_KEYS.sidebarOpen(),
    true,
  );
  const resize = useSidebarResize();

  return (
    <LayoutContext value={{ isMobile, resize }}>
      <SidebarProvider
        open={(!compact && inSettings) || sidebarOpen}
        onOpenChange={setSidebarOpen}
      >
        <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
          {notice}
          <SidebarLayout
            ref={resize.wrapperRef}
            className="flex-1 bg-sidebar relative min-h-0"
            style={
              {
                "--sidebar-width": `${resize.width}px`,
                // The icon rail keeps its buttons the same size as the toolbar.
                "--sidebar-width-icon": compact ? "3.25rem" : "3.125rem",
              } as Record<string, string>
            }
          >
            <SidebarThreadButtonProvider>
              {children}
            </SidebarThreadButtonProvider>
          </SidebarLayout>
        </div>
      </SidebarProvider>
    </LayoutContext>
  );
}

function LayoutSidebar({
  children,
  renderMobile,
}: {
  children: ReactNode;
  renderMobile: (props: { onClose: () => void }) => ReactNode;
}) {
  const t = useT();
  const { isMobile, resize } = useLayout();
  const { openMobile, setOpenMobile } = useSidebar();

  if (!isMobile) {
    return (
      <>
        {children}
        <SidebarResizeHandle
          width={resize.width}
          minWidth={resize.minWidth}
          maxWidth={resize.maxWidth}
          onPointerDown={resize.onStartResize}
          onKeyDown={resize.onKeyDownResize}
          onDoubleClick={resize.resetWidth}
        />
      </>
    );
  }

  return (
    <Sheet open={openMobile} onOpenChange={setOpenMobile}>
      <SheetContent
        side="left"
        hideCloseButton
        className="w-screen max-w-none! p-0"
      >
        <SheetTitle className="sr-only">
          {t("layouts.shellControls.navigationTitle")}
        </SheetTitle>
        {renderMobile({ onClose: () => setOpenMobile(false) })}
      </SheetContent>
    </Sheet>
  );
}

function LayoutContent({ children }: { children: ReactNode }) {
  const compact = useCompactPageLayout();
  const t = useT();
  const { isMobile } = useLayout();
  const { toggleSidebar } = useSidebar();
  return (
    <SidebarInset
      className="flex flex-col min-h-0"
      style={{ background: "transparent", containerType: "inline-size" }}
    >
      <Panel variant="plain" className="bg-sidebar">
        {!compact && isMobile && (
          <Panel.Topbar className="px-1 bg-sidebar">
            <Panel.Topbar.Left className="shrink-0">
              <ToolbarIconButton
                onClick={toggleSidebar}
                aria-label={t("layouts.shellControls.toggleSidebar")}
              >
                <LayoutLeft size={16} />
              </ToolbarIconButton>
            </Panel.Topbar.Left>
            <Panel.Topbar.Center className="justify-start">
              <Panel.Topbar.Center.Target />
            </Panel.Topbar.Center>
          </Panel.Topbar>
        )}
        <div className="relative flex-1 min-h-0 flex flex-row">{children}</div>
      </Panel>
    </SidebarInset>
  );
}

export const Layout = Object.assign(LayoutRoot, {
  Sidebar: LayoutSidebar,
  Content: LayoutContent,
});
