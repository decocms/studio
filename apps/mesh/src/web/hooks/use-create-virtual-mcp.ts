/**
 * Hook to create a new virtual MCP (agent).
 * Provides inline virtual MCP creation with optional navigation.
 */

import { useNavigate } from "@tanstack/react-router";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  useVirtualMCPActions,
  type VirtualMCPEntity,
} from "@decocms/mesh-sdk";

interface CreateVirtualMCPResult {
  id: string;
  virtualMcp: VirtualMCPEntity;
}

interface UseCreateVirtualMCPOptions {
  /** If true, automatically navigate to virtual MCP settings after creation */
  navigateOnCreate?: boolean;
}

interface UseCreateVirtualMCPResult {
  /**
   * Create a new virtual MCP with default values.
   * Returns the new virtual MCP data if successful.
   */
  createVirtualMCP: () => Promise<CreateVirtualMCPResult>;
  /**
   * Whether a creation is in progress
   */
  isCreating: boolean;
}

/**
 * Hook that provides inline virtual MCP creation.
 * Use this when you want to create a virtual MCP, optionally navigating to its settings page.
 */
export function useCreateVirtualMCP(
  options: UseCreateVirtualMCPOptions = {},
): UseCreateVirtualMCPResult {
  const { navigateOnCreate = false } = options;
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const actions = useVirtualMCPActions();

  const createVirtualMCP = async (): Promise<CreateVirtualMCPResult> => {
    const virtualMcp = await actions.create.mutateAsync({
      title: "New Agent",
      description: "AI-driven assistant designed to handle specific tasks",
      status: "active",
      connections: [],
    });

    if (navigateOnCreate) {
      navigate({
        to: "/$org/$project/agents/$agentId",
        params: {
          org: org.slug,
          project: ORG_ADMIN_PROJECT_SLUG,
          agentId: virtualMcp.id,
        },
      });
    }

    return { id: virtualMcp.id!, virtualMcp }; // ID is guaranteed to be non-null for created virtual MCPs
  };

  return {
    createVirtualMCP,
    isCreating: actions.create.isPending,
  };
}
