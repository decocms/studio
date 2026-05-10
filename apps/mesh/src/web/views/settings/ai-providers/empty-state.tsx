import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "@/web/components/empty-state";

interface AiProvidersEmptyStateProps {
  onConnectClick: () => void;
}

export function AiProvidersEmptyState({
  onConnectClick,
}: AiProvidersEmptyStateProps) {
  return (
    <EmptyState
      title="No AI providers connected"
      description="Connect a provider to start using AI in your workspace."
      actions={<Button onClick={onConnectClick}>Connect provider</Button>}
    />
  );
}
