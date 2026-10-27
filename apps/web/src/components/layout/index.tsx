import type { ReactNode } from "react";
import { createContext, use } from "react";
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
import { useProjectFirstNav } from "@/hooks/use-preferences";
import { OpenAppRecorder, OrgRail } from "@/components/sidebar/org-rail";
import { SidebarResizeHandle } from "@/components/sidebar/sidebar-resize-handle";
import { SidebarThreadButtonProvider } from "@/components/sidebar/thread-button";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
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
  outsideOrg,
}: {
  children: ReactNode;
  notice?: ReactNode;
  /** Outside any org (`/site-editor`): no org apps to record, and the org
   *  rail only when `rail` (a signed-in person, whose orgs it lists). */
  outsideOrg?: { rail: boolean };
}) {
  const isMobile = useIsMobile();

  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    LOCALSTORAGE_KEYS.sidebarOpen(),
    true,
  );
  const resize = useSidebarResize();
  const projectFirstNav = useProjectFirstNav();

  return (
    <LayoutContext value={{ isMobile, resize }}>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
          {notice}
          <div className="flex flex-1 flex-row min-h-0">
            {projectFirstNav && !outsideOrg && <OpenAppRecorder />}
            {!isMobile && projectFirstNav && (outsideOrg?.rail ?? true) && (
              <OrgRail />
            )}
            <SidebarLayout
              ref={resize.wrapperRef}
              className="flex-1 bg-sidebar relative min-h-0"
              style={
                {
                  "--sidebar-width": `${resize.width}px`,
                  // Project-first collapses all the way: the org rail is the icon rail.
                  "--sidebar-width-icon": projectFirstNav ? "0px" : "3.125rem",
                } as Record<string, string>
              }
            >
              <SidebarThreadButtonProvider>
                {children}
              </SidebarThreadButtonProvider>
            </SidebarLayout>
          </div>
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
  const collapsed = useSidebarCollapsed();
  const projectFirstNav = useProjectFirstNav();
  const close = () => setOpenMobile(false);

  if (!isMobile) {
    return (
      <>
        {/* Project-first collapses to zero width: clipped, but still tabbable. */}
        <div className="contents" inert={projectFirstNav && collapsed}>
          {children}
        </div>
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
        /* Focusing the first control would pop its tooltip over the header. */
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <SheetTitle className="sr-only">
          {t("layouts.shellControls.navigationTitle")}
        </SheetTitle>
        <div className="flex h-full min-h-0">
          {projectFirstNav && <OrgRail onNavigate={close} />}
          <div className="min-w-0 flex-1">
            {renderMobile({ onClose: close })}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function LayoutContent({ children }: { children: ReactNode }) {
  return (
    <SidebarInset
      className="flex flex-col min-h-0"
      style={{ background: "transparent", containerType: "inline-size" }}
    >
      <Panel variant="plain" className="bg-sidebar">
        <div className="relative flex-1 min-h-0 flex flex-row">{children}</div>
      </Panel>
    </SidebarInset>
  );
}

export const Layout = Object.assign(LayoutRoot, {
  Sidebar: LayoutSidebar,
  Content: LayoutContent,
});
