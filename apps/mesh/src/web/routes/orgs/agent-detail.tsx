import { VirtualMcpDetailView } from "@/web/components/details/virtual-mcp";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { Loading01 } from "@untitledui/icons";
import { useParams } from "@tanstack/react-router";
import { Suspense } from "react";

function AgentDetailContent() {
  const { agentId } = useParams({ from: "/shell/$org/agents/$agentId" });
  return <VirtualMcpDetailView virtualMcpId={agentId} variant="agent" />;
}

export default function AgentDetailPage() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-background">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <AgentDetailContent />
      </Suspense>
    </ErrorBoundary>
  );
}
