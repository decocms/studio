import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, Box, LinkExternal01 } from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state";

const BLOCKS_DOCS_URL = "https://github.com/decocms/blocks";

export function BlocksEmptyState() {
  return (
    <EmptyState
      image={<Box size={48} className="text-muted-foreground" />}
      title="No editable Blocks found"
      description="This project does not expose editable Blocks content yet. Learn how to add Blocks to your project."
      actions={
        <Button variant="outline" size="sm" asChild>
          <a href={BLOCKS_DOCS_URL} target="_blank" rel="noreferrer">
            View Blocks docs
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
  const description =
    source === "sandbox"
      ? "The project preview could not start. Retry to make Blocks available."
      : "Studio could not load this project's Blocks metadata.";
  return (
    <EmptyState
      image={<AlertCircle size={48} className="text-muted-foreground" />}
      title="Blocks unavailable"
      description={description}
      actions={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    />
  );
}
