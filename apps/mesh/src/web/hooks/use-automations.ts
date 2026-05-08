/**
 * Automation Hooks
 *
 * React hooks for fetching and mutating automations via MCP tools.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { toast } from "sonner";
import { KEYS } from "../lib/query-keys";

// ============================================================================
// Trigger List Hook
// ============================================================================

export interface TriggerParamSchema {
  type: string;
  enum?: string[];
  description?: string;
}

export interface TriggerDefinition {
  type: string;
  description: string;
  paramsSchema: Record<string, TriggerParamSchema>;
}

/**
 * Raw trigger format from MCP servers (e.g. GitHub MCP uses `params` array)
 */
interface RawTriggerDefinition {
  type: string;
  description: string;
  paramsSchema?: Record<string, TriggerParamSchema>;
  params?:
    | Array<{
        name: string;
        type: string;
        description?: string;
        enum?: string[];
        required?: boolean;
      }>
    | Record<string, TriggerParamSchema>;
}

/**
 * Normalize trigger definitions from different MCP server formats.
 * Some servers return `paramsSchema` as a Record (per binding spec),
 * others return `params` as an array (e.g. GitHub MCP).
 */
function normalizeTrigger(raw: RawTriggerDefinition): TriggerDefinition {
  if (raw.paramsSchema && typeof raw.paramsSchema === "object") {
    return raw as TriggerDefinition;
  }

  const paramsSchema: Record<string, TriggerParamSchema> = {};

  if (Array.isArray(raw.params)) {
    for (const p of raw.params) {
      paramsSchema[p.name] = {
        type: p.type,
        description: p.description,
        enum: p.enum,
      };
    }
  } else if (raw.params && typeof raw.params === "object") {
    Object.assign(paramsSchema, raw.params);
  }

  return {
    type: raw.type,
    description: raw.description,
    paramsSchema,
  };
}

export function useTriggerList(connectionId: string | undefined) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: connectionId ?? SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.toolCall(connectionId ?? "", "TRIGGER_LIST", ""),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "TRIGGER_LIST",
        arguments: {},
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ?? result) as {
        triggers: RawTriggerDefinition[];
      };
      return payload.triggers.map(normalizeTrigger);
    },
    enabled: !!connectionId,
    staleTime: 30_000,
  });
}

// ============================================================================
// Types
// ============================================================================

export interface AutomationListItem {
  id: string;
  name: string;
  active: boolean;
  created_by: string;
  created_at: string;
  trigger_count: number;
  virtual_mcp_id: string;
  nearest_next_run_at: string | null;
}

export interface AutomationTrigger {
  id: string;
  type: "cron" | "event";
  cron_expression: string | null;
  connection_id: string | null;
  event_type: string | null;
  params: Record<string, string> | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
}

export interface AutomationDetail {
  id: string;
  name: string;
  active: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  virtual_mcp_id: string;
  messages: unknown[];
  models: {
    credentialId: string;
    thinking: { id: string; [key: string]: unknown };
    tier?: "fast" | "smart" | "thinking";
    [key: string]: unknown;
  };
  temperature: number;
  triggers: AutomationTrigger[];
}

// ============================================================================
// Query Hooks
// ============================================================================

type AutomationListOutput = { automations: AutomationListItem[] };

export function useAutomations(virtualMcpId?: string | null) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.automations(org.id, virtualMcpId),
    queryFn: async () => {
      const args: Record<string, unknown> =
        virtualMcpId !== undefined && virtualMcpId !== null
          ? { virtual_mcp_id: virtualMcpId }
          : {};
      const result = (await client.callTool({
        name: "AUTOMATION_LIST",
        arguments: args,
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as AutomationListOutput;
      return payload.automations;
    },
    staleTime: 10_000,
  });
}

type AutomationGetOutput = { automation: AutomationDetail | null };

export function useAutomation(id: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  return useQuery({
    queryKey: KEYS.automation(org.id, id),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AUTOMATION_GET",
        arguments: { id },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as AutomationGetOutput;
      return payload.automation;
    },
    enabled: !!id,
    staleTime: 10_000,
  });
}

// ============================================================================
// Helpers
// ============================================================================

export function buildDefaultAutomationInput(
  virtualMcpId: string,
  modelDefaults?: { credentialId: string; modelId: string } | null,
) {
  return {
    name: "New Automation",
    messages: [],
    models: modelDefaults
      ? {
          credentialId: modelDefaults.credentialId,
          thinking: { id: modelDefaults.modelId },
        }
      : { credentialId: "", thinking: { id: "" } },
    temperature: 0.5,
    active: true,
    virtual_mcp_id: virtualMcpId,
  };
}

// ============================================================================
// Actions Hook
// ============================================================================

export function useAutomationActions() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const queryClient = useQueryClient();

  const invalidateAll = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.automationsAll(org.id) });

  const invalidateOne = (id: string) =>
    queryClient.invalidateQueries({ queryKey: KEYS.automation(org.id, id) });

  const create = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const result = (await client.callTool({
        name: "AUTOMATION_CREATE",
        arguments: input,
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as {
        id: string;
        name: string;
      };
    },
    onSuccess: () => {
      invalidateAll();
      toast.success("Automation created successfully");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to create automation: ${message}`);
    },
  });

  const update = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const result = (await client.callTool({
        name: "AUTOMATION_UPDATE",
        arguments: input,
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { id: string };
    },
    onSuccess: (_data, variables) => {
      invalidateAll();
      if (typeof variables.id === "string") {
        invalidateOne(variables.id);
      }
      toast.success("Automation updated successfully");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to update automation: ${message}`);
    },
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = (await client.callTool({
        name: "AUTOMATION_DELETE",
        arguments: { id },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { success: boolean };
    },
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: KEYS.automation(org.id, id) });
      invalidateAll();
      toast.success("Automation deleted successfully");
    },
    onError: (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to delete automation: ${message}`);
    },
  });

  const triggerAdd = useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const result = (await client.callTool({
        name: "AUTOMATION_TRIGGER_ADD",
        arguments: input,
      })) as {
        structuredContent?: unknown;
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      if (result.isError) {
        const message = result.content?.[0]?.text ?? "Failed to add trigger";
        throw new Error(message);
      }
      return (result.structuredContent ?? result) as {
        id: string;
        automation_id: string;
      };
    },
    onSuccess: (data) => {
      invalidateAll();
      invalidateOne(data.automation_id);
    },
  });

  const triggerRemove = useMutation({
    mutationFn: async (input: {
      trigger_id: string;
      automation_id: string;
    }) => {
      const result = (await client.callTool({
        name: "AUTOMATION_TRIGGER_REMOVE",
        arguments: { trigger_id: input.trigger_id },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { success: boolean };
    },
    onSuccess: (_data, variables) => {
      invalidateAll();
      invalidateOne(variables.automation_id);
    },
  });

  return { create, update, remove, triggerAdd, triggerRemove };
}
