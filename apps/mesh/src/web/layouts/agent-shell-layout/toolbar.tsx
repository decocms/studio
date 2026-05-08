/**
 * Toolbar — vertical shell containing a fixed header row plus a body slot.
 *
 * The header is a 3-column grid (1fr 1fr 1fr) so the center column is always
 * centered relative to the screen regardless of left/right content widths.
 *
 * Portal targets:
 *   - Toolbar.CenterSlot    — contextual label (e.g. virtual MCP icon + title)
 *   - Toolbar.TabsSlot      — main-panel tab bar (scrollable)
 *   - Toolbar.TogglesSlot   — tasks/chat toggle buttons
 *   - Toolbar.RightSlot     — right-side actions (e.g. Create PR)
 *
 * Consumers render into the slots via <Toolbar.Center> / <Toolbar.Tabs> /
 * <Toolbar.Toggles> / <Toolbar.Right> (createPortal). Never suspends itself.
 */

import { createContext, use, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "@untitledui/icons";

type ToolbarCtx = {
  togglesEl: HTMLDivElement | null;
  setTogglesEl: (el: HTMLDivElement | null) => void;
  tabsEl: HTMLDivElement | null;
  setTabsEl: (el: HTMLDivElement | null) => void;
  centerEl: HTMLDivElement | null;
  setCenterEl: (el: HTMLDivElement | null) => void;
  rightEl: HTMLDivElement | null;
  setRightEl: (el: HTMLDivElement | null) => void;
};

const ToolbarContext = createContext<ToolbarCtx | null>(null);

function useToolbarCtx(): ToolbarCtx {
  const ctx = use(ToolbarContext);
  if (!ctx) throw new Error("Toolbar.* must be used inside <Toolbar>");
  return ctx;
}

export function Toolbar({ children }: { children?: ReactNode }) {
  const [togglesEl, setTogglesEl] = useState<HTMLDivElement | null>(null);
  const [tabsEl, setTabsEl] = useState<HTMLDivElement | null>(null);
  const [centerEl, setCenterEl] = useState<HTMLDivElement | null>(null);
  const [rightEl, setRightEl] = useState<HTMLDivElement | null>(null);
  return (
    <ToolbarContext
      value={{
        togglesEl,
        setTogglesEl,
        tabsEl,
        setTabsEl,
        centerEl,
        setCenterEl,
        rightEl,
        setRightEl,
      }}
    >
      <div className="flex flex-col h-full min-h-0">{children}</div>
    </ToolbarContext>
  );
}

function ToolbarHeader({ children }: { children?: ReactNode }) {
  return (
    <div className="shrink-0 grid grid-cols-3 items-center pl-1 pr-2 pt-0.25 h-12">
      {children}
    </div>
  );
}

function ToolbarLeftColumn({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 min-w-0 justify-self-start">
      {children}
    </div>
  );
}

function ToolbarRightColumn({ children }: { children?: ReactNode }) {
  return (
    <div className="flex items-center justify-end gap-0.5 min-w-0 justify-self-end">
      {children}
    </div>
  );
}

function ToolbarNav() {
  return (
    <>
      <button
        type="button"
        onClick={() => window.history.back()}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        title="Go back"
      >
        <ChevronLeft size={16} />
      </button>
      <button
        type="button"
        onClick={() => window.history.forward()}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-foreground transition-colors"
        title="Go forward"
      >
        <ChevronRight size={16} />
      </button>
    </>
  );
}

function ToolbarCenterSlot() {
  const { setCenterEl } = useToolbarCtx();
  return (
    <div
      ref={setCenterEl}
      className="min-w-0 flex items-center justify-center gap-2"
    />
  );
}

function ToolbarCenter({ children }: { children: ReactNode }) {
  const { centerEl } = useToolbarCtx();
  if (!centerEl) return null;
  return createPortal(children, centerEl);
}

function ToolbarTabsSlot() {
  const { setTabsEl } = useToolbarCtx();
  return <div ref={setTabsEl} className="shrink-0 flex items-center" />;
}

function ToolbarTabs({ children }: { children: ReactNode }) {
  const { tabsEl } = useToolbarCtx();
  if (!tabsEl) return null;
  return createPortal(children, tabsEl);
}

function ToolbarTogglesSlot() {
  const { setTogglesEl } = useToolbarCtx();
  return (
    <div
      ref={setTogglesEl}
      className="flex items-center gap-0.5 shrink-0 ml-0.5"
    />
  );
}

function ToolbarToggles({ children }: { children: ReactNode }) {
  const { togglesEl } = useToolbarCtx();
  if (!togglesEl) return null;
  return createPortal(children, togglesEl);
}

function ToolbarRightSlot() {
  const { setRightEl } = useToolbarCtx();
  return (
    <div
      ref={setRightEl}
      className="flex items-center justify-end gap-0.5 shrink-0"
    />
  );
}

function ToolbarRight({ children }: { children: ReactNode }) {
  const { rightEl } = useToolbarCtx();
  if (!rightEl) return null;
  return createPortal(children, rightEl);
}

Toolbar.Header = ToolbarHeader;
Toolbar.LeftColumn = ToolbarLeftColumn;
Toolbar.RightColumn = ToolbarRightColumn;
Toolbar.Nav = ToolbarNav;
Toolbar.CenterSlot = ToolbarCenterSlot;
Toolbar.Center = ToolbarCenter;
Toolbar.TabsSlot = ToolbarTabsSlot;
Toolbar.Tabs = ToolbarTabs;
Toolbar.TogglesSlot = ToolbarTogglesSlot;
Toolbar.Toggles = ToolbarToggles;
Toolbar.RightSlot = ToolbarRightSlot;
Toolbar.Right = ToolbarRight;
