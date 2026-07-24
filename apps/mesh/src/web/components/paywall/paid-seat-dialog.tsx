/**
 * Paid Seat Paywall — shown when a free seat attempts a paid action and the
 * backend responds with a `[PAID_SEAT_REQUIRED]` error.
 *
 * Free seats can view everything but cannot mutate or spend AI. This dialog
 * replaces the generic error toast with a role-aware upgrade surface:
 *  - owner/admin see the Subscribe CTA (checkout wiring is a follow-up)
 *  - everyone else is pointed at their org administrators
 *
 * A deliberately dark, branded "premium" surface: the content is pinned to
 * `.dark` (so design-system tokens resolve against it regardless of the app
 * theme) with a deco-green spotlight as the only brand art.
 *
 * Rendered from two independent triggers, never both at once for one error:
 *  - non-chat mutations, via the global MutationCache → paid-seat-store →
 *    PaidSeatPaywallHost (root mount)
 *  - chat streaming errors, inline from the chat highlight stack
 */
import { Check, Stars01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useCapabilities } from "@/web/hooks/use-capability.ts";
import { useT } from "@/web/i18n/use-t.ts";
import type { TranslationKey } from "@/web/i18n/en/index.ts";
import { SubscribeCta } from "./subscribe-cta.tsx";

const CAPABILITY_KEYS = [
  "paywall.capability.diagnose",
  "paywall.capability.plan",
  "paywall.capability.automate",
  "paywall.capability.preview",
] as const satisfies readonly TranslationKey[];

// Shared pill sizing for the CTA buttons so Subscribe and the member
// "Got it" match the surface.
const PILL_CLASS = "h-12 w-full rounded-full";

export function PaidSeatDialog({ onDismiss }: { onDismiss: () => void }) {
  const t = useT();
  const { org } = useProjectContext();
  const { isPrivileged, loading } = useCapabilities();

  return (
    <Dialog open onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent
        className="dark max-h-[90dvh] max-w-[440px] gap-0 overflow-y-auto rounded-2xl bg-background p-0 text-foreground"
        closeButtonClassName="top-5 right-5 z-10 size-8 rounded-full bg-muted p-1.5 text-muted-foreground opacity-100 hover:bg-accent hover:text-foreground"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {/* Hero — layered deco-green spotlight behind a gradient badge */}
        <div className="relative flex flex-col items-center px-6 pt-12 pb-5 sm:px-8 sm:pt-16 sm:pb-6">
          <div className="relative flex items-center justify-center">
            {/* Concentric ring layers + soft core, in the deco brand green
                (#d0ec1a), masked to fade downward into the surface. Scaled
                down on small screens so it doesn't dominate the viewport. */}
            <div
              aria-hidden
              className="pointer-events-none absolute left-1/2 top-1/2 size-80 -translate-x-1/2 -translate-y-1/2 scale-[0.8] sm:scale-100"
              style={{
                maskImage:
                  "linear-gradient(to bottom, black 42%, transparent 86%)",
                WebkitMaskImage:
                  "linear-gradient(to bottom, black 42%, transparent 86%)",
              }}
            >
              <span
                className="absolute inset-0 m-auto size-80 rounded-full"
                style={{
                  background:
                    "radial-gradient(circle, rgba(208,236,26,0.16) 0%, transparent 68%)",
                }}
              />
              <span
                className="absolute inset-0 m-auto size-64 rounded-full"
                style={{
                  backgroundColor: "rgba(208,236,26,0.03)",
                  border: "1px solid rgba(208,236,26,0.10)",
                }}
              />
              <span
                className="absolute inset-0 m-auto size-48 rounded-full"
                style={{
                  backgroundColor: "rgba(208,236,26,0.05)",
                  border: "1px solid rgba(208,236,26,0.16)",
                }}
              />
              <span
                className="absolute inset-0 m-auto size-32 rounded-full"
                style={{
                  backgroundColor: "rgba(208,236,26,0.07)",
                  border: "1px solid rgba(208,236,26,0.22)",
                }}
              />
            </div>

            {/* Gradient badge with sparkle */}
            <div
              className="relative z-10 flex size-14 items-center justify-center rounded-full sm:size-16"
              style={{
                backgroundImage:
                  "linear-gradient(150deg, #d0ec1a 0%, #07401a 100%)",
                boxShadow: "0 8px 40px rgba(208,236,26,0.4)",
              }}
            >
              <Stars01 className="size-6 text-white sm:size-7" />
            </div>
          </div>

          <DialogHeader className="relative mt-6 items-center gap-2 text-center sm:mt-8 sm:text-center">
            <DialogTitle className="text-xl font-bold leading-tight tracking-tight sm:text-2xl">
              {t("paywall.title")}
            </DialogTitle>
            <DialogDescription className="max-w-[320px] text-sm leading-relaxed">
              {t("paywall.description", { org: org.name })}
            </DialogDescription>
          </DialogHeader>
        </div>

        {/* Capability card */}
        <div className="px-6 sm:px-8">
          <ul className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-4 sm:gap-3.5 sm:p-5">
            {CAPABILITY_KEYS.map((key) => (
              <li key={key} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Check className="size-3 text-muted-foreground" />
                </span>
                <span className="text-sm text-foreground">{t(key)}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Action */}
        <div className="mt-6 border-t border-border px-6 py-5 sm:px-8 sm:py-6">
          {loading ? (
            <div className="h-12 w-full animate-pulse rounded-full bg-muted" />
          ) : isPrivileged ? (
            <div className="flex flex-col items-center gap-3">
              <SubscribeCta
                organizationId={org.id}
                className={cn(
                  PILL_CLASS,
                  "bg-foreground text-background hover:bg-foreground/90",
                )}
              />
              <p className="text-xs text-muted-foreground">
                {t("paywall.owner.reassure")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm leading-relaxed text-muted-foreground">
                {t("paywall.member.hint")}
              </p>
              <Button
                variant="outline"
                size="lg"
                className={PILL_CLASS}
                onClick={onDismiss}
              >
                {t("paywall.member.done")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
