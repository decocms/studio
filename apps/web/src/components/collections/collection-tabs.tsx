import { Page } from "@/components/page";
import { Panel } from "@/components/panel";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Badge } from "@decocms/ui/components/badge.tsx";

export interface CollectionTab {
  id: string;
  label: string;
  count?: number;
}

export interface CollectionTabsProps {
  tabs: CollectionTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
  placement?: "inline" | "page";
}

export function CollectionTabs({
  tabs,
  activeTab,
  onTabChange,
  className,
  placement = "inline",
}: CollectionTabsProps) {
  const content = (
    <Page.Tabs className={className}>
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <Page.Tab
            key={tab.id}
            active={isActive}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
            {tab.count !== undefined && (
              <Badge
                variant="secondary"
                className={cn(
                  "h-5 min-w-5 px-1 rounded-full text-[10px] font-mono inline-flex items-center justify-center",
                  isActive
                    ? "bg-background text-foreground"
                    : "bg-muted-foreground/10 text-muted-foreground",
                )}
              >
                {tab.count}
              </Badge>
            )}
          </Page.Tab>
        );
      })}
    </Page.Tabs>
  );
  return placement === "page" ? (
    <Panel.Toolbar.Left.Portal fallback={content}>
      {content}
    </Panel.Toolbar.Left.Portal>
  ) : (
    content
  );
}
