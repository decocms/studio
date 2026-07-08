import { IntegrationIcon } from "@/web/components/integration-icon";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
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
import { CheckCircle, Loading01, Settings01 } from "@untitledui/icons";
import { Suspense, useState } from "react";
import type { CompanionCardModel } from "./companions-core.ts";
import {
  getConfigurationSummaryEntries,
  shouldAutoOpenCompanionConfig,
} from "./companions-core.ts";
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
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 sm:h-full sm:flex-col sm:items-stretch">
      <div className="size-9 shrink-0 animate-pulse rounded-lg bg-muted/60" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-4 w-24 animate-pulse rounded bg-muted/60" />
        <div className="h-3 w-full animate-pulse rounded bg-muted/60" />
      </div>
      <div className="h-8 w-20 shrink-0 animate-pulse rounded-lg bg-muted/60 sm:mt-auto sm:w-full" />
    </div>
  );
}

const AREA_BADGE_CLASS =
  "rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground";

export function CompanionCard({
  card,
  connecting,
  disabled,
  onConnect,
  org,
  selfClient,
  siteUrl,
  autoOpenConfigFieldKey,
  onAutoOpenConfigHandled,
}: {
  card: CompanionCardModel;
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
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
      />
    ) : card.satisfied && linkedConnectionId ? (
      <div className="flex items-center justify-end gap-1 sm:justify-start">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <CheckCircle size={16} className="text-success" /> Conectado
        </span>
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
            autoOpen={shouldAutoOpenCompanionConfig({
              autoOpenFieldKey: autoOpenConfigFieldKey,
              card,
            })}
            onAutoOpenHandled={onAutoOpenConfigHandled}
          />
        </Suspense>
      </div>
    ) : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="sm:w-full"
        disabled={disabled || connecting}
        onClick={onConnect}
        aria-label={`Conectar ${card.title}`}
      >
        {connecting ? (
          <Loading01 size={16} className="animate-spin" />
        ) : (
          "Conectar"
        )}
      </Button>
    );

  return (
    // Responsive: a compact horizontal row on mobile (icon · text · action),
    // a vertical tile in the desktop grid (sm+). The old inline "Configuração"
    // block lives in the gear's dialog so a connected card stays compact.
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 sm:h-full sm:flex-col sm:items-stretch">
      {/* Icon row: on the desktop tile the badge sits top-right, centered with
          the icon; on mobile the badge renders as an eyebrow in the text block
          instead, so the name never clips against it. */}
      <div className="shrink-0 self-start sm:flex sm:w-full sm:items-center sm:justify-between sm:gap-2">
        <IntegrationIcon
          icon={card.icon}
          name={card.title}
          size="sm"
          fit="contain"
          className="shrink-0 p-1.5"
        />
        {card.area && (
          <span className={cn("hidden sm:inline-block", AREA_BADGE_CLASS)}>
            {card.area}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {card.area && (
          <span className={cn("mb-1 inline-block sm:hidden", AREA_BADGE_CLASS)}>
            {card.area}
          </span>
        )}
        <p className="text-sm font-medium text-foreground">{card.title}</p>
        {card.headline && (
          <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
            {card.headline}
          </p>
        )}
      </div>

      <div className="shrink-0 sm:mt-auto sm:w-full sm:pt-1">{action}</div>
    </div>
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
}: {
  card: CompanionCardModel;
  provider: BindProvider;
  org: { id: string; slug: string };
  selfClient: Client;
  siteUrl?: string;
  onOAuthInstead: () => void;
  disabled: boolean;
  connecting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [savePending, setSavePending] = useState(false);

  const handleOpenChange = (next: boolean) => {
    if (!next && savePending) return; // don't close mid-verify
    setOpen(next);
  };

  return (
    <>
      {card.satisfied ? (
        <div className="flex items-center justify-end gap-1 sm:justify-start">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle size={16} className="text-success" /> Conectado
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                onClick={() => setOpen(true)}
                aria-label={`Configurar ${card.title}`}
              >
                <Settings01 size={16} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Editar configuração</TooltipContent>
          </Tooltip>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="sm:w-full"
          disabled={disabled || connecting}
          onClick={() => setOpen(true)}
          aria-label={`Conectar ${card.title}`}
        >
          {connecting ? (
            <Loading01 size={16} className="animate-spin" />
          ) : (
            "Conectar"
          )}
        </Button>
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
                Conceda acesso ao nosso leitor e informe o identificador
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
  autoOpen,
  onAutoOpenHandled,
}: CompanionConfigurationProps) {
  const companionClient = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const [dialogOpen, setDialogOpen] = useState(autoOpen);
  const [isSavePending, setIsSavePending] = useState(false);

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

  // No config form for this binding → nothing to open; skip the gear entirely.
  if (!FormComponent) {
    return null;
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            onClick={() => setDialogOpen(true)}
            aria-label={`Configurar ${card.title}`}
          >
            <Settings01 size={16} />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {savedConfigEntries.length > 0 ? "Editar configuração" : "Configurar"}
        </TooltipContent>
      </Tooltip>

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
                Configure o {card.title} para enriquecer os dados
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
            onIsPendingChange={setIsSavePending}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
