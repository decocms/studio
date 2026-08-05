import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useStudioTools } from "@/lib/studio-tools";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";

/**
 * Fetch a Stripe-hosted URL (checkout or billing portal) and open it in a
 * new tab, like every other checkout in the app (`deco-credits-hero.tsx`).
 * Shared by the billing settings page, the task-board subscription paywall,
 * and the inline subscription-limit chat highlight.
 */
export function useOpenBillingUrl(
  toolName:
    | "ORGANIZATION_BILLING_CHECKOUT_START"
    | "ORGANIZATION_BILLING_PORTAL",
  errorKey: TranslationKey,
) {
  const studio = useStudioTools();
  const t = useT();
  return useMutation({
    mutationFn: async () => {
      const { url } = await studio.call(toolName, {});
      return url;
    },
    onSuccess: (url) => window.open(url, "_blank", "noopener,noreferrer"),
    onError: (err) => toast.error(t(errorKey, { message: err.message })),
  });
}
