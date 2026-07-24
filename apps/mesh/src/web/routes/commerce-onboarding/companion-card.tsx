import { IntegrationIcon } from "@/web/components/integration-icon";
import { KEYS } from "@/web/lib/query-keys";
import { useT } from "@/web/i18n/use-t.ts";
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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LinkBroken01, Loading01, Settings01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import { toast } from "sonner";
import type { CompanionCardModel } from "./companions-core.ts";
import {
  getConfigurationSummaryEntries,
  shouldAutoOpenCompanionConfig,
} from "./companions-core.ts";
import {
  CompanionCardView,
  ConfigureAction,
  ConnectAction,
  ConnectedAction,
} from "./companion-card-view.tsx";
import { COMPANION_CONFIG_FORMS } from "./companion-forms/registry.ts";
import { SaBindingForm } from "./companion-forms/sa-binding-form.tsx";
import {
  type BindProvider,
  PROVIDER_BY_BINDING_TYPE,
} from "./companion-forms/sa-binding-copy.ts";

/**
 * Loading placeholder that mirrors {@link CompanionCard}'s box model (square-ish
 * tile: icon row, title line, benefit line, action) so the grid doesn't jump
 * when real cards swap in.
 */
export function CompanionCardSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3 sm:h-full sm:flex-col sm:items-stretch sm:p-4">
      <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted/60" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
        <div className="hidden h-3 w-full animate-pulse rounded bg-muted/60 sm:block" />
      </div>
      <div className="h-8 w-20 shrink-0 animate-pulse rounded-lg bg-muted/60 sm:mt-auto sm:w-full" />
    </div>
  );
}

/** Ghost unlink button — reverts a linked source back to "Connect" so a wrong
 *  or stale link can be replaced. */
function UnlinkButton({
  title,
  disconnecting,
  disabled,
  onDisconnect,
}: {
  title: string;
  disconnecting: boolean;
  disabled: boolean;
  onDisconnect: () => void;
}) {
  const t = useT();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground hover:text-destructive"
          disabled={disabled || disconnecting}
          onClick={onDisconnect}
          aria-label={t(
            "commerceOnboarding.companionCard.disconnectAriaLabel",
            {
              title,
            },
          )}
        >
          {disconnecting ? (
            <Loading01 size={16} className="animate-spin" />
          ) : (
            <LinkBroken01 size={16} />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {t("commerceOnboarding.companionCard.disconnect")}
      </TooltipContent>
    </Tooltip>
  );
}

export function CompanionCard({
  card,
  connecting,
  disconnecting,
  disabled,
  onConnect,
  onDisconnect,
  org,
  selfClient,
  siteUrl,
  autoOpenConfigFieldKey,
  onAutoOpenConfigHandled,
}: {
  card: CompanionCardModel;
  connecting: boolean;
  disconnecting: boolean;
  disabled: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  org: { id: string; slug: string };
  selfClient: Client;
  siteUrl?: string;
  autoOpenConfigFieldKey: string | null;
  onAutoOpenConfigHandled: () => void;
}) {
  const linkedConnectionId = card.linkedConnectionId;
  // GA4/GSC use the shared-SA lane by default; only fall back to the OAuth gear
  // when the card was actually satisfied via OAuth (has a companion connection).
  const saProvider = PROVIDER_BY_BINDING_TYPE[card.bindingType] as
    | BindProvider
    | undefined;
  const useSaFlow = !!saProvider && card.boundVia !== "oauth";
  // Linked but not usable yet (no credentials / no repo / no property) — must
  // read as "needs setup", never "Connected". Only the OAuth/config-form lane
  // can hit this; SA bindings are configured the moment they verify.
  const needsConfig = card.satisfied && !card.configured;

  const action =
    useSaFlow && saProvider ? (
      <SaConnectAction
        card={card}
        provider={saProvider}
        org={org}
        selfClient={selfClient}
        siteUrl={siteUrl}
        onOAuthInstead={onConnect}
        disabled={disabled}
        connecting={connecting}
        primary={card.required}
      />
    ) : card.satisfied && linkedConnectionId ? (
      <div className="flex items-center justify-end gap-1 sm:justify-start">
        {/* Own Suspense boundary: CompanionConfiguration opens the companion's
            own MCP client (useMCPClient → useSuspenseQuery). Isolating it keeps
            a connecting companion from reverting the whole grid to skeletons. */}
        <Suspense fallback={<ConfigGearFallback />}>
          <CompanionConfiguration
            card={card}
            org={org}
            selfClient={selfClient}
            connectionId={linkedConnectionId}
            contextSiteUrl={siteUrl}
            variant={needsConfig ? "configure" : "gear"}
            disabled={disabled}
            autoOpen={
              needsConfig ||
              shouldAutoOpenCompanionConfig({
                autoOpenFieldKey: autoOpenConfigFieldKey,
                card,
              })
            }
            onAutoOpenHandled={onAutoOpenConfigHandled}
          />
        </Suspense>
        <UnlinkButton
          title={card.title}
          disconnecting={disconnecting}
          disabled={disabled}
          onDisconnect={onDisconnect}
        />
      </div>
    ) : (
      <ConnectAction
        connecting={connecting}
        disabled={disabled}
        title={card.title}
        primary={card.required}
        onConnect={onConnect}
      />
    );

  return (
    <CompanionCardView
      icon={card.icon}
      title={card.title}
      headline={card.headline}
      required={card.required && !card.satisfied}
      attention={needsConfig}
      action={action}
    />
  );
}

/** The shared-SA connect/config action for GA4/GSC: a "Conectar" button (or a
 *  "Conectado" + gear once bound) that opens a dialog with the step-by-step
 *  binding form. The low-key "authorize via OAuth" link inside the dialog runs
 *  the legacy OAuth flow for anyone who prefers it. No companion MCP client is
 *  needed — the binding lives in commerce-discovery, not a Studio connection. */
function SaConnectAction({
  card,
  provider,
  org,
  selfClient,
  siteUrl,
  onOAuthInstead,
  disabled,
  connecting,
  primary,
}: {
  card: CompanionCardModel;
  provider: BindProvider;
  org: { id: string; slug: string };
  selfClient: Client;
  siteUrl?: string;
  onOAuthInstead: () => void;
  disabled: boolean;
  connecting: boolean;
  primary?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [savePending, setSavePending] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next && savePending) return; // don't close mid-verify
    setOpen(next);
  };

  return (
    <>
      {card.satisfied ? (
        <ConnectedAction
          controls={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  onClick={() => setOpen(true)}
                  aria-label={t(
                    "commerceOnboarding.companionCard.configureAriaLabel",
                    { title: card.title },
                  )}
                >
                  <Settings01 size={16} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("commerceOnboarding.companionCard.editConfiguration")}
              </TooltipContent>
            </Tooltip>
          }
        />
      ) : (
        <ConnectAction
          connecting={connecting}
          disabled={disabled}
          title={card.title}
          primary={primary}
          onConnect={() => setOpen(true)}
        />
      )}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
            <IntegrationIcon
              icon={card.icon}
              name={card.title}
              size="md"
              fit="contain"
              className="p-1.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle>{card.title}</DialogTitle>
              <DialogDescription>
                {t("commerceOnboarding.companionCard.grantAccessDescription")}
              </DialogDescription>
            </div>
          </DialogHeader>
          <SaBindingForm
            provider={provider}
            siteUrl={siteUrl}
            selfClient={selfClient}
            org={org}
            initialResourceId={card.boundResource ?? undefined}
            onDone={() => setOpen(false)}
            onIsPendingChange={setSavePending}
            onOAuthInstead={
              card.satisfied
                ? undefined
                : () => {
                    setOpen(false);
                    onOAuthInstead();
                  }
            }
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

interface CompanionConfigurationProps {
  card: CompanionCardModel;
  org: { id: string; slug: string };
  selfClient: Client;
  connectionId: string;
  contextSiteUrl?: string;
  /** "gear" = quiet edit button for a configured source; "configure" = amber
   *  "finish setup" button for a linked-but-unconfigured one. */
  variant: "gear" | "configure";
  disabled: boolean;
  autoOpen: boolean;
  onAutoOpenHandled: () => void;
}

/** Gear placeholder while the companion MCP client connects — keeps the action
 *  slot from jumping when the real trigger swaps in. */
function ConfigGearFallback() {
  return (
    <div className="size-8 shrink-0 animate-pulse rounded-lg bg-muted/60" />
  );
}

function CompanionConfiguration({
  card,
  org,
  selfClient,
  connectionId,
  contextSiteUrl,
  variant,
  disabled,
  autoOpen,
  onAutoOpenHandled,
}: CompanionConfigurationProps) {
  const t = useT();
  const companionClient = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [dialogOpen, setDialogOpen] = useState(autoOpen);
  const [isSavePending, setIsSavePending] = useState(false);
  const queryClient = useQueryClient();

  const FormComponent = COMPANION_CONFIG_FORMS[card.bindingType];
  const savedConfigEntries = getConfigurationSummaryEntries(
    card.configurationState,
  );

  const closeDialog = () => {
    setDialogOpen(false);
    if (autoOpen) {
      onAutoOpenHandled();
    }
  };

  const handleDialogOpenChange = (open: boolean) => {
    if (!open && isSavePending) {
      return;
    }
    if (!open) {
      closeDialog();
      return;
    }
    setDialogOpen(true);
  };

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      await selfClient.callTool({
        name: "COLLECTION_CONNECTIONS_DELETE",
        arguments: { id: connectionId, force: true },
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: KEYS.commerceDiscoveryCompanionConnectionsPrefix(org.id),
      });
      toast.success(
        t("commerceOnboarding.companionCard.disconnectedSuccess", {
          title: card.title,
        }),
      );
      closeDialog();
    },
    onError: () => {
      toast.error(t("commerceOnboarding.companionCard.disconnectError"));
    },
  });

  // No config form for this binding → nothing to open. A "configure" variant
  // still needs a visible trigger, so it degrades to a quiet gear-less noop
  // only when there's genuinely nothing to configure.
  if (!FormComponent) {
    return null;
  }

  const trigger =
    variant === "configure" ? (
      <ConfigureAction
        disabled={disabled}
        title={card.title}
        onConfigure={() => setDialogOpen(true)}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => setDialogOpen(true)}
            aria-label={t(
              "commerceOnboarding.companionCard.configureAriaLabel",
              { title: card.title },
            )}
          >
            <Settings01 size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {savedConfigEntries.length > 0
            ? t("commerceOnboarding.companionCard.editConfiguration")
            : t("commerceOnboarding.companionCard.configure")}
        </TooltipContent>
      </Tooltip>
    );

  return (
    <>
      {trigger}

      <Dialog open={dialogOpen} onOpenChange={handleDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
            <IntegrationIcon
              icon={card.icon}
              name={card.title}
              size="md"
              fit="contain"
              className="p-1.5"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <DialogTitle>{card.title}</DialogTitle>
              <DialogDescription>
                {t("commerceOnboarding.companionCard.configureDescription", {
                  title: card.title,
                })}
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
            onDone={closeDialog}
            onDisconnect={() => disconnectMutation.mutate()}
            onIsPendingChange={setIsSavePending}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
