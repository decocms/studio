import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { EmptyState } from "../empty-state";
import { OPENROUTER_ICON_URL, OPENROUTER_MCP_URL } from "@/core/deco-constants";
import {
  getWellKnownOpenRouterConnection,
  ORG_ADMIN_PROJECT_SLUG,
  useConnectionActions,
  useConnections,
} from "@decocms/mesh-sdk";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { authClient } from "@/web/lib/auth-client";
import { authenticateConnection } from "@/web/lib/authenticate-connection";

interface NoLlmBindingEmptyStateProps {
  title?: string;
  description?: string;
  org: { slug: string; id: string };
}

/**
 * Empty state component shown when no LLM binding is available.
 * Includes OpenRouter installation logic and UI.
 */
export function NoLlmBindingEmptyState({
  title = "No model provider connected",
  description = "Connect to a model provider to unlock AI-powered features.",
  org,
}: NoLlmBindingEmptyStateProps) {
  const actions = useConnectionActions();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session } = authClient.useSession();
  const allConnections = useConnections();

  const userId = session?.user?.id ?? "";

  const handleInstallMcpServer = () => {
    navigate({
      to: "/$org/$project/mcps",
      params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      search: { action: "create" },
    });
  };

  const handleInstallOpenRouter = async () => {
    if (!org.id || !userId) {
      toast.error("Not authenticated");
      return;
    }

    try {
      // Check if OpenRouter already exists
      const existingConnection = allConnections?.find(
        (conn) => conn.connection_url === OPENROUTER_MCP_URL,
      );

      const connectionId = existingConnection?.id ?? null;

      if (!connectionId) {
        // Create new OpenRouter connection
        const connectionData = getWellKnownOpenRouterConnection({
          id: generatePrefixedId("conn"),
        });

        const result = await actions.create.mutateAsync(connectionData);

        // Immediately trigger OAuth auth — opens popup, stays on Home
        const success = await authenticateConnection(
          result.id,
          actions,
          queryClient,
        );
        if (success) {
          toast.success("OpenRouter connected successfully");
        }
      } else {
        // Connection exists but may not be authenticated — trigger auth
        const success = await authenticateConnection(
          connectionId,
          actions,
          queryClient,
        );
        if (success) {
          toast.success("OpenRouter authenticated successfully");
        }
      }
    } catch (error) {
      toast.error(
        `Failed to connect OpenRouter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return (
    <EmptyState
      image={
        <img
          src="/empty-state-openrouter.svg"
          alt=""
          width={336}
          height={320}
          aria-hidden="true"
          className="w-xs h-auto mask-radial-[100%_100%] mask-radial-from-20% mask-radial-to-50% mask-radial-at-center"
        />
      }
      title={title}
      description={description}
      actions={
        <>
          <Button
            variant="outline"
            onClick={handleInstallOpenRouter}
            disabled={actions.create.isPending}
          >
            <img
              src={OPENROUTER_ICON_URL}
              alt="OpenRouter"
              className="size-4"
            />
            {actions.create.isPending ? "Installing..." : "Install OpenRouter"}
          </Button>
          <Button variant="outline" onClick={handleInstallMcpServer}>
            Install Connection
          </Button>
        </>
      }
    />
  );
}
