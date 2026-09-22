import { useCompactPageLayout } from "@/hooks/use-preferences";
import { useT } from "@/i18n/use-t.ts";
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

function CompactCollectionTabs({
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

function ClassicCollectionTabs({
  tabs,
  activeTab,
  onTabChange,
  className,
}: CollectionTabsProps) {
  const t = useT();
  return (
    <nav
      aria-label={t("collections.collectionTabs.tabList")}
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
            aria-pressed={isActive}
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
    </nav>
  );
}

export function CollectionTabs(props: CollectionTabsProps) {
  const compact = useCompactPageLayout();
  return compact ? (
    <CompactCollectionTabs {...props} />
  ) : (
    <ClassicCollectionTabs {...props} />
  );
}
