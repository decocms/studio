/**
 * Automation Hooks
 *
 * React hooks for fetching and mutating automations via MCP tools.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useMCPClient,
  useProjectContext,
  SELF_MCP_ALIAS_ID,
} from "@decocms/mesh-sdk";
import { KEYS } from "../lib/query-keys";

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
  agent: { id: string; mode: string };
  messages: unknown[];
  models: {
    credentialId: string;
    thinking: { id: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  temperature: number;
  triggers: AutomationTrigger[];
}

// ============================================================================
// List Hook
// ============================================================================

type AutomationListOutput = { automations: AutomationListItem[] };

export function useAutomationsList() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  return useQuery({
    queryKey: KEYS.automations(org.id),
    queryFn: async () => {
      const result = (await client.callTool({
        name: "AUTOMATION_LIST",
        arguments: {},
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ??
        result) as AutomationListOutput;
      return payload.automations;
    },
    staleTime: 10_000,
  });
}

// ============================================================================
// Detail Hook
// ============================================================================

type AutomationGetOutput = { automation: AutomationDetail | null };

export function useAutomationDetail(id: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
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
// Mutation Hooks
// ============================================================================

export function useAutomationCreate() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
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
      queryClient.invalidateQueries({ queryKey: KEYS.automations(org.id) });
    },
  });
}

export function useAutomationUpdate() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const result = (await client.callTool({
        name: "AUTOMATION_UPDATE",
        arguments: input,
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { id: string };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: KEYS.automations(org.id) });
      if (typeof variables.id === "string") {
        queryClient.invalidateQueries({
          queryKey: KEYS.automation(org.id, variables.id),
        });
      }
    },
  });
}

export function useAutomationDelete() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const result = (await client.callTool({
        name: "AUTOMATION_DELETE",
        arguments: { id },
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { success: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: KEYS.automations(org.id) });
    },
  });
}

export function useAutomationTriggerAdd() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: Record<string, unknown>) => {
      const result = (await client.callTool({
        name: "AUTOMATION_TRIGGER_ADD",
        arguments: input,
      })) as { structuredContent?: unknown };
      return (result.structuredContent ?? result) as { id: string };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: KEYS.automations(org.id) });
      if (typeof variables.automation_id === "string") {
        queryClient.invalidateQueries({
          queryKey: KEYS.automation(org.id, variables.automation_id),
        });
      }
    },
  });
}

export function useAutomationTriggerRemove() {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });
  const queryClient = useQueryClient();

  return useMutation({
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
      queryClient.invalidateQueries({ queryKey: KEYS.automations(org.id) });
      queryClient.invalidateQueries({
        queryKey: KEYS.automation(org.id, variables.automation_id),
      });
    },
  });
}
