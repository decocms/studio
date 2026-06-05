import { Suspense } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loading01 } from "@untitledui/icons";
import {
  isDecopilot,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPActions,
  useVirtualMCPs,
  type VirtualMCPEntity,
  WellKnownOrgMCPId,
} from "@decocms/mesh-sdk";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
import { Alert, AlertDescription } from "@deco/ui/components/alert.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { AgentAvatar } from "@/web/components/agent-icon";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  type ObservationalConfig,
  useObservationalConfig,
  useUpdateObservationalConfig,
} from "@/web/hooks/use-organization-settings";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { SimpleModeModelRow } from "@/web/views/settings/ai-providers/simple-mode-section";

const DEFAULT_CONFIG: ObservationalConfig = {
  agentId: "",
  scopeMode: "all",
  scopeAgentIds: [],
  model: null,
  configuredAt: null,
};

// Radix Select can't hold an empty-string item value, so "disabled" uses a
// sentinel that maps back to agentId === "".
const NONE_VALUE = "__none__";

/** Avatar icon bound to an agent, for the MultiSelect `icon` slot. */
const makeAgentIcon =
  (icon: string | null | undefined, name: string) =>
  ({ className }: { className?: string }) => (
    <AgentAvatar icon={icon} name={name} size="2xs" className={className} />
  );

// Tools the observer needs to read the conversations it's handed — exposed by
// the Studio management ("self") connection.
const OBSERVER_READING_TOOLS = [
  "COLLECTION_THREAD_MESSAGES_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
];

function agentHasReadingTools(
  agent: VirtualMCPEntity,
  selfConnectionId: string,
): boolean {
  const conn = agent.connections?.find(
    (c) => c.connection_id === selfConnectionId,
  );
  if (!conn) return false;
  // null selected_tools = every tool from that connection is included.
  if (conn.selected_tools === null) return true;
  const selected = conn.selected_tools;
  return OBSERVER_READING_TOOLS.every((t) => selected.includes(t));
}

/**
 * Warns when the chosen observer agent lacks the thread-reading tools, with a
 * button that adds the Studio connection (scoped to just those two tools) to
 * the agent. Self-suspends on the agent fetch, so wrap in <Suspense>.
 */
function ObserverToolsAdvisory({ agentId }: { agentId: string }) {
  const { org } = useProjectContext();
  const agent = useVirtualMCP(agentId);
  const { update } = useVirtualMCPActions();
  if (!agent) return null;

  const selfConnId = WellKnownOrgMCPId.SELF(org.id);
  if (agentHasReadingTools(agent, selfConnId)) return null;

  const addReadingTools = () => {
    const conns = agent.connections ?? [];
    const existing = conns.find((c) => c.connection_id === selfConnId);
    let next: VirtualMCPEntity["connections"];
    if (!existing) {
      next = [
        ...conns,
        {
          connection_id: selfConnId,
          selected_tools: OBSERVER_READING_TOOLS,
          selected_resources: null,
          selected_prompts: null,
        },
      ];
    } else {
      // existing.selected_tools is non-null here (null would have passed the
      // check above) — union in the reading tools.
      const merged = [
        ...new Set([
          ...(existing.selected_tools ?? []),
          ...OBSERVER_READING_TOOLS,
        ]),
      ];
      next = conns.map((c) =>
        c.connection_id === selfConnId ? { ...c, selected_tools: merged } : c,
      );
    }
    // useVirtualMCPActions toasts on success/error itself.
    update.mutate({ id: agentId, data: { connections: next } });
  };

  return (
    <Alert variant="warning" className="mt-3">
      <AlertTriangle />
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>
          This agent can't read conversations yet — it's missing the Studio
          reading tools.
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={addReadingTools}
          disabled={update.isPending}
          className="shrink-0"
        >
          {update.isPending ? "Adding…" : "Add reading tools"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function ObservationalControls() {
  const agents = useVirtualMCPs();
  const allKeys = useAiProviderKeys();
  const saved = useObservationalConfig();
  const { mutate } = useUpdateObservationalConfig();
  const current = saved ?? DEFAULT_CONFIG;
  const defaultKeyId = allKeys[0]?.id ?? null;

  const selectableAgents = agents.filter((a) => a.id && !isDecopilot(a.id));

  const persist = (patch: Partial<ObservationalConfig>) => {
    mutate(
      { ...current, ...patch },
      { onError: (err) => toast.error(`Failed to save: ${err.message}`) },
    );
  };

  // The observer can never observe itself, so don't offer it in the scope list.
  const scopeOptions = selectableAgents
    .filter((a) => a.id !== current.agentId)
    .map((a) => ({
      label: a.title,
      value: a.id,
      icon: makeAgentIcon(a.icon, a.title),
    }));

  const hasObserver = current.agentId !== "";
  const onlyMode = current.scopeMode === "only";

  return (
    <SettingsCard>
      <SettingsCardItem
        title="Observer agent"
        description="Runs on idle threads (per the scope below) with the conversation as context. Give this agent the Studio connection so it can read threads and agents (COLLECTION_THREAD_MESSAGES_LIST, COLLECTION_VIRTUAL_MCP_GET)."
        action={
          <Select
            value={hasObserver ? current.agentId : NONE_VALUE}
            onValueChange={(v) =>
              persist({ agentId: v === NONE_VALUE ? "" : v })
            }
          >
            <SelectTrigger className="w-56">
              <SelectValue placeholder="Select an agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>None (disabled)</SelectItem>
              {selectableAgents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  <span className="flex items-center gap-2">
                    <AgentAvatar icon={a.icon} name={a.title} size="xs" />
                    <span className="truncate">{a.title}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      >
        {hasObserver && (
          <Suspense fallback={null}>
            <ObserverToolsAdvisory agentId={current.agentId} />
          </Suspense>
        )}
      </SettingsCardItem>
      <SettingsCardItem
        title="Model"
        description="The model the observer runs with. Falls back to your fast tier if unset."
        action={
          hasObserver ? (
            <SimpleModeModelRow
              slot={current.model}
              defaultKeyId={defaultKeyId}
              onSlotChange={(slot) => persist({ model: slot })}
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              Select an agent first
            </span>
          )
        }
      />
      <SettingsCardItem
        title="Observe"
        description="Which agents' threads to observe."
        action={
          <Select
            value={current.scopeMode}
            onValueChange={(v) => persist({ scopeMode: v as "all" | "only" })}
            disabled={!hasObserver}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agents</SelectItem>
              <SelectItem value="only">Only selected agents</SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SettingsCardItem
        title={onlyMode ? "Included agents" : "Excluded agents"}
        description={
          onlyMode
            ? "Only threads from these agents are observed."
            : "Threads from these agents are never observed."
        }
        action={
          <MultiSelect
            options={scopeOptions}
            defaultValue={current.scopeAgentIds}
            onValueChange={(ids) => persist({ scopeAgentIds: ids })}
            placeholder={onlyMode ? "Select agents" : "None"}
            maxCount={3}
            className="w-56"
            disabled={!hasObserver}
          />
        }
      />
    </SettingsCard>
  );
}

export function ObservationalAgentSection() {
  return (
    <SettingsSection
      title="Observational agent"
      description="Run a chosen agent over idle conversations so it can review what's happening and act on it (record memory, flag content, summarize — whatever the agent is set up to do)."
    >
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <Loading01
              size={18}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <ObservationalControls />
      </Suspense>
    </SettingsSection>
  );
}
