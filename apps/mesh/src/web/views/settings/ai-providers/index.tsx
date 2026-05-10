import { Suspense, useState } from "react";
import { AlertCircle } from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { SimpleModeSection } from "./simple-mode-section";
import { DecoCreditsHero } from "./deco-credits-hero";
import { DecoNudgeCard } from "./deco-nudge-card";
import { AiProvidersEmptyState } from "./empty-state";
import { ConnectedProvidersSection } from "./connected-providers-section";
import { ConnectProviderDialog } from "./connect-provider-dialog";

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
  const hasDeco = allKeys.some((k) => k.providerId === "deco");
  const hasAnyProvider = allKeys.length > 0;
  const [connectOpen, setConnectOpen] = useState(false);

  if (!hasAnyProvider) {
    return (
      <>
        <AiProvidersEmptyState onConnectClick={() => setConnectOpen(true)} />
        <ConnectProviderDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
        />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<Skeleton className="h-16 w-full" />}>
        <SimpleModeSection />
      </Suspense>
      {hasDeco ? <DecoCreditsHero /> : <DecoNudgeCard />}
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
            <Page.Title>AI Providers</Page.Title>
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
