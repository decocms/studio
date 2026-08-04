import { Terminal } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import { FlagToggle } from "@/components/settings/review-settings";
import { useT } from "@/i18n/use-t.ts";

/**
 * Which harness runs the org's agent tasks. Off by default: the claude-code
 * harness dispatches through the sandbox rather than in-process, and needs an
 * Anthropic or OpenRouter model credential — hence the toggle rather than a
 * silent rollout.
 */
export function AgentRuntimeSettings() {
  const t = useT();
  return (
    <SettingsSection
      title={t("settings.agentRuntime.title")}
      description={t("settings.agentRuntime.description")}
    >
      <SettingsCard>
        <FlagToggle
          flag="claude_code_sandbox_enabled"
          icon={<Terminal size={16} />}
          titleKey="settings.agentRuntime.claudeCodeTitle"
          descriptionKey="settings.agentRuntime.claudeCodeDescription"
        />
      </SettingsCard>
    </SettingsSection>
  );
}
