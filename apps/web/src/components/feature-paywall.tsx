/**
 * The paywall — what this org's plan does not include, shown where the user
 * reached for it. A popup rather than a hidden button: the org has to be able
 * to see what it would get, and the upsell is the point.
 *
 * Product gating only. The gateway is what actually refuses the spend; a
 * dismissed paywall is not a granted feature.
 */

import { Lock01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import type { Feature } from "@/hooks/use-entitlements";

export function FeaturePaywall({
  feature,
  onDismiss,
}: {
  feature: Feature;
  /** Called on both buttons and on an outside click / Esc. */
  onDismiss?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  // The same names the plan picker lists, so the upsell and the plan card
  // call the feature the same thing.
  const name = t(`settings.planUsage.feature.${feature}`);

  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss?.()}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
            <Lock01 size={18} className="text-muted-foreground" />
          </div>
          <DialogTitle>
            {t("settings.paywall.title", { feature: name })}
          </DialogTitle>
          <DialogDescription>
            {t("settings.paywall.description", { feature: name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onDismiss}>
            {t("settings.paywall.dismiss")}
          </Button>
          <Button
            onClick={() => {
              navigate({
                to: "/$org/settings/ai-providers",
                params: { org: org.slug },
              });
              onDismiss?.();
            }}
          >
            {t("settings.paywall.seePlans")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
