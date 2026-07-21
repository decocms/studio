import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, Box, LinkExternal01 } from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state";
import { useT } from "@/web/i18n/use-t.ts";

const BLOCKS_DOCS_URL = "https://github.com/decocms/blocks";

export function BlocksEmptyState() {
  const t = useT();
  return (
    <EmptyState
      className="h-full w-full"
      image={<Box size={48} className="text-muted-foreground" />}
      title={t("mainPanelTabs.blocksTabStates.emptyStateTitle")}
      description={t("mainPanelTabs.blocksTabStates.emptyStateDescription")}
      actions={
        <Button size="sm" asChild>
          <a href={BLOCKS_DOCS_URL} target="_blank" rel="noreferrer">
            {t("mainPanelTabs.blocksTabStates.setupContentEditing")}
            <LinkExternal01 size={14} />
          </a>
        </Button>
      }
    />
  );
}

export function BlocksErrorState({
  source,
  onRetry,
}: {
  source: "sandbox" | "data";
  onRetry: () => void;
}) {
  const t = useT();
  const description =
    source === "sandbox"
      ? t("mainPanelTabs.blocksTabStates.errorStateSandbox")
      : t("mainPanelTabs.blocksTabStates.errorStateData");
  return (
    <EmptyState
      image={<AlertCircle size={48} className="text-muted-foreground" />}
      title={t("mainPanelTabs.blocksTabStates.errorStateTitle")}
      description={description}
      actions={
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("mainPanelTabs.blocksTabStates.retry")}
        </Button>
      }
    />
  );
}
