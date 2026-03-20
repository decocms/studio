/**
 * Context Repo Tool Definitions
 *
 * Provides MCP-compatible tool metadata and execution for GITHUB connections.
 * Used by the passthrough client to expose context-repo tools without MCP transport.
 */

import type { Tool as MCPTool } from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "@/core/mesh-context";

// Lazy imports to avoid circular dependencies
async function getTools() {
  const { CONTEXT_REPO_SEARCH } = await import("./search");
  const { CONTEXT_REPO_READ } = await import("./read");
  const { CONTEXT_REPO_LIST_SKILLS } = await import("./list-skills");
  const { CONTEXT_REPO_SYNC } = await import("./sync");
  const { CONTEXT_REPO_STATUS } = await import("./status");
  const { CONTEXT_ISSUE_CREATE } = await import("./issue-create");
  const { CONTEXT_ISSUE_LIST } = await import("./issue-list");
  const { CONTEXT_ISSUE_GET } = await import("./issue-get");
  const { CONTEXT_ISSUE_COMMENT } = await import("./issue-comment");
  const { CONTEXT_AGENT_SAVE } = await import("./agent-save");
  return {
    CONTEXT_REPO_SEARCH,
    CONTEXT_REPO_READ,
    CONTEXT_REPO_LIST_SKILLS,
    CONTEXT_REPO_SYNC,
    CONTEXT_REPO_STATUS,
    CONTEXT_ISSUE_CREATE,
    CONTEXT_ISSUE_LIST,
    CONTEXT_ISSUE_GET,
    CONTEXT_ISSUE_COMMENT,
    CONTEXT_AGENT_SAVE,
  };
}

/**
 * Get MCP-compatible tool definitions for context-repo tools.
 * These are injected into the passthrough client's tool list for GITHUB connections.
 */
export function getContextRepoTools(): MCPTool[] {
  // We need synchronous access, so use a static list of tool metadata.
  // This avoids importing the actual tool modules (which have heavy deps).
  return [
    {
      name: "CONTEXT_REPO_SEARCH",
      description:
        "Full-text search across all indexed files in the context repository.",
      inputSchema: {
        type: "object" as const,
        properties: {
          query: { type: "string", description: "Search query" },
          limit: {
            type: "number",
            description: "Max results (default 20)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "CONTEXT_REPO_READ",
      description: "Read a file from the context repository by path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: {
            type: "string",
            description: "File path relative to repo root",
          },
        },
        required: ["path"],
      },
    },
    {
      name: "CONTEXT_REPO_LIST_SKILLS",
      description:
        "List available skills from the skills/ directory in the context repository.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "CONTEXT_REPO_SYNC",
      description:
        "Pull latest changes from GitHub and reindex the context repository.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "CONTEXT_REPO_STATUS",
      description:
        "Get context repo status: GitHub CLI auth, current config, and available folders.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "CONTEXT_ISSUE_CREATE",
      description:
        "Create a GitHub issue in the context repository. Use this to report findings, problems, or share information with the team.",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "Issue title" },
          body: { type: "string", description: "Issue body (markdown)" },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Labels to apply",
          },
        },
        required: ["title", "body"],
      },
    },
    {
      name: "CONTEXT_ISSUE_LIST",
      description: "List and search GitHub issues in the context repository.",
      inputSchema: {
        type: "object" as const,
        properties: {
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Filter by state (default: open)",
          },
          labels: {
            type: "string",
            description: "Filter by labels (comma-separated)",
          },
          query: { type: "string", description: "Search query" },
          limit: { type: "number", description: "Max results (default 30)" },
        },
      },
    },
    {
      name: "CONTEXT_ISSUE_GET",
      description:
        "Get a GitHub issue with its comments from the context repository.",
      inputSchema: {
        type: "object" as const,
        properties: {
          number: { type: "number", description: "Issue number" },
        },
        required: ["number"],
      },
    },
    {
      name: "CONTEXT_ISSUE_COMMENT",
      description: "Add a comment to a GitHub issue in the context repository.",
      inputSchema: {
        type: "object" as const,
        properties: {
          number: { type: "number", description: "Issue number" },
          body: { type: "string", description: "Comment body (markdown)" },
        },
        required: ["number", "body"],
      },
    },
    {
      name: "CONTEXT_AGENT_SAVE",
      description:
        "Save an agent definition to agents/<name>.md in the context repository via a PR.",
      inputSchema: {
        type: "object" as const,
        properties: {
          agentId: {
            type: "string",
            description: "ID of the agent (virtual MCP) to export",
          },
        },
        required: ["agentId"],
      },
    },
  ];
}

/**
 * Execute a context-repo tool by name with the given arguments.
 * Routes to the actual tool handler.
 */
export async function executeContextRepoTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: MeshContext,
): Promise<unknown> {
  const tools = await getTools();
  const tool = (
    tools as Record<
      string,
      { execute: (input: unknown, ctx: MeshContext) => Promise<unknown> }
    >
  )[toolName];
  if (!tool) {
    throw new Error(`Unknown context-repo tool: ${toolName}`);
  }
  return tool.execute(args, ctx);
}
