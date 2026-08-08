import { Page } from "@/components/page";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

interface ViewLayoutContextValue {
  leftEl: HTMLDivElement | null;
  tabsEl: HTMLDivElement | null;
  actionsEl: HTMLDivElement | null;
}

const ViewLayoutContext = createContext<ViewLayoutContextValue | null>(null);

interface PortalProps {
  children: ReactNode;
  icon?: string;
  title?: string;
}

export function ViewTabs({ children }: PortalProps) {
  const ctx = useContext(ViewLayoutContext);
  if (!ctx?.tabsEl) return null;
  return createPortal(children, ctx.tabsEl);
}

function HeaderRight({ children }: PortalProps) {
  const ctx = useContext(ViewLayoutContext);
  if (!ctx?.actionsEl) return null;
  return createPortal(children, ctx.actionsEl);
}

// Backward compat alias
export const ViewActions = HeaderRight;

interface ViewLayoutProps {
  children: ReactNode;
  breadcrumb?: ReactNode;
  hideHeader?: boolean;
}

export function ViewLayout({
  children,
  breadcrumb,
  hideHeader,
}: ViewLayoutProps) {
  const [slots, setSlots] = useState<{
    leftEl: HTMLDivElement | null;
    tabsEl: HTMLDivElement | null;
    actionsEl: HTMLDivElement | null;
  }>({ leftEl: null, tabsEl: null, actionsEl: null });

  // Track current values in refs to compare BEFORE calling setState
  // This prevents setState from being called during commit phase when value hasn't changed
  const leftElRef = useRef<HTMLDivElement | null>(null);
  const tabsElRef = useRef<HTMLDivElement | null>(null);
  const actionsElRef = useRef<HTMLDivElement | null>(null);

  // Only call setState when attaching (node !== null).
  // Calling setState with null during React's disappearLayoutEffects commit
  // phase causes an infinite "Maximum update depth exceeded" loop.
  // When the subtree is hidden, portals inside it are hidden too, so the
  // stale state value is harmless. On reappear, the ref fires again with
  // the real node.
  const leftRef = (node: HTMLDivElement | null) => {
    leftElRef.current = node;
    if (node) {
      setSlots((prev) =>
        prev.leftEl === node ? prev : { ...prev, leftEl: node },
      );
    }
  };

  const tabsRef = (node: HTMLDivElement | null) => {
    tabsElRef.current = node;
    if (node) {
      setSlots((prev) =>
        prev.tabsEl === node ? prev : { ...prev, tabsEl: node },
      );
    }
  };

  const actionsRef = (node: HTMLDivElement | null) => {
    actionsElRef.current = node;
    if (node) {
      setSlots((prev) =>
        prev.actionsEl === node ? prev : { ...prev, actionsEl: node },
      );
    }
  };

  return (
    <ViewLayoutContext value={slots}>
      <Page>
        {/* Header */}
        <Page.Header className={cn(hideHeader && "hidden")}>
          <Page.Header.Left>
            {breadcrumb}
            <div ref={leftRef} className="flex items-center gap-2 min-w-0" />
          </Page.Header.Left>

          {/* Tabs and Actions */}
          <Page.Header.Right>
            {/* Tabs Slot */}
            <div
              ref={tabsRef}
              className="flex items-center gap-2 overflow-x-auto min-w-0"
            />

            {/* Actions Slot */}
            <div
              ref={actionsRef}
              className="flex items-center gap-2 shrink-0"
            />
          </Page.Header.Right>
        </Page.Header>

        {/* Main Content */}
        <Page.Content>{children}</Page.Content>
      </Page>
    </ViewLayoutContext>
  );
}
