import { siteUrlToHost } from "@decocms/shared/reports/site-url";
import { IntegrationIcon } from "@/components/integration-icon";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
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
import { useMCPClient } from "@/sdk";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loading01, SlashCircle01 } from "@untitledui/icons";
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
  ConnectedConfigButton,
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
            <SlashCircle01 size={16} />
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
      needsConfig ? (
        <div className="flex items-center justify-end gap-1 sm:justify-start">
          <Suspense fallback={<ConfigGearFallback />}>
            <CompanionConfiguration
              card={card}
              org={org}
              selfClient={selfClient}
              connectionId={linkedConnectionId}
              contextSiteUrl={siteUrl}
              variant="configure"
              disabled={disabled}
              autoOpen={shouldAutoOpenCompanionConfig({
                autoOpenFieldKey: autoOpenConfigFieldKey,
                card,
              })}
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
        <ConnectedAction
          detail={card.connectedDetail}
          controls={
            <>
              {/* Own Suspense boundary: CompanionConfiguration opens the
                  companion's own MCP client (useMCPClient →
                  useSuspenseQuery). Isolating it keeps a connecting companion
                  from reverting the whole grid to skeletons. */}
              <Suspense fallback={<ConfigGearFallback />}>
                <CompanionConfiguration
                  card={card}
                  org={org}
                  selfClient={selfClient}
                  connectionId={linkedConnectionId}
                  contextSiteUrl={siteUrl}
                  variant="gear"
                  disabled={disabled}
                  autoOpen={shouldAutoOpenCompanionConfig({
                    autoOpenFieldKey: autoOpenConfigFieldKey,
                    card,
                  })}
                  onAutoOpenHandled={onAutoOpenConfigHandled}
                />
              </Suspense>
              <UnlinkButton
                title={card.title}
                disconnecting={disconnecting}
                disabled={disabled}
                onDisconnect={onDisconnect}
              />
            </>
          }
        />
      )
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
    <>
      <CompanionCardView
        icon={card.icon}
        title={card.title}
        headline={card.headline}
        required={card.required && !card.satisfied}
        attention={needsConfig}
        action={action}
      />
    </>
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

  return (
    <>
      {card.satisfied ? (
        <ConnectedAction
          detail={card.connectedDetail}
          controls={
            <Tooltip>
              <TooltipTrigger asChild>
                <ConnectedConfigButton
                  ariaLabel={t(
                    "commerceOnboarding.companionCard.configureAriaLabel",
                    { title: card.title },
                  )}
                  onClick={() => setOpen(true)}
                />
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

      <SaBindingDialog
        card={card}
        provider={provider}
        org={org}
        selfClient={selfClient}
        siteUrl={siteUrl}
        open={open}
        onOpenChange={setOpen}
        onOAuthInstead={
          card.satisfied
            ? undefined
            : () => {
                setOpen(false);
                onOAuthInstead();
              }
        }
      />
    </>
  );
}

/** The shared-SA binding dialog (step-by-step grant + resource id form) as a
 *  controlled component, so both the card's connect action and the report's
 *  deep-link dialog (connect-source-dialog.tsx) open the exact same thing. */
export function SaBindingDialog({
  card,
  provider,
  org,
  selfClient,
  siteUrl,
  open,
  onOpenChange,
  onOAuthInstead,
}: {
  card: CompanionCardModel;
  provider: BindProvider;
  org: { id: string; slug: string };
  selfClient: Client;
  siteUrl?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOAuthInstead?: () => void;
}) {
  const [savePending, setSavePending] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next && savePending) return; // don't close mid-verify
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* No DialogDescription: the numbered steps immediately below the title
          are the description, so `aria-describedby` is opted out explicitly
          rather than left dangling. */}
      <DialogContent
        aria-describedby={undefined}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
      >
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <IntegrationIcon
            icon={card.icon}
            name={card.title}
            size="sm"
            fit="contain"
            className="p-1"
          />
          <DialogTitle className="min-w-0 flex-1">{card.title}</DialogTitle>
        </DialogHeader>
        <SaBindingForm
          provider={provider}
          siteUrl={siteUrl}
          siteHost={siteUrlToHost(siteUrl)}
          selfClient={selfClient}
          org={org}
          initialResourceId={card.boundResource ?? undefined}
          onDone={() => onOpenChange(false)}
          onIsPendingChange={setSavePending}
          onOAuthInstead={onOAuthInstead}
        />
      </DialogContent>
    </Dialog>
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
  const [dialogOpen, setDialogOpen] = useState(autoOpen);

  const savedConfigEntries = getConfigurationSummaryEntries(
    card.configurationState,
    t,
  );

  const closeDialog = () => {
    setDialogOpen(false);
    if (autoOpen) {
      onAutoOpenHandled();
    }
  };

  // No config form for this binding → nothing to open. A "configure" variant
  // still needs a visible trigger, so it degrades to a quiet gear-less noop
  // only when there's genuinely nothing to configure.
  if (!COMPANION_CONFIG_FORMS[card.bindingType]) {
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
          <ConnectedConfigButton
            ariaLabel={t(
              "commerceOnboarding.companionCard.configureAriaLabel",
              { title: card.title },
            )}
            onClick={() => setDialogOpen(true)}
          />
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

      <CompanionConfigDialog
        card={card}
        org={org}
        selfClient={selfClient}
        connectionId={connectionId}
        contextSiteUrl={contextSiteUrl}
        open={dialogOpen}
        onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}
      />
    </>
  );
}

/** The companion's config-form dialog (repo/property/credentials picker) as a
 *  controlled component, so both the card's gear/finish-setup triggers and the
 *  report's deep-link dialog (connect-source-dialog.tsx) open the same thing.
 *  Suspends while the companion MCP client connects — callers own the
 *  Suspense boundary. */
export function CompanionConfigDialog({
  card,
  org,
  selfClient,
  connectionId,
  contextSiteUrl,
  open,
  onOpenChange,
}: {
  card: CompanionCardModel;
  org: { id: string; slug: string };
  selfClient: Client;
  connectionId: string;
  contextSiteUrl?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const companionClient = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [isSavePending, setIsSavePending] = useState(false);
  const queryClient = useQueryClient();

  const FormComponent = COMPANION_CONFIG_FORMS[card.bindingType];

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
      onOpenChange(false);
    },
    onError: () => {
      toast.error(t("commerceOnboarding.companionCard.disconnectError"));
    },
  });

  if (!FormComponent) {
    return null;
  }

  const handleDialogOpenChange = (next: boolean) => {
    if (!next && isSavePending) {
      return;
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <IntegrationIcon
            icon={card.icon}
            name={card.title}
            size="sm"
            fit="contain"
            className="p-1"
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
          onDone={() => onOpenChange(false)}
          onDisconnect={() => disconnectMutation.mutate()}
          onIsPendingChange={setIsSavePending}
        />
      </DialogContent>
    </Dialog>
  );
}
