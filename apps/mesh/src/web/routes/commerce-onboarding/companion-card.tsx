import { IntegrationIcon } from "@/web/components/integration-icon";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { useMCPClient } from "@decocms/mesh-sdk";
import { CheckCircle, Edit03, Loading01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import type { CompanionCardModel } from "./companions-core.ts";
import { getConfigurationSummaryEntries } from "./companions-core.ts";
import { COMPANION_CONFIG_FORMS } from "./companion-forms/registry.ts";

/**
 * Loading placeholder that mirrors {@link CompanionCard}'s box model (same
 * wrapper, icon row, and two unlock lines) so its height matches a real card
 * instead of a short generic block.
 */
export function CompanionCardSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted/60" />
        <div className="h-4 w-32 animate-pulse rounded bg-muted/60" />
        <div className="ml-auto h-8 w-20 animate-pulse rounded-lg bg-muted/60" />
      </div>
      <div className="flex flex-col gap-1 px-1 py-2">
        <div className="p-1">
          <div className="h-5 w-40 animate-pulse rounded bg-muted/60" />
        </div>
        <div className="p-1">
          <div className="h-5 w-56 animate-pulse rounded bg-muted/60" />
        </div>
      </div>
    </div>
  );
}

function UnlockLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 p-1">
      <CheckCircle size={14} className="shrink-0 text-blue-500" />
      <p className="text-sm text-foreground">{children}</p>
    </div>
  );
}

export function CompanionCard({
  card,
  connecting,
  disabled,
  onConnect,
  org,
  selfClient,
  siteUrl,
}: {
  card: CompanionCardModel;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
  org: { id: string; slug: string };
  selfClient: Client;
  siteUrl?: string;
}) {
  const linkedConnectionId = card.linkedConnectionId;
  const savedConfigEntries = getConfigurationSummaryEntries(
    card.configurationState,
  );

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <IntegrationIcon
          icon={card.icon}
          name={card.title}
          size="sm"
          fit="contain"
          className="p-1.5"
        />
        <p className="flex-1 text-sm text-foreground">{card.title}</p>
        {card.satisfied ? (
          <div className="flex h-8 items-center gap-2 px-3 text-sm text-muted-foreground">
            <CheckCircle size={16} /> Connected
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || connecting}
            onClick={onConnect}
            aria-label={`Connect ${card.title}`}
          >
            {connecting ? (
              <Loading01 size={16} className="animate-spin" />
            ) : (
              "Connect"
            )}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1 px-1 py-2">
        {card.checks !== null && (
          <UnlockLine>+ {card.checks} checks</UnlockLine>
        )}
        {card.headline && <UnlockLine>{card.headline}</UnlockLine>}
        {card.bullets.map((b) => (
          <UnlockLine key={b}>{b}</UnlockLine>
        ))}
        {!card.satisfied && card.candidateConnectionId && (
          <p className="px-1 text-xs text-muted-foreground">
            Using your existing {card.title}
          </p>
        )}
      </div>
      {card.satisfied && linkedConnectionId && (
        // Own Suspense boundary: CompanionConfiguration opens the companion's own
        // MCP client (useMCPClient → useSuspenseQuery). Isolating it here keeps a
        // connecting companion from bubbling up and reverting the whole section
        // to its skeleton — only this card's config area shows a placeholder.
        <Suspense fallback={<CompanionConfigurationFallback />}>
          <CompanionConfiguration
            card={card}
            org={org}
            selfClient={selfClient}
            connectionId={linkedConnectionId}
            savedConfigEntries={savedConfigEntries}
            contextSiteUrl={siteUrl}
          />
        </Suspense>
      )}
    </div>
  );
}

function maskConfigValue(key: string, value: string) {
  const isSensitiveKey = /(token|secret|password|appKey|key)$/i.test(key);
  return isSensitiveKey ? "••••••••" : value;
}

interface CompanionConfigurationProps {
  card: CompanionCardModel;
  org: { id: string; slug: string };
  selfClient: Client;
  connectionId: string;
  savedConfigEntries: Array<{ key: string; label: string; value: string }>;
  contextSiteUrl?: string;
}

interface NotAvailableNoteProps {
  title: string;
}

function NotAvailableNote({ title }: NotAvailableNoteProps) {
  return (
    <div className="grid gap-3 border-t border-border pt-3">
      <p className="text-xs text-muted-foreground">
        Configuration isn't available here yet for {title}.
      </p>
    </div>
  );
}

/**
 * Placeholder shown while {@link CompanionConfiguration}'s companion MCP client
 * connects. Mirrors the config section's box model (top border + header row with
 * a label and an action) so the card doesn't jump when the real content swaps in.
 */
function CompanionConfigurationFallback() {
  return (
    <div className="grid gap-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="h-5 w-24 animate-pulse rounded bg-muted/60" />
        <div className="h-8 w-20 animate-pulse rounded-lg bg-muted/60" />
      </div>
    </div>
  );
}

function CompanionConfiguration({
  card,
  org,
  selfClient,
  connectionId,
  savedConfigEntries,
  contextSiteUrl,
}: CompanionConfigurationProps) {
  const companionClient = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isSavePending, setIsSavePending] = useState(false);

  const FormComponent = COMPANION_CONFIG_FORMS[card.bindingType];

  const handleDialogOpenChange = (open: boolean) => {
    if (!open && isSavePending) {
      return;
    }
    setDialogOpen(open);
  };

  return (
    <>
      <div className="grid gap-3 border-t border-border pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-sm font-medium text-foreground">Configuration</p>
            {savedConfigEntries.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No configuration values saved yet.
              </p>
            )}
          </div>
          {savedConfigEntries.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDialogOpen(true)}
                  aria-label={`Edit ${card.title} configuration`}
                  disabled={!FormComponent}
                >
                  <Edit03 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit configuration</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(true)}
              disabled={!FormComponent}
            >
              Configure
            </Button>
          )}
        </div>
        {savedConfigEntries.length > 0 && (
          <dl className="grid gap-2">
            {savedConfigEntries.map((entry) => (
              <div
                key={entry.key}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <dt className="text-muted-foreground">{entry.label}</dt>
                <dd className="truncate text-foreground">
                  {maskConfigValue(entry.key, entry.value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      {FormComponent ? (
        <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader className="flex-row items-stretch gap-3 space-y-0 text-left">
              <IntegrationIcon
                icon={card.icon}
                name={card.title}
                size="md"
                fit="contain"
                className="h-auto w-auto min-w-0 self-stretch aspect-square p-1.5"
              />
              <div className="flex flex-col gap-1">
                <DialogTitle>{card.title}</DialogTitle>
                <DialogDescription>
                  Configure {card.title} to enrich data
                </DialogDescription>
              </div>
            </DialogHeader>
            <FormComponent
              card={card}
              connectionId={connectionId}
              companionClient={companionClient}
              selfClient={selfClient}
              org={org}
              contextSiteUrl={contextSiteUrl}
              onDone={() => setDialogOpen(false)}
              onIsPendingChange={setIsSavePending}
            />
          </DialogContent>
        </Dialog>
      ) : (
        <NotAvailableNote title={card.title} />
      )}
    </>
  );
}
