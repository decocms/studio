/**
 * ConnectSourceDialog — the report app's per-source "Connect" deep link
 * (`studio://navigate?main=connect-sources&field=<id>`, intercepted in
 * project-app-view.tsx) rendered as a plain modal over the report, instead of
 * swapping the main panel to the onboarding-style connect-sources tab. Opens
 * the exact same SA-binding / OAuth+config dialogs as the companion cards:
 *   - GA4/GSC on the shared-SA lane → SaBindingDialog
 *   - already linked (or just linked) → CompanionConfigDialog
 *   - OAuth lane, not linked yet → run the OAuth connect immediately behind a
 *     small progress dialog; once linked the card flips and the config dialog
 *     renders on the next pass.
 */
import { siteUrlToHost } from "@decocms/shared/reports/site-url";
import { Suspense, useState, type ReactNode } from "react";
import { ErrorBoundary } from "@/components/error-boundary";
import { authClient } from "@/lib/auth-client";
import { useT } from "@/i18n/use-t.ts";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
  WellKnownOrgMCPId,
} from "@/sdk";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Loading01 } from "@untitledui/icons";
import { IntegrationIcon } from "@/components/integration-icon";
import { CompanionConfigDialog, SaBindingDialog } from "./companion-card.tsx";
import type { CompanionCardModel } from "./companions-core.ts";
import {
  type BindProvider,
  PROVIDER_BY_BINDING_TYPE,
} from "./companion-forms/sa-binding-copy.ts";
import {
  useCommerceCompanions,
  useCommerceDiscoverySiteUrl,
} from "./use-commerce-companions.ts";
import { useConnectCompanion } from "./use-connect-companion.ts";

/** Minimal modal for the loading / error shells around the real dialogs. */
function StatusDialog({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("commerceOnboarding.connectSourceDialog.title")}
          </DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function SpinnerRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
      <Loading01 size={16} className="animate-spin" />
      <span>{label}</span>
    </div>
  );
}

export function ConnectSourceDialog({
  field,
  onClose,
}: {
  field: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <ErrorBoundary
      fallback={() => (
        <StatusDialog onClose={onClose}>
          <p className="text-sm text-muted-foreground">
            {t("routes.commerceOnboarding.connectModal.loadError")}
          </p>
        </StatusDialog>
      )}
    >
      <Suspense
        fallback={
          <StatusDialog onClose={onClose}>
            <SpinnerRow
              label={t("commerceOnboarding.connectSourceDialog.loading")}
            />
          </StatusDialog>
        }
      >
        <ConnectSourceDialogContent field={field} onClose={onClose} />
      </Suspense>
    </ErrorBoundary>
  );
}

function ConnectSourceDialogContent({
  field,
  onClose,
}: {
  field: string;
  onClose: () => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const cdConnectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(org.id);
  const selfClient = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });
  const { data: session } = authClient.useSession();
  const userId = session?.user?.id ?? "";

  const siteUrl = useCommerceDiscoverySiteUrl({
    selfClient,
    org,
    cdConnectionId,
  });
  const { cards } = useCommerceCompanions({
    selfClient,
    org,
    cdConnectionId,
    siteUrl,
  });
  const { connect, connectingFieldKey, error } = useConnectCompanion({
    selfClient,
    org,
    userId,
    cdConnectionId,
    domain: siteUrlToHost(siteUrl) ?? undefined,
    siteUrl,
  });

  const card = cards.find((c) => c.fieldKey === field);
  if (!card) {
    return (
      <StatusDialog onClose={onClose}>
        <p className="text-sm text-muted-foreground">
          {t("routes.commerceOnboarding.connectModal.loadError")}
        </p>
      </StatusDialog>
    );
  }

  // Same lane rule as CompanionCard's action branching: GA4/GSC default to the
  // shared-SA dialog unless they were actually satisfied via OAuth.
  const saProvider = PROVIDER_BY_BINDING_TYPE[card.bindingType] as
    | BindProvider
    | undefined;
  if (saProvider && card.boundVia !== "oauth") {
    return (
      <SaBindingDialog
        card={card}
        provider={saProvider}
        org={org}
        selfClient={selfClient}
        siteUrl={siteUrl}
        open
        onOpenChange={(open) => !open && onClose()}
        onOAuthInstead={card.satisfied ? undefined : () => void connect(card)}
      />
    );
  }

  if (card.satisfied && card.linkedConnectionId) {
    return (
      <Suspense
        fallback={
          <StatusDialog onClose={onClose}>
            <SpinnerRow
              label={t("commerceOnboarding.connectSourceDialog.loading")}
            />
          </StatusDialog>
        }
      >
        <CompanionConfigDialog
          card={card}
          org={org}
          selfClient={selfClient}
          connectionId={card.linkedConnectionId}
          contextSiteUrl={siteUrl}
          open
          onOpenChange={(open) => !open && onClose()}
        />
      </Suspense>
    );
  }

  return (
    <OauthConnectDialog
      card={card}
      connecting={connectingFieldKey === card.fieldKey}
      error={error}
      onConnect={() => void connect(card)}
      onClose={onClose}
    />
  );
}

/**
 * OAuth-lane connect in progress: fires `connect` once on mount (popup OAuth +
 * link write), showing a small progress dialog meanwhile. On success the
 * invalidations flip the card to linked and the parent re-renders straight
 * into the config dialog; on failure the error + retry stay here. Render-time
 * one-shot instead of a mount effect (no useEffect in this codebase), same
 * pattern as CmsAutoOpen in sandbox/preview/preview.tsx.
 */
function OauthConnectDialog({
  card,
  connecting,
  error,
  onConnect,
  onClose,
}: {
  card: CompanionCardModel;
  connecting: boolean;
  error: string | null;
  onConnect: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [started, setStarted] = useState(false);
  if (!started) {
    setStarted(true);
    queueMicrotask(onConnect);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && connecting) return; // don't close mid-OAuth
        if (!open) onClose();
      }}
    >
      <DialogContent aria-describedby={undefined} className="sm:max-w-lg">
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
        {error ? (
          <div className="flex flex-col gap-3">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={onConnect}
            >
              {t("routes.commerceOnboarding.companionSection.retry")}
            </Button>
          </div>
        ) : (
          <SpinnerRow
            label={t("commerceOnboarding.connectSourceDialog.connecting", {
              title: card.title,
            })}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
