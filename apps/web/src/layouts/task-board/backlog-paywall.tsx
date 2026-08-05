/**
 * Board paywall — a persistent banner at the top of the task board for commerce
 * orgs whose diagnostic is still locked (unpaid), plus an unlock modal.
 *
 * The board stays fully usable: the user can create and run their own tasks.
 * What's paywalled is the auto-generated plano de trabalho — the diagnostic run
 * computes it but withholds the push until the org unlocks the enriched
 * diagnostic (see commerce-skills). The modal auto-opens once per session and
 * can be dismissed ("Agora não"); the banner stays and re-opens it on click.
 * "Desbloquear" starts the Stripe checkout via the CD MCP. Everything reads the
 * diagnostic's `locked` flag, so it all clears itself the moment payment lands.
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  CheckCircle,
  Lightning01,
  Loading01,
} from "@untitledui/icons";
import { useProjectContext } from "@/sdk";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { ErrorBoundary } from "@/components/error-boundary";
import {
  type CommerceDiscoveryClient,
  commerceReportNavTarget,
  useCommerceDiagnostic,
} from "@/hooks/use-commerce-diagnostic";
import { unwrapToolResult } from "@/routes/commerce-onboarding/companions-core";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

/** A preview of the unlocked board (carries the brand-lime edge), used as the
 *  modal hero — hosted on the deco CDN. Shared with `subscription-paywall-
 *  dialog.tsx` so the board has one hero image across its paywalls, not two. */
export const KANBAN_PREVIEW_SRC =
  "https://decoims.com/image?src=decocms%2F7263a67f-fb83-410b-a5f2-e54e87deaaac%2Freport-kanban.png&quality=original&fit=cover";

/** What the unlock buys — kept true to what the paid product delivers. */
const BENEFIT_KEYS = [
  "taskBoard.backlogPaywall.benefitPrioritizedTasks",
  "taskBoard.backlogPaywall.benefitRecurringReport",
  "taskBoard.backlogPaywall.benefitAgentResolves",
] as const;

/** Display-only offer strings (mirrors the report's one-time unlock). */
const OFFER = { price: "R$ 99", anchor: "R$ 499" };

/** Pure presentational banner — no hooks, so it renders anywhere (incl. the
 *  dev preview). The container below wires the data + navigation. */
function BacklogPaywallCard({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 card-shadow sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-success/10">
          <Lightning01 size={16} className="text-success" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-foreground">
            {t("taskBoard.backlogPaywall.bannerTitle")}
          </span>
          <span className="text-sm text-muted-foreground">
            {t("taskBoard.backlogPaywall.bannerSubtitle")}
          </span>
        </div>
      </div>
      <Button
        size="sm"
        onClick={onOpen}
        className="w-full gap-2 sm:w-auto sm:shrink-0"
      >
        {t("taskBoard.backlogPaywall.unlockButton")}
        <ArrowRight size={16} />
      </Button>
    </div>
  );
}

/** The unlock modal. Presentational + the checkout call; `onDismiss` closes it
 *  ("Agora não"), leaving the board and banner usable. */
function BacklogPaywallModal({
  open,
  onOpenChange,
  cdClient,
  onExpired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cdClient: CommerceDiscoveryClient | null;
  /** Called when checkout can't start because the report app is the only place
   *  that can (no client) — falls back to opening it. */
  onExpired: () => void;
}) {
  const t = useT();
  const [starting, setStarting] = useState(false);

  const startCheckout = async () => {
    if (!cdClient) {
      onExpired();
      return;
    }
    setStarting(true);
    try {
      const result = await cdClient.callTool({
        name: "start_checkout",
        arguments: {},
      });
      const { url } = unwrapToolResult<{ url: string }>(result);
      if (new URL(url).protocol !== "https:")
        throw new Error("unsafe checkout url");
      // Stripe hosted checkout opens in a new tab; on return the diagnostic
      // re-polls and unlocks (locked → false), clearing the banner/modal.
      window.open(url, "_blank", "noopener,noreferrer");
      onOpenChange(false);
    } catch {
      // Couldn't start checkout here — fall back to the report app, which owns
      // the full paywall + checkout flow.
      onExpired();
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 p-3 sm:max-w-[500px]"
        closeButtonClassName="z-10 rounded-full bg-background/70 p-1 text-foreground backdrop-blur transition-colors hover:bg-background"
      >
        {/* Hero — a preview of the unlocked board (brand-lime edge baked in),
            inset with padding around it like the rest of the content. */}
        <div className="overflow-hidden rounded-xl bg-muted">
          <img
            src={KANBAN_PREVIEW_SRC}
            alt={t("taskBoard.backlogPaywall.previewAlt")}
            className="h-[208px] w-full object-cover object-left-top"
          />
        </div>

        {/* Body */}
        <div className="flex flex-col gap-7 px-3 pb-3 pt-7">
          <div className="flex flex-col gap-5">
            <DialogTitle className="text-xl font-semibold text-foreground">
              {t("taskBoard.backlogPaywall.modalTitle")}
            </DialogTitle>
            <ul className="flex flex-col gap-3.5">
              {BENEFIT_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-3 text-sm">
                  <CheckCircle
                    size={18}
                    className="mt-0.5 shrink-0 text-success"
                    aria-hidden
                  />
                  <span className="leading-snug text-foreground">{t(key)}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Price + actions — stacked full-width on mobile, price-left /
              buttons-right on sm+. */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold text-foreground">
                {OFFER.price}
              </span>
              <span className="text-sm text-muted-foreground line-through">
                {OFFER.anchor}
              </span>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={starting}
                className="order-2 w-full sm:order-none sm:w-auto"
              >
                {t("taskBoard.backlogPaywall.exploreButton")}
              </Button>
              <Button
                onClick={startCheckout}
                disabled={starting}
                className="order-1 w-full gap-2 sm:order-none sm:w-auto"
              >
                {starting ? (
                  <Loading01 size={16} className="animate-spin" />
                ) : null}
                {t("taskBoard.backlogPaywall.unlockButton")}
                {!starting && <ArrowRight size={16} />}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** sessionStorage key: once the modal is dismissed this session, it won't
 *  auto-open again (the banner still re-opens it on click). */
function seenKey(orgId: string) {
  return `board-paywall-seen:${orgId}`;
}

function BacklogPaywallBannerInner() {
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const { diagnostic, cdClient, connectionId } = useCommerceDiagnostic();

  // Auto-open once per session per org (read synchronously — no effect
  // needed). Stored alongside the org it was computed for so switching orgs
  // re-derives fresh from sessionStorage instead of inheriting a dismissal
  // from the previous org. The component only renders while locked, so this
  // only fires for unpaid orgs.
  const [modalState, setModalState] = useState(() => ({
    orgId: org.id,
    open: !sessionStorage.getItem(seenKey(org.id)),
  }));
  const modalOpen =
    modalState.orgId === org.id
      ? modalState.open
      : !sessionStorage.getItem(seenKey(org.id));

  // Only while the diagnostic exists and is still locked (unpaid).
  if (!diagnostic?.locked) return null;

  const setModalOpen = (open: boolean) =>
    setModalState({ orgId: org.id, open });

  const dismiss = (next: boolean) => {
    setModalOpen(next);
    if (!next) sessionStorage.setItem(seenKey(org.id), "1");
  };

  const openReport = () => {
    track("board_paywall_report_opened", { organization_id: org.id });
    navigate(commerceReportNavTarget(org, connectionId));
  };

  return (
    <>
      <BacklogPaywallCard
        onOpen={() => {
          track("board_paywall_banner_clicked", { organization_id: org.id });
          setModalOpen(true);
        }}
      />
      <BacklogPaywallModal
        open={modalOpen}
        onOpenChange={dismiss}
        cdClient={cdClient}
        onExpired={openReport}
      />
    </>
  );
}

export function BacklogPaywallBanner() {
  return (
    <ErrorBoundary fallback={null}>
      <BacklogPaywallBannerInner />
    </ErrorBoundary>
  );
}
