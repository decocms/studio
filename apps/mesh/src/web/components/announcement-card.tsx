import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { XClose } from "@untitledui/icons";
import type { ReactNode } from "react";

export interface AnnouncementCardProps {
  ariaLabel: string;
  dismissLabel: string;
  eyebrow?: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  children?: ReactNode;
  footerLeading?: ReactNode;
  actions?: ReactNode;
  onDismiss: () => void;
  tone?: "neutral" | "system";
}

export function AnnouncementCard({
  ariaLabel,
  dismissLabel,
  eyebrow,
  title,
  description,
  icon,
  children,
  footerLeading,
  actions,
  onDismiss,
  tone = "neutral",
}: AnnouncementCardProps) {
  const hasFooter = footerLeading || actions;

  return (
    <div
      role="dialog"
      aria-label={ariaLabel}
      data-slot="announcement-card"
      data-tone={tone}
      className="relative w-full overflow-hidden rounded-lg border border-border bg-background shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      {tone === "system" && <div className="h-0.5 bg-special" />}

      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={dismissLabel}
        className="absolute right-2 top-2 z-10 text-muted-foreground"
        onClick={onDismiss}
      >
        <XClose size={14} />
      </Button>

      <div
        className={cn(
          "p-4 pr-11",
          icon && "flex items-start gap-3",
          children && "pb-3",
        )}
      >
        {icon && (
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-special/10 text-special">
            {icon}
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div>
            {eyebrow && (
              <p className="text-xs text-muted-foreground">{eyebrow}</p>
            )}
            <h3 className="text-base font-semibold text-foreground">{title}</h3>
            {description && (
              <p className="mt-1 text-xs text-muted-foreground">
                {description}
              </p>
            )}
          </div>

          {children && <div className="mt-3">{children}</div>}
        </div>
      </div>

      {hasFooter && (
        <div
          className={cn(
            "flex items-center justify-between gap-3 px-4 py-2.5",
            tone === "system" ? "border-t border-border bg-muted/50" : "pt-0",
          )}
        >
          <div className="min-w-0 text-xs text-muted-foreground">
            {footerLeading}
          </div>
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        </div>
      )}
    </div>
  );
}
