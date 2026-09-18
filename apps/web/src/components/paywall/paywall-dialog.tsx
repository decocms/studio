import type { ReactNode } from "react";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";

/**
 * The shell every paywall dialog wears.
 *
 * A centred column rather than the usual left-aligned stack: this dialog is one
 * message with one action, and centring is what a short message can carry. The
 * tier's mark is the artwork — printed large, because a small glyph in a
 * bordered box reads as an icon slot waiting to be filled.
 *
 * The light falls from the TOP EDGE rather than haloing the mark: a symmetric
 * blob behind an icon is the stock treatment, and it reads as one. Entering
 * from above gives the composition a direction, and the mark sits IN the light
 * instead of emitting it.
 *
 * It paints in `currentColor`, so the caller tints it by passing the SAME
 * `text-*` class the tier's plant uses — one colour per rung, defined once.
 */
export function PaywallDialog({
  open = true,
  onDismiss,
  accentClassName,
  icon,
  title,
  description,
  highlights,
  price,
  action,
  dismissAction,
}: {
  open?: boolean;
  onDismiss?: () => void;
  /** A `text-*` class — the tier's colour. Neutral when the dialog has no tier. */
  accentClassName?: string;
  icon: ReactNode;
  title: ReactNode;
  /** One line under the title. Omitted when `highlights` says it better. */
  description?: ReactNode;
  /** A short scannable list — centred as a block, aligned left inside it. */
  highlights?: ReactNode;
  price?: ReactNode;
  action: ReactNode;
  dismissAction: ReactNode;
}) {
  const accent = accentClassName ?? "text-muted-foreground";
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss?.()}>
      <DialogContent
        className="gap-0 overflow-hidden p-0 sm:max-w-[480px]"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div aria-hidden="true" className={cn("pointer-events-none", accent)}>
          <div
            className="absolute inset-x-0 top-0 h-60 opacity-60 dark:opacity-30"
            style={{
              background:
                "radial-gradient(ellipse 70% 100% at 50% 0%, currentColor 0%, transparent 72%)",
            }}
          />
          {/* The edge the light lands on first. */}
          <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-current to-transparent opacity-80 dark:opacity-60" />
        </div>

        <div className="flex flex-col items-center px-8 pt-10 pb-8 text-center">
          <div className="mb-7">{icon}</div>

          <DialogHeader className="gap-2">
            <DialogTitle className="text-2xl font-semibold leading-tight tracking-tight text-balance">
              {title}
            </DialogTitle>
            {description && (
              <DialogDescription className="mx-auto max-w-[32ch] text-sm leading-relaxed text-pretty">
                {description}
              </DialogDescription>
            )}
          </DialogHeader>

          {highlights && <div className="mt-6 w-fit">{highlights}</div>}
          {price && <div className="mt-7">{price}</div>}

          <div className="mt-8 flex w-full flex-col items-center gap-2">
            {action}
            {dismissAction}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
