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

import {
  createContext,
  Suspense,
  use,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { DEFAULT_LOGO, usePublicConfig } from "@/hooks/use-public-config";

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

function ToolbarProviderImpl({ children }: { children?: ReactNode }) {
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
      {children}
    </ToolbarContext>
  );
}

export function Toolbar({ children }: { children?: ReactNode }) {
  return (
    <ToolbarProviderImpl>
      <div className="flex flex-col h-full min-h-0">{children}</div>
    </ToolbarProviderImpl>
  );
}

function ToolbarHeader({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative z-10 shrink-0 grid grid-cols-3 items-center pl-1 pr-2 h-12 bg-sidebar",
        className,
      )}
      {...props}
    >
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

function ToolbarLogoInner() {
  const t = useT();
  const config = usePublicConfig();
  const logo = config.logo ?? DEFAULT_LOGO;
  const lightSrc = typeof logo === "string" ? logo : logo.light;
  const darkSrc = typeof logo === "string" ? logo : logo.dark;
  return (
    <span className="flex items-center shrink-0 px-2">
      <img
        src={lightSrc}
        alt={t("agentShellLayout.toolbar.logo")}
        className="size-6 object-contain dark:hidden"
      />
      <img
        src={darkSrc}
        alt={t("agentShellLayout.toolbar.logo")}
        className="size-6 object-contain hidden dark:block"
      />
    </span>
  );
}

function ToolbarLogo() {
  return (
    <Suspense fallback={<span className="shrink-0 size-6 mx-2" />}>
      <ToolbarLogoInner />
    </Suspense>
  );
}

/**
 * The logo wrapped in a link back to the org home (`/$org`). Used as the
 * "home" affordance in the shell headers.
 */
function ToolbarLogoLink() {
  const t = useT();
  const { org } = useParams({ from: "/shell/$org" });
  return (
    <Link
      to="/$org"
      params={{ org }}
      aria-label={t("agentShellLayout.toolbar.backToHome")}
      title={t("agentShellLayout.toolbar.backToHome")}
      className="flex items-center shrink-0 cursor-pointer pl-1"
    >
      <ToolbarLogo />
    </Link>
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

function ToolbarTabsSlot({ className }: { className?: string }) {
  const { setTabsEl } = useToolbarCtx();
  return (
    <div
      ref={setTabsEl}
      className={cn("shrink-0 flex items-center", className)}
    />
  );
}

function ToolbarTabs({ children }: { children: ReactNode }) {
  const { tabsEl } = useToolbarCtx();
  if (!tabsEl) return null;
  return createPortal(children, tabsEl);
}

function ToolbarTogglesSlot({ className }: { className?: string }) {
  const { setTogglesEl } = useToolbarCtx();
  // `display: contents` keeps the div as a portal target (we need the
  // ref) but produces no layout box, so the toggle buttons become direct
  // flex children of Toolbar.LeftColumn and inherit its gap.
  return <div ref={setTogglesEl} className={cn("contents", className)} />;
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

Toolbar.Provider = ToolbarProviderImpl;
Toolbar.Header = ToolbarHeader;
Toolbar.LeftColumn = ToolbarLeftColumn;
Toolbar.RightColumn = ToolbarRightColumn;
Toolbar.Logo = ToolbarLogo;
Toolbar.LogoLink = ToolbarLogoLink;
Toolbar.CenterSlot = ToolbarCenterSlot;
Toolbar.Center = ToolbarCenter;
Toolbar.TabsSlot = ToolbarTabsSlot;
Toolbar.Tabs = ToolbarTabs;
Toolbar.TogglesSlot = ToolbarTogglesSlot;
Toolbar.RightSlot = ToolbarRightSlot;
