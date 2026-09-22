/**
 * A finished-looking surface that is not ready to be used yet.
 *
 * The real view stays rendered behind a translucent veil rather than being
 * hidden or ripped out: someone landing here should see what is coming, and
 * the branch should stay one wrapper away from shipping it. Inert to the
 * pointer and to screen readers, so nothing behind the veil is reachable by
 * click, by Tab, or by a reader walking the tree.
 */

import type { ReactNode } from "react";
import { Clock } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { useT } from "@/i18n/use-t.ts";

export function SoonOverlay({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const t = useT();

  return (
    <div className="relative h-full min-h-0">
      <div
        aria-hidden="true"
        inert
        className="pointer-events-none h-full select-none overflow-hidden"
      >
        {children}
      </div>
      <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 p-6 backdrop-blur-sm">
        <div className="flex max-w-sm flex-col items-center gap-3 rounded-2xl border bg-card px-8 py-6 text-center shadow-lg">
          <Badge variant="secondary">
            <Clock />
            {t("common.soon")}
          </Badge>
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
    </div>
  );
}
