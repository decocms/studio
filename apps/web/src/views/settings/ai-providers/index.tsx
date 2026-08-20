import { Suspense, useState } from "react";
import { AlertCircle } from "@untitledui/icons";
import { Page } from "@/components/page";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { SettingsPage } from "@/components/settings/settings-section";
import { SettingsSubnav } from "@/components/settings/settings-subnav";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  useAiProviderKeys,
  useAiProviders,
} from "@/hooks/collections/use-ai-providers";
import { SimpleModeSection } from "./simple-mode-section";
import { AutoTasksCard } from "./auto-tasks-card";
import { DecoCreditsHero } from "./deco-credits-hero";
import { DecoNudgeCard } from "./deco-nudge-card";
import { ConnectedProvidersSection } from "./connected-providers-section";
import { ClaudeSubscriptionCard } from "./claude-subscription-card";
import { ConnectProviderDialog } from "./connect-provider-dialog";
import { ProviderGrid, type ProviderSelection } from "./provider-grid";
import { getProviderInventoryState } from "./provider-inventory";

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
  const providers = aiProviders?.providers ?? [];

  if (!hasHostedProvider) {
    return (
      <>
        <AutoTasksCard />
        <ProviderGrid
          providers={providers}
          onSelect={setPendingProvider}
          onShowAll={() => setConnectOpen(true)}
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
        {hasInventory ? (
          <ConnectedProvidersSection
            onConnectClick={() => setConnectOpen(true)}
          />
        ) : null}
      </>
    );
  }

  return (
    <>
      <AutoTasksCard />
      <Suspense fallback={<Skeleton className="h-16 w-full" />}>
        <SimpleModeSection />
      </Suspense>
      {hasDeco ? <DecoCreditsHero /> : <DecoNudgeCard />}
      <ClaudeSubscriptionCard />
      <ConnectedProvidersSection onConnectClick={() => setConnectOpen(true)} />
      <ConnectProviderDialog open={connectOpen} onOpenChange={setConnectOpen} />
    </>
  );
}

export function OrgAiProvidersPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <SettingsSubnav group="billing" />
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load AI providers")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <OrgAiProvidersContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
