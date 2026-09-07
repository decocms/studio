/**
 * Agent-management built-ins
 *
 * Exposes the org's agent (Virtual MCP) CRUD tools to the Super Agent as
 * always-available built-ins. Decopilot aggregates no connections
 * (`storage/virtual.ts` findById returns `connections: []`), so before this it
 * could only create or edit an agent by `subtask`-delegating to the (now
 * retired) Agent Manager. Same shape and rationale as `task-board-tools.ts`.
 *
 * These tools stay registered on the Studio MCP endpoint (`/mcp`) — this file
 * only adds a second, always-on path to them; it does not move them.
 *
 * Names are kept verbatim rather than snake_cased like the other built-ins:
 * the guide prompts and docs already tell the model to call them by these
 * names.
 */

import { tool, zodSchema, type ToolSet } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { COLLECTION_CONNECTIONS_GET } from "@/tools/connection/get";
import { COLLECTION_CONNECTIONS_LIST } from "@/tools/connection/list";
import { COLLECTION_VIRTUAL_MCP_CREATE } from "@/tools/virtual/create";
import { COLLECTION_VIRTUAL_MCP_DELETE } from "@/tools/virtual/delete";
import { COLLECTION_VIRTUAL_MCP_GET } from "@/tools/virtual/get";
import { COLLECTION_VIRTUAL_MCP_LIST } from "@/tools/virtual/list";
import { COLLECTION_VIRTUAL_MCP_UPDATE } from "@/tools/virtual/update";
import { VIRTUAL_MCP_PINNED_VIEWS_UPDATE } from "@/tools/virtual/pinned-views-update";
import { VIRTUAL_MCP_PLUGIN_CONFIG_GET } from "@/tools/virtual/plugin-config-get";
import { VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE } from "@/tools/virtual/plugin-config-update";

/** The Agent Manager's former toolset, verbatim. */
export function createAgentTools(ctx: StudioContext): ToolSet {
  return {
    COLLECTION_VIRTUAL_MCP_CREATE: tool({
      description: COLLECTION_VIRTUAL_MCP_CREATE.description,
      inputSchema: zodSchema(COLLECTION_VIRTUAL_MCP_CREATE.inputSchema),
      execute: (input) => COLLECTION_VIRTUAL_MCP_CREATE.execute(input, ctx),
    }),
    COLLECTION_VIRTUAL_MCP_LIST: tool({
      description: COLLECTION_VIRTUAL_MCP_LIST.description,
      inputSchema: zodSchema(COLLECTION_VIRTUAL_MCP_LIST.inputSchema),
      execute: (input) => COLLECTION_VIRTUAL_MCP_LIST.execute(input, ctx),
    }),
    COLLECTION_VIRTUAL_MCP_GET: tool({
      description: COLLECTION_VIRTUAL_MCP_GET.description,
      inputSchema: zodSchema(COLLECTION_VIRTUAL_MCP_GET.inputSchema),
      execute: (input) => COLLECTION_VIRTUAL_MCP_GET.execute(input, ctx),
    }),
    COLLECTION_VIRTUAL_MCP_UPDATE: tool({
      description: COLLECTION_VIRTUAL_MCP_UPDATE.description,
      inputSchema: zodSchema(COLLECTION_VIRTUAL_MCP_UPDATE.inputSchema),
      execute: (input) => COLLECTION_VIRTUAL_MCP_UPDATE.execute(input, ctx),
    }),
    COLLECTION_VIRTUAL_MCP_DELETE: tool({
      description: COLLECTION_VIRTUAL_MCP_DELETE.description,
      inputSchema: zodSchema(COLLECTION_VIRTUAL_MCP_DELETE.inputSchema),
      execute: (input) => COLLECTION_VIRTUAL_MCP_DELETE.execute(input, ctx),
    }),
    VIRTUAL_MCP_PLUGIN_CONFIG_GET: tool({
      description: VIRTUAL_MCP_PLUGIN_CONFIG_GET.description,
      inputSchema: zodSchema(VIRTUAL_MCP_PLUGIN_CONFIG_GET.inputSchema),
      execute: (input) => VIRTUAL_MCP_PLUGIN_CONFIG_GET.execute(input, ctx),
    }),
    VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE: tool({
      description: VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.description,
      inputSchema: zodSchema(VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.inputSchema),
      execute: (input) => VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE.execute(input, ctx),
    }),
    VIRTUAL_MCP_PINNED_VIEWS_UPDATE: tool({
      description: VIRTUAL_MCP_PINNED_VIEWS_UPDATE.description,
      inputSchema: zodSchema(VIRTUAL_MCP_PINNED_VIEWS_UPDATE.inputSchema),
      execute: (input) => VIRTUAL_MCP_PINNED_VIEWS_UPDATE.execute(input, ctx),
    }),
    COLLECTION_CONNECTIONS_LIST: tool({
      description: COLLECTION_CONNECTIONS_LIST.description,
      inputSchema: zodSchema(COLLECTION_CONNECTIONS_LIST.inputSchema),
      execute: (input) => COLLECTION_CONNECTIONS_LIST.execute(input, ctx),
    }),
    COLLECTION_CONNECTIONS_GET: tool({
      description: COLLECTION_CONNECTIONS_GET.description,
      inputSchema: zodSchema(COLLECTION_CONNECTIONS_GET.inputSchema),
      execute: (input) => COLLECTION_CONNECTIONS_GET.execute(input, ctx),
    }),
  };
}
