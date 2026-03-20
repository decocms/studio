import { useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  AlertTriangle,
  Container,
  LayoutLeft,
  Settings01,
  Zap,
} from "@untitledui/icons";
import type { ReactNode } from "react";

export const SETTINGS_ITEMS: Array<{
  key: string;
  label: string;
  icon: ReactNode;
}> = [
  { key: "general", label: "General", icon: <Settings01 size={14} /> },
  { key: "dependencies", label: "Connections", icon: <Container size={14} /> },
  { key: "sidebar", label: "Sidebar", icon: <LayoutLeft size={14} /> },
  { key: "plugins", label: "Features", icon: <Zap size={14} /> },
  {
    key: "danger",
    label: "Danger Zone",
    icon: <AlertTriangle size={14} />,
  },
];

export function ProjectSettingsSidebar({
  onNavigate,
}: {
  onNavigate?: (key: string) => void;
}) {
  const { location } = useRouterState();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as {
    org: string;
    virtualMcpId: string;
  };

  const handleNavigate = (key: string) => {
    const href = `/${params.org}/p/${params.virtualMcpId}/settings/${key}`;
    navigate({ href });
    onNavigate?.(key);
  };

  return (
    <div className="w-full sm:w-52 shrink-0 sm:border-r border-border bg-sidebar/50 overflow-y-auto py-3 flex flex-col gap-0.5 px-2 flex-1">
      {SETTINGS_ITEMS.map((item) => {
        const isActive = location.pathname.endsWith(`/settings/${item.key}`);

        return (
          <button
            key={item.key}
            type="button"
            onClick={() => handleNavigate(item.key)}
            className={cn(
              "flex items-center gap-2.5 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors",
              isActive
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <span className="shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
