import { Suspense, useState } from "react";
import { AlertCircle } from "@untitledui/icons";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { SettingsGroupPage } from "@/components/settings/settings-group-page";
import {
  useAiProviderKeys,
  useAiProviders,
} from "@/hooks/collections/use-ai-providers";
import { SimpleModeSection } from "./simple-mode-section";
import { DecoCreditsHero } from "./deco-credits-hero";
import { PlanUsageCard } from "./plan-usage-card";
import { DecoNudgeCard } from "./deco-nudge-card";
import { ConnectedProvidersSection } from "./connected-providers-section";
import { ClaudeSubscriptionCard } from "./claude-subscription-card";
import { ConnectProviderDialog } from "./connect-provider-dialog";
import { ProviderGrid, type ProviderSelection } from "./provider-grid";
import { getProviderInventoryState } from "./provider-inventory";
import { useFeature } from "@/hooks/use-entitlements";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="p-4 rounded-md bg-destructive/10 text-destructive flex items-center gap-2">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load AI providers: {error.message}
      </span>
    </div>
  );
}

function OrgAiProvidersContent() {
  const allKeys = useAiProviderKeys();
  const { hasInventory, hasHostedProvider, hasDeco } =
    getProviderInventoryState(allKeys);
  const [connectOpen, setConnectOpen] = useState(false);
  const [pendingProvider, setPendingProvider] =
    useState<ProviderSelection | null>(null);

  const aiProviders = useAiProviders();
  // Fails OPEN, so a gateway blip shows the BYO surfaces rather than hiding them.
  const canChooseModels = useFeature("model_choice");
  const allProviders = aiProviders?.providers ?? [];
  // Every tile but Deco is a bring-your-own key.
  const providers = canChooseModels
    ? allProviders
    : allProviders.filter((p) => p.id === "deco");

  if (!hasHostedProvider) {
    return (
      <>
        {/* The plan is an org-level fact — it does not depend on which
            provider keys the org happens to have connected. */}
        <PlanUsageCard />
        <ProviderGrid
          providers={providers}
          onSelect={setPendingProvider}
          onShowAll={canChooseModels ? () => setConnectOpen(true) : undefined}
        />
        <ConnectProviderDialog
          open={pendingProvider !== null || connectOpen}
          onOpenChange={(o) => {
            if (!o) {
              setPendingProvider(null);
              setConnectOpen(false);
            }
          }}
          initialProvider={pendingProvider ?? undefined}
        />
        {hasInventory && canChooseModels ? (
          <ConnectedProvidersSection
            onConnectClick={() => setConnectOpen(true)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <PlanUsageCard />
      {hasDeco ? <DecoCreditsHero /> : null}
      {canChooseModels ? (
        <>
          <Suspense fallback={<Skeleton className="h-16 w-full" />}>
            <SimpleModeSection />
          </Suspense>
          {hasDeco ? null : <DecoNudgeCard />}
          <ClaudeSubscriptionCard />
          <ConnectedProvidersSection
            onConnectClick={() => setConnectOpen(true)}
          />
          <ConnectProviderDialog
            open={connectOpen}
            onOpenChange={setConnectOpen}
          />
        </>
      ) : null}
    </>
  );
}

export function OrgAiProvidersPage() {
  return (
    <SettingsGroupPage
      group="billing"
      errorFallback={({ error }) => (
        <ErrorFallback
          error={error ?? new Error("Failed to load AI providers")}
        />
      )}
    >
      <OrgAiProvidersContent />
    </SettingsGroupPage>
  );
}
