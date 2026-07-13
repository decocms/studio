import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import type { HarnessId } from "@/harnesses";
import { getAgentModelSet } from "@/web/components/chat/select-model/agent-models";
import { useAgentOptionAvailability } from "@/web/components/chat/use-agent-availability";
import {
  useSimpleMode,
  useUpdateSimpleMode,
  type CliHarnessId,
  type CliTierConfig,
  type SimpleModeConfig,
} from "@/web/hooks/use-organization-settings";
import { ClaudeCodeIcon, CodexIcon } from "@/web/components/chat/agent-icons";

const TIER_ROWS = [
  { key: "fast" as const, label: "Fast", description: "Quicker responses" },
  { key: "smart" as const, label: "Smart", description: "Balanced quality" },
  {
    key: "thinking" as const,
    label: "Thinking",
    description: "Deeper reasoning",
  },
] as const;

const EMPTY_TIERS: CliTierConfig = { fast: null, smart: null, thinking: null };

interface HarnessMeta {
  id: CliHarnessId;
  label: string;
  icon: React.ReactNode;
  available: boolean;
}

function CliTierRow({
  harnessId,
  tier,
  defaultModelId,
}: {
  harnessId: CliHarnessId;
  tier: "fast" | "smart" | "thinking";
  defaultModelId: string;
}) {
  const simpleMode = useSimpleMode();
  const { mutate: updateSimpleMode } = useUpdateSimpleMode();
  const set = getAgentModelSet(harnessId as HarnessId);
  const models = set?.models ?? [];

  // Effective selection: the org override if set, otherwise the built-in
  // default for this harness/tier.
  const selected =
    simpleMode.cli?.[harnessId]?.[tier]?.modelId ?? defaultModelId;

  const handleChange = (modelId: string) => {
    const model = models.find((m) => m.modelId === modelId);
    if (!model) return;
    const harnessTiers = simpleMode.cli?.[harnessId] ?? EMPTY_TIERS;
    const next: SimpleModeConfig = {
      ...simpleMode,
      cli: {
        ...simpleMode.cli,
        [harnessId]: {
          ...harnessTiers,
          [tier]: { modelId: model.modelId, title: model.title },
        },
      },
    };
    updateSimpleMode(next, {
      onError: (err) => toast.error(`Failed to save: ${err.message}`),
    });
  };

  return (
    <Select value={selected} onValueChange={handleChange}>
      <SelectTrigger className="w-56">
        <SelectValue placeholder="Pick model" />
      </SelectTrigger>
      <SelectContent>
        {models.map((m) => (
          <SelectItem key={m.modelId} value={m.modelId}>
            {m.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function HarnessCard({ harness }: { harness: HarnessMeta }) {
  const set = getAgentModelSet(harness.id as HarnessId);
  if (!set) return null;

  return (
    <SettingsSection
      title={
        <span className="flex items-center gap-2">
          {harness.icon}
          {harness.label}
        </span>
      }
      headerClassName="pl-0"
    >
      <SettingsCard>
        {TIER_ROWS.map((row) => (
          <SettingsCardItem
            key={row.key}
            title={row.label}
            description={row.description}
            action={
              <CliTierRow
                harnessId={harness.id}
                tier={row.key}
                defaultModelId={set.tiers[row.key].modelId ?? ""}
              />
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Per-harness fast/smart/thinking model overrides for local CLI runtimes
 * (Claude Code / Codex). Mirrors the cloud "Default models" section but for
 * desktop harnesses — unset tiers fall back to the built-in default. Only
 * renders harnesses the linked desktop currently exposes.
 */
export function LocalModelsSection() {
  const availability = useAgentOptionAvailability();
  const harnesses: HarnessMeta[] = [
    {
      id: "claude-code",
      label: "Claude Code",
      icon: <ClaudeCodeIcon size={16} />,
      available: availability.claudeCode,
    },
    {
      id: "codex",
      label: "Codex",
      icon: <CodexIcon size={16} />,
      available: availability.codex,
    },
  ];
  const visible = harnesses.filter((h) => h.available);
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Pick which model each tier runs on your desktop runtimes. Unset tiers
        use the built-in default.
      </p>
      {visible.map((h) => (
        <HarnessCard key={h.id} harness={h} />
      ))}
    </div>
  );
}
