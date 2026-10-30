import { useRouterState } from "@tanstack/react-router";
import { Plus } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useAiProviderKeys,
  useAiProviders,
} from "@/hooks/collections/use-ai-providers";
import { useT } from "@/i18n/use-t.ts";
import { ClaudeSubscriptionRow } from "./claude-subscription-row";
import { CodexSubscriptionRow } from "./codex-subscription-row";
import { GithubCopilotRow } from "./github-copilot-row";
import { ProviderKeyRow } from "./provider-key-row";
import { buildProviderInventoryRows } from "./provider-inventory";

/** The section's anchor, for links that should land on it (the sidebar's "Link Claude"). */
export const OWN_ACCOUNTS_ANCHOR = "own-accounts";

/**
 * Subscriptions and API keys in one list: both are billed by the provider,
 * with no deco fee. Keys stay listed after their provider leaves the hosted
 * catalog, so an org can still delete them.
 */
export function OwnAccountsSection({ onAddKey }: { onAddKey: () => void }) {
  const t = useT();
  const allKeys = useAiProviderKeys();
  const aiProviders = useAiProviders();
  const rows = buildProviderInventoryRows(
    allKeys,
    aiProviders?.providers ?? [],
  );
  const targeted = useRouterState({
    select: (state) => state.location.hash === OWN_ACCOUNTS_ANCHOR,
  });

  return (
    // The page renders after its data loads, so the router's own hash scroll
    // can run before this exists; scroll once it mounts instead.
    <div
      id={OWN_ACCOUNTS_ANCHOR}
      ref={(el) => {
        if (el && targeted) el.scrollIntoView({ block: "start" });
      }}
    >
      <SettingsSection title={t("settings.ownAccounts.title")}>
        <SettingsCard>
          <ClaudeSubscriptionRow />
          <CodexSubscriptionRow />
          <GithubCopilotRow />
          {rows.map(({ key, provider }) => (
            <ProviderKeyRow
              key={key.id}
              providerKey={key}
              provider={provider}
            />
          ))}
          <button
            type="button"
            onClick={onAddKey}
            className="flex w-full items-center gap-3 px-4 py-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <span className="flex size-8 items-center justify-center rounded-lg border border-dashed border-border">
              <Plus size={16} />
            </span>
            {t("settings.ownAccounts.addApiKey")}
          </button>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
