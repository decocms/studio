import { Button } from "@deco/ui/components/button.tsx";
import { AlertCircle, Box, LinkExternal01 } from "@untitledui/icons";
import { EmptyState } from "@/web/components/empty-state";

const BLOCKS_DOCS_URL = "https://github.com/decocms/blocks";

export function BlocksEmptyState() {
  return (
    <EmptyState
      className="h-full w-full"
      image={<Box size={48} className="text-muted-foreground" />}
      title="Want to edit this website with easy-to-use forms?"
      description="Set up rich content editing so anyone can update pages without touching code."
      actions={
        <Button size="sm" asChild>
          <a href={BLOCKS_DOCS_URL} target="_blank" rel="noreferrer">
            Set up content editing
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
