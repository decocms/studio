import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";

/**
 * Fetch a Stripe-hosted URL (checkout or billing portal) and open it in a
 * new tab, like every other checkout in the app (`deco-credits-hero.tsx`).
 * Shared by the billing settings page, the task-board subscription paywall,
 * the inline subscription-limit chat highlight, and the plan picker.
 *
 * The plan picker passes a `planId`, which is the whole reason an upgrade is a
 * checkout and not a click: `AI_PLAN_SET` takes no payment, so it can only
 * ever drop an org to free. A paid tier is granted by the Stripe webhook, on a
 * subscription whose price the operator mapped to it.
 */
export function useOpenBillingUrl(
  toolName:
    | "ORGANIZATION_BILLING_CHECKOUT_START"
    | "ORGANIZATION_BILLING_PORTAL",
  errorKey: TranslationKey,
) {
  const studio = useStudioTools();
  const t = useT();
  // `string | void` so the existing zero-argument callers (billing settings,
  // task-board paywall, chat highlight) keep working unchanged while the plan
  // picker passes the tier it is buying.
  return useMutation<string, Error, string | void>({
    mutationFn: async (planId) => {
      const { url } = await studio.call(
        toolName,
        toolName === "ORGANIZATION_BILLING_CHECKOUT_START" && planId
          ? { planId }
          : {},
      );
      return url;
    },
    onSuccess: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    onError: (err) => toast.error(t(errorKey, { message: err.message })),
  });
}
