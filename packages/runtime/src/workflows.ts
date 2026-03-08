import type { Step } from "@decocms/bindings/workflow";
import type { MCPConnection } from "./connection.ts";
import { MCPClient } from "./mcp.ts";

/**
 * Declarative workflow definition for MCP servers.
 * Workflows declared here are automatically synced to the mesh
 * as workflow_collection entries during ON_MCP_CONFIGURATION.
 */
export interface WorkflowDefinition {
  title: string;
  description?: string;
  virtual_mcp_id?: string;
  steps: Step[];
}

interface WorkflowCollectionItem {
  id: string;
  title: string;
  description: string | null;
  virtual_mcp_id: string;
  created_at: string;
  updated_at: string;
}

interface MeshWorkflowClient {
  COLLECTION_WORKFLOW_LIST: (input: {
    limit?: number;
    offset?: number;
  }) => Promise<{
    items: WorkflowCollectionItem[];
    totalCount: number;
    hasMore: boolean;
  }>;
  COLLECTION_WORKFLOW_CREATE: (input: {
    data: {
      id: string;
      title: string;
      description?: string;
      virtual_mcp_id?: string;
      steps: Step[];
    };
  }) => Promise<{ item: WorkflowCollectionItem }>;
  COLLECTION_WORKFLOW_UPDATE: (input: {
    id: string;
    data: {
      title?: string;
      description?: string;
      virtual_mcp_id?: string;
      steps?: Step[];
    };
  }) => Promise<{ success: boolean; error?: string }>;
  COLLECTION_WORKFLOW_DELETE: (input: {
    id: string;
  }) => Promise<{ success: boolean; error?: string }>;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function workflowId(connectionId: string, title: string): string {
  return `${connectionId}::${slugify(title)}`;
}

function createMeshSelfClient(
  meshUrl: string,
  token?: string,
): MeshWorkflowClient {
  const headers: Record<string, string> = {};
  if (token) {
    headers["x-mesh-token"] = token;
  }

  const connection: MCPConnection = {
    type: "HTTP",
    url: new URL("/mcp/self", meshUrl).href,
    token,
    headers,
  };

  return MCPClient.forConnection(connection) as unknown as MeshWorkflowClient;
}

export async function syncWorkflows(
  declared: WorkflowDefinition[],
  meshUrl: string,
  connectionId: string,
  token?: string,
): Promise<void> {
  if (declared.length === 0) return;

  const titles = declared.map((w) => w.title);
  const uniqueTitles = new Set(titles);
  if (uniqueTitles.size !== titles.length) {
    const duplicates = titles.filter((t, i) => titles.indexOf(t) !== i);
    console.warn(
      `[Workflows] Duplicate workflow titles found: ${[...new Set(duplicates)].join(", ")}. Skipping sync.`,
    );
    return;
  }

  const client = createMeshSelfClient(meshUrl, token);

  let existing: WorkflowCollectionItem[];
  try {
    const result = await client.COLLECTION_WORKFLOW_LIST({
      limit: 1000,
      offset: 0,
    });
    existing = result.items;
  } catch {
    console.warn(
      "[Workflows] Could not list workflows. The workflows plugin may not be enabled. Skipping sync.",
    );
    return;
  }

  const prefix = `${connectionId}::`;
  const managed = new Map(
    existing.filter((w) => w.id.startsWith(prefix)).map((w) => [w.id, w]),
  );

  const declaredIds = new Set<string>();

  for (const wf of declared) {
    const id = workflowId(connectionId, wf.title);
    declaredIds.add(id);

    try {
      if (managed.has(id)) {
        await client.COLLECTION_WORKFLOW_UPDATE({
          id,
          data: {
            title: wf.title,
            description: wf.description,
            steps: wf.steps,
          },
        });
      } else {
        await client.COLLECTION_WORKFLOW_CREATE({
          data: {
            id,
            title: wf.title,
            description: wf.description,
            steps: wf.steps,
          },
        });
      }
    } catch (error) {
      console.warn(
        `[Workflows] Failed to sync workflow "${wf.title}":`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  for (const [id] of managed) {
    if (!declaredIds.has(id)) {
      try {
        await client.COLLECTION_WORKFLOW_DELETE({ id });
      } catch (error) {
        console.warn(
          `[Workflows] Failed to delete orphaned workflow "${id}":`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }
}

export const Workflow = {
  sync: syncWorkflows,
  slugify,
  workflowId,
};
