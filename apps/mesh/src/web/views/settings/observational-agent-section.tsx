import { Suspense } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loading01, Plus, Trash01 } from "@untitledui/icons";
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
  type ObserverConfig,
  useObservationalConfig,
  useUpdateObservationalConfig,
} from "@/web/hooks/use-organization-settings";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { SimpleModeModelRow } from "@/web/views/settings/ai-providers/simple-mode-section";

// A freshly-added observer. The server assigns its `id` + `configuredAt` on save;
// with an empty agentId the sweep skips it until an agent is picked.
const BLANK_OBSERVER: ObserverConfig = {
  id: "",
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

/** One observer's settings: agent, model, scope, plus remove. */
function ObserverCard({
  observer,
  selectableAgents,
  defaultKeyId,
  onChange,
  onRemove,
}: {
  observer: ObserverConfig;
  selectableAgents: VirtualMCPEntity[];
  defaultKeyId: string | null;
  onChange: (patch: Partial<ObserverConfig>) => void;
  onRemove: () => void;
}) {
  const hasObserver = observer.agentId !== "";
  const onlyMode = observer.scopeMode === "only";

  // The observer can never observe itself, so don't offer it in the scope list.
  const scopeOptions = selectableAgents
    .filter((a) => a.id !== observer.agentId)
    .map((a) => ({
      label: a.title,
      value: a.id,
      icon: makeAgentIcon(a.icon, a.title),
    }));

  return (
    <SettingsCard>
      <SettingsCardItem
        title="Observer agent"
        description="Runs on idle threads (per the scope below) with the conversation as context. Give this agent the Studio connection so it can read threads and agents (COLLECTION_THREAD_MESSAGES_LIST, COLLECTION_VIRTUAL_MCP_GET)."
        action={
          <div className="flex items-center gap-2">
            <Select
              value={hasObserver ? observer.agentId : NONE_VALUE}
              onValueChange={(v) =>
                onChange({ agentId: v === NONE_VALUE ? "" : v })
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
            <Button
              variant="ghost"
              size="icon"
              onClick={onRemove}
              aria-label="Remove observer"
              className="shrink-0 text-muted-foreground"
            >
              <Trash01 size={16} />
            </Button>
          </div>
        }
      >
        {hasObserver && (
          <Suspense fallback={null}>
            <ObserverToolsAdvisory agentId={observer.agentId} />
          </Suspense>
        )}
      </SettingsCardItem>
      <SettingsCardItem
        title="Model"
        description="The model the observer runs with. Falls back to your fast tier if unset."
        action={
          hasObserver ? (
            <SimpleModeModelRow
              slot={observer.model}
              defaultKeyId={defaultKeyId}
              onSlotChange={(slot) => onChange({ model: slot })}
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
            value={observer.scopeMode}
            onValueChange={(v) => onChange({ scopeMode: v as "all" | "only" })}
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
            // Remount when this observer changes so the uncontrolled default
            // tracks the right row.
            key={observer.id}
            options={scopeOptions}
            defaultValue={observer.scopeAgentIds}
            onValueChange={(ids) => onChange({ scopeAgentIds: ids })}
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

function ObservationalControls() {
  const agents = useVirtualMCPs();
  const allKeys = useAiProviderKeys();
  const saved = useObservationalConfig();
  const { mutate } = useUpdateObservationalConfig();
  const observers = saved?.observers ?? [];
  const defaultKeyId = allKeys[0]?.id ?? null;

  const selectableAgents = agents.filter((a) => a.id && !isDecopilot(a.id));

  const persist = (next: ObserverConfig[]) => {
    mutate(
      { observers: next },
      { onError: (err) => toast.error(`Failed to save: ${err.message}`) },
    );
  };

  const updateObserver = (index: number, patch: Partial<ObserverConfig>) =>
    persist(observers.map((o, i) => (i === index ? { ...o, ...patch } : o)));

  const addObserver = () => persist([...observers, { ...BLANK_OBSERVER }]);

  const removeObserver = (index: number) =>
    persist(observers.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-4">
      {observers.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No observers yet. Add one to start observing idle conversations.
        </p>
      ) : (
        observers.map((observer, i) => (
          <ObserverCard
            key={observer.id || `new-${i}`}
            observer={observer}
            selectableAgents={selectableAgents}
            defaultKeyId={defaultKeyId}
            onChange={(patch) => updateObserver(i, patch)}
            onRemove={() => removeObserver(i)}
          />
        ))
      )}
      <div>
        <Button variant="outline" size="sm" onClick={addObserver}>
          <Plus size={16} />
          Add observer
        </Button>
      </div>
    </div>
  );
}

export function ObservationalAgentSection() {
  return (
    <SettingsSection
      title="Observational agents"
      description="Run chosen agents over idle conversations so they can review what's happening and act on it (record memory, flag content, summarize — whatever each agent is set up to do)."
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
