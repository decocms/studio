import { cn } from "@deco/ui/lib/utils.ts";
import { Badge } from "@deco/ui/components/badge.tsx";

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
}

export function CollectionTabs({
  tabs,
  activeTab,
  onTabChange,
  className,
}: CollectionTabsProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 overflow-x-auto no-scrollbar",
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={cn(
              "h-7 px-2 text-sm rounded-lg border border-input transition-colors inline-flex gap-1.5 items-center",
              isActive && "bg-accent border-border text-foreground",
              !isActive &&
                "bg-transparent text-muted-foreground hover:border-border hover:bg-accent/50 hover:text-foreground",
            )}
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
          </button>
        );
      })}
    </div>
  );
}
