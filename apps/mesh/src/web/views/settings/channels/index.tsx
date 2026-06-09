import { Suspense, useState } from "react";
import { AlertCircle, MessageTextSquare01 } from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Button } from "@deco/ui/components/button.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { useOrgChannels } from "@/web/hooks/collections/use-channels";
import {
  ConnectedChannelsSection,
  type ResumeTarget,
} from "./connected-channels-section";
import { SetupWizardDialog } from "./setup-wizard-dialog";

function ErrorFallback({ error }: { error: Error }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-4 text-destructive">
      <AlertCircle size={16} />
      <span className="text-sm font-medium">
        Failed to load channels: {error.message}
      </span>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
      <MessageTextSquare01 size={28} className="text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">No channels yet</p>
        <p className="text-sm text-muted-foreground">
          Connect Microsoft Teams or Discord so a bot can chat with a Decopilot
          agent in this organization.
        </p>
      </div>
      <Button size="sm" onClick={onAdd}>
        Add channel
      </Button>
    </div>
  );
}

function OrgChannelsContent() {
  const channels = useOrgChannels();
  // null = closed; otherwise { resume? } describes the open wizard.
  const [wizard, setWizard] = useState<{ resume?: ResumeTarget } | null>(null);

  return (
    <>
      {channels.length === 0 ? (
        <EmptyState onAdd={() => setWizard({})} />
      ) : (
        <ConnectedChannelsSection
          channels={channels}
          onAdd={() => setWizard({})}
          onResume={(resume) => setWizard({ resume })}
        />
      )}

      {wizard !== null && (
        <SetupWizardDialog
          key={wizard.resume?.channelId ?? "new"}
          open
          onOpenChange={(o) => !o && setWizard(null)}
          resume={wizard.resume}
        />
      )}
    </>
  );
}

export function OrgChannelsPage() {
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>Channels</Page.Title>
            <ErrorBoundary
              fallback={({ error }) => (
                <ErrorFallback
                  error={error ?? new Error("Failed to load channels")}
                />
              )}
            >
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <OrgChannelsContent />
              </Suspense>
            </ErrorBoundary>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
