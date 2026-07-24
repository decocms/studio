/**
 * Subscribe CTA — the owner/admin action on the paid-seat paywall.
 *
 * Standalone on purpose so it's the single seam for the billing follow-up:
 * wire `onClick` to checkout (`ORGANIZATION_BILLING_CHECKOUT_START`) when the
 * org has no subscription, or to the seat-add flow otherwise. For now it just
 * signals "coming soon". The dialog passes the shared pill styling so the
 * button matches the surface.
 */
import { toast } from "sonner";
import { Button } from "@deco/ui/components/button.tsx";
import { track } from "@/web/lib/posthog-client";
import { useT } from "@/web/i18n/use-t.ts";

export function SubscribeCta({
  organizationId,
  className,
}: {
  organizationId?: string;
  className?: string;
}) {
  const t = useT();

  return (
    <Button
      size="lg"
      className={className}
      onClick={() => {
        track("paid_seat_subscribe_clicked", {
          organization_id: organizationId,
        });
        // Phase 3: replace this with the Stripe checkout redirect.
        toast.info(t("paywall.owner.comingSoon"));
      }}
    >
      {t("paywall.owner.subscribe")}
    </Button>
  );
}
