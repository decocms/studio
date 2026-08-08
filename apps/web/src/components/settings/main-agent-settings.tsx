import { Suspense } from "react";
import { toast } from "sonner";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { AgentAvatar } from "@/components/agent-icon";
import {
  getWellKnownDecopilotVirtualMCP,
  isDecopilot,
  isStudioPackAgent,
  useProjectContext,
  useVirtualMCPs,
} from "@/sdk";
import { getDevAgentIds } from "@/lib/agent-capabilities";
import {
  useMainAgentId,
  useSetMainAgent,
} from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

// Sentinel for the "no main agent → Super Agent" option. The Select needs a
// non-empty string value; null (clear the setting) is mapped from this.
const SUPER_AGENT_VALUE = "__super_agent__";

function MainAgentSelect() {
  const t = useT();
  const { org } = useProjectContext();
  const allAgents = useVirtualMCPs();
  const { mainAgentId } = useMainAgentId();
  const setMainAgent = useSetMainAgent();

  // Same visible set as the agent browser: no Super Agent (it's the default
  // fallback, offered as its own row), no dev agents, no Studio Pack agents.
  const devAgentIds = getDevAgentIds(allAgents);
  const agents = (allAgents ?? [])
    .filter((a) => !isDecopilot(a.id))
    .filter((a) => !devAgentIds.has(a.id))
    .filter((a) => !isStudioPackAgent(a.id));

  const superAgent = getWellKnownDecopilotVirtualMCP(org.id);

  // Validity must match the landing resolver, which checks the FULL agent list,
  // not the filtered browse set. A stored id outside that set (a dev/Studio-Pack
  // agent set from the agent card, or a deleted agent) otherwise renders here as
  // "Super Agent" AND can't be cleared — clicking the already-shown row is a
  // no-op. So resolve against the full list and, when the main agent falls
  // outside the browse options, prepend it so the selection stays changeable.
  const storedMainAgent =
    mainAgentId != null
      ? (allAgents ?? []).find((a) => a.id === mainAgentId)
      : undefined;
  const selected = storedMainAgent ? storedMainAgent.id : SUPER_AGENT_VALUE;
  const options =
    storedMainAgent && !agents.some((a) => a.id === storedMainAgent.id)
      ? [storedMainAgent, ...agents]
      : agents;

  const onChange = (value: string) => {
    const next = value === SUPER_AGENT_VALUE ? null : value;
    const title =
      next === null
        ? superAgent.title
        : ((allAgents ?? []).find((a) => a.id === next)?.title ?? "");
    setMainAgent.mutate(next, {
      onSuccess: () =>
        toast.success(
          next === null
            ? t("settings.mainAgent.resetToast")
            : t("settings.mainAgent.setToast", { title }),
        ),
      onError: () => toast.error(t("settings.mainAgent.errorToast")),
    });
  };

  return (
    <Select
      value={selected}
      onValueChange={onChange}
      disabled={setMainAgent.isPending}
    >
      <SelectTrigger className="w-full sm:w-[280px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SUPER_AGENT_VALUE}>
          <span className="flex items-center gap-2">
            <AgentAvatar
              icon={superAgent.icon}
              name={superAgent.title}
              size="xs"
              className="shrink-0"
            />
            <span className="truncate">
              {t("settings.mainAgent.superAgentOption")}
            </span>
          </span>
        </SelectItem>
        {options.map((agent) => (
          <SelectItem key={agent.id} value={agent.id}>
            <span className="flex items-center gap-2">
              <AgentAvatar
                icon={agent.icon}
                name={agent.title}
                size="xs"
                className="shrink-0"
              />
              <span className="truncate">{agent.title}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Org-wide "main agent" picker for Settings › General. The chosen agent is
 * where `/$org` lands (instead of the Super Agent) for every member. Shares the
 * `organization_settings.main_agent_id` field with the per-agent card action.
 */
export function MainAgentSettings() {
  const t = useT();
  return (
    <SettingsSection
      title={t("settings.mainAgent.title")}
      description={t("settings.mainAgent.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.mainAgent.itemTitle")}
          description={t("settings.mainAgent.itemDescription")}
          action={
            <Suspense fallback={<Skeleton className="h-9 w-[280px]" />}>
              <MainAgentSelect />
            </Suspense>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
