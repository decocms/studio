import { createContext, use, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSidebar } from "@decocms/ui/components/sidebar.tsx";
import { mobileSurfaceSearch } from "@/hooks/use-chat-layout-state";
import { MessageCircle01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { ToolbarIconButton } from "@/components/toolbar-icon-button";
import { useInSettings } from "@/hooks/use-in-settings";
import { useT } from "@/i18n/use-t";
import { usePanelActions } from "@/layouts/shell-layout";
import { useProjectContext } from "@/sdk";

const ThreadButtonSlotContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
} | null>(null);

export function SidebarThreadButtonProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <ThreadButtonSlotContext value={{ target, setTarget }}>
      {children}
    </ThreadButtonSlotContext>
  );
}

function useThreadButtonSlot() {
  const slot = use(ThreadButtonSlotContext);
  if (!slot) throw new Error("Sidebar thread controls require a Layout");
  return slot;
}

function ThreadButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { isMobile, setOpenMobile } = useSidebar();
  const label = t(open ? "page.closeThread" : "page.openThread");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label={label}
          aria-pressed={open}
          active={open}
          className="size-7 shrink-0 group-data-[state=collapsed]/sidebar:mx-auto group-data-[state=collapsed]/sidebar:size-8"
          onClick={() => {
            onToggle();
            if (isMobile) setOpenMobile(false);
          }}
        >
          <MessageCircle01 size={16} />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/** The chat layout owns visibility; its control renders in the shared sidebar. */
export function SidebarThreadButtonPortal(props: {
  open: boolean;
  onToggle: () => void;
}) {
  const slot = use(ThreadButtonSlotContext);
  return slot?.target
    ? createPortal(<ThreadButton {...props} />, slot.target)
    : null;
}

/** Settings and pending routes can open chat before a ChatLayout is mounted. */
export function SidebarThreadButton() {
  const { setTarget } = useThreadButtonSlot();
  const inSettings = useInSettings();
  const { isMobile } = useSidebar();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { openSidePanel } = usePanelActions();
  return (
    <>
      <div
        ref={setTarget}
        className="peer/thread-button contents empty:hidden"
      />
      <div className="hidden peer-empty/thread-button:contents">
        <ThreadButton
          open={false}
          onToggle={() => {
            if (inSettings) {
              void navigate({
                to: "/$org/home",
                params: { org: org.slug },
                search: { sidepanel: true, mainpanel: !isMobile },
              });
            } else if (isMobile) {
              void navigate({
                to: ".",
                search: (prev) => ({ ...prev, ...mobileSurfaceSearch("chat") }),
                replace: true,
              });
            } else {
              void openSidePanel();
            }
          }}
        />
      </div>
    </>
  );
}
