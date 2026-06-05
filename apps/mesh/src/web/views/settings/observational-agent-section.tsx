import { Suspense } from "react";
import { toast } from "sonner";
import { Loading01 } from "@untitledui/icons";
import { isDecopilot, useVirtualMCPs } from "@decocms/mesh-sdk";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import { MultiSelect } from "@deco/ui/components/multi-select.tsx";
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
      />
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
