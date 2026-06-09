import { Suspense, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertCircle, MessageTextSquare01 } from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  invalidateChannels,
  useChannelClient,
  useOrgChannels,
  type ChannelType,
} from "@/web/hooks/collections/use-channels";
import {
  ConnectedChannelsSection,
  PlatformAddButtons,
  type WizardTarget,
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

function EmptyState({
  onAdd,
  busy,
}: {
  onAdd: (platform: ChannelType) => void;
  busy: boolean;
}) {
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
      <PlatformAddButtons onAdd={onAdd} busy={busy} />
    </div>
  );
}

function OrgChannelsContent() {
  const channels = useOrgChannels();
  const { org, client } = useChannelClient();
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<WizardTarget | null>(null);

  // Create the draft channel (+ its bot) on click, then open the wizard at the
  // first step. Done here (not in the dialog) so platform selection is a plain
  // button rather than an in-dialog grid.
  const createDraft = useMutation({
    mutationFn: async (platform: ChannelType) => {
      const result = (await client.callTool({
        name: "CHANNEL_CREATE",
        arguments: { channelType: platform },
      })) as { structuredContent?: { id: string; webhookUrl: string } };
      if (!result.structuredContent)
        throw new Error("Failed to create channel");
      return { platform, ...result.structuredContent };
    },
    onSuccess: (data) => {
      invalidateChannels(queryClient, org.id);
      setTarget({
        platform: data.platform,
        channelId: data.id,
        webhookUrl: data.webhookUrl,
        step: "instructions",
      });
    },
    onError: (err) => toast.error(`Failed to start setup: ${err.message}`),
  });

  return (
    <>
      {channels.length === 0 ? (
        <EmptyState
          onAdd={(p) => createDraft.mutate(p)}
          busy={createDraft.isPending}
        />
      ) : (
        <ConnectedChannelsSection
          channels={channels}
          onAdd={(p) => createDraft.mutate(p)}
          onResume={setTarget}
          busy={createDraft.isPending}
        />
      )}

      {target && (
        <SetupWizardDialog
          key={target.channelId}
          open
          target={target}
          onOpenChange={(o) => !o && setTarget(null)}
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
