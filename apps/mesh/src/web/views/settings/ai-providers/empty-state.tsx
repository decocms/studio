import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";
import { useDecoConnect } from "./use-deco-connect";

interface AiProvidersEmptyStateProps {
  onAddKeysClick: () => void;
}

export function AiProvidersEmptyState({
  onAddKeysClick,
}: AiProvidersEmptyStateProps) {
  const { mutate: connectDeco, isPending: isConnectingDeco } = useDecoConnect();

  return (
    <EmptyState
      title="No AI providers connected"
      description="Add API keys or sign in to a provider to start using AI in your workspace."
      actionsClassName="flex-col gap-2"
      actions={
        <>
          <Button onClick={onAddKeysClick}>Add API keys</Button>
          <Button
            variant="outline"
            disabled={isConnectingDeco}
            onClick={() => connectDeco()}
          >
            {isConnectingDeco ? "Connecting…" : "Connect Deco (Recommended)"}
          </Button>
        </>
      }
    />
  );
}
