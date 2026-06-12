import { Suspense, useState } from "react";
import { AlertCircle, MessageTextSquare01 } from "@untitledui/icons";
import { Page } from "@/web/components/page";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { SettingsPage } from "@/web/components/settings/settings-section";
import { ErrorBoundary } from "@/web/components/error-boundary";
import {
  useOrgChannels,
  type ChannelPlatform,
} from "@/web/hooks/collections/use-channels";
import {
  ConnectedChannelsSection,
  PlatformAddButtons,
} from "./connected-channels-section";
import { WhatsAppEnableDialog } from "./whatsapp-enable-dialog";

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

function EmptyState({ onAdd }: { onAdd: (platform: ChannelPlatform) => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-12 text-center">
      <MessageTextSquare01 size={28} className="text-muted-foreground" />
      <div className="space-y-1">
        <p className="text-sm font-medium">No channels yet</p>
        <p className="text-sm text-muted-foreground">
          Connect WhatsApp so members can chat with a Decopilot agent over the
          shared decoCMS number.
        </p>
      </div>
      <PlatformAddButtons onAdd={onAdd} busy={false} />
    </div>
  );
}

function OrgChannelsContent() {
  const channels = useOrgChannels();
  const [whatsappOpen, setWhatsappOpen] = useState(false);

  // The only platform today is WhatsApp — enable-only (pick an agent), no wizard.
  const handleAdd = (_platform: ChannelPlatform) => setWhatsappOpen(true);

  return (
    <>
      {channels.length === 0 ? (
        <EmptyState onAdd={handleAdd} />
      ) : (
        <ConnectedChannelsSection
          channels={channels}
          onAdd={handleAdd}
          busy={false}
        />
      )}

      {whatsappOpen && (
        <WhatsAppEnableDialog open onOpenChange={setWhatsappOpen} />
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
