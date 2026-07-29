import { IntegrationIcon } from "@/components/integration-icon";
import { useT } from "@/i18n/use-t.ts";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { CheckCircle, Loading01, Settings01 } from "@untitledui/icons";
import type { ReactNode } from "react";

/**
 * Presentational shell for a companion source row (Figma node 9473-8422): a
 * horizontal card — icon + title with a benefit line below, and an action on
 * the right. The required source carries a small "Obrigatório" pill straddling
 * its top edge. Shared by the live {@link CompanionCard} (which wires MCP config
 * dialogs into `action`) and the dev preview harness, so the two can't drift.
 */
export function CompanionCardView({
  icon,
  title,
  headline,
  required,
  attention,
  action,
}: {
  icon: string | null;
  title: string;
  headline?: string | null;
  /** Shows the "Obrigatório" pill on the top edge. */
  required?: boolean;
  /** Amber ring — draws the eye to a linked-but-unconfigured source. */
  attention?: boolean;
  action: ReactNode;
}) {
  const t = useT();
  return (
    <div
      className={cn(
        // Compact row at every width (button inline). The benefit line is hidden
        // on mobile so more cards fit; it returns from sm+ where there's room.
        "relative flex items-center justify-between gap-3 rounded-lg border bg-card p-3.5 sm:gap-4 sm:p-4",
        attention ? "border-warning/50 bg-warning/[0.04]" : "border-border",
      )}
    >
      {required && (
        <span className="absolute -top-3 right-4 rounded-full border border-input bg-background px-3 py-1 text-xs font-medium text-foreground">
          {t("commerceOnboarding.companionCard.required")}
        </span>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:items-start">
        <IntegrationIcon
          icon={icon}
          name={title}
          size="sm"
          fit="contain"
          className="size-[30px] shrink-0 p-1"
        />
        {/* Title + description stacked so the benefit line sits under the title. */}
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-foreground">{title}</span>
          {headline && (
            <p className="hidden text-sm leading-5 text-muted-foreground sm:block">
              {headline}
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/** The "Connect" action. `primary` renders a solid button (the required/hero
 *  source); everything else is a quieter outline. */
export function ConnectAction({
  connecting,
  disabled,
  title,
  primary,
  onConnect,
}: {
  connecting: boolean;
  disabled: boolean;
  title: string;
  primary?: boolean;
  onConnect: () => void;
}) {
  const t = useT();
  return (
    <Button
      type="button"
      variant={primary ? "default" : "outline"}
      size="sm"
      disabled={disabled || connecting}
      onClick={onConnect}
      aria-label={t("commerceOnboarding.companionCard.connectAriaLabel", {
        title,
      })}
    >
      {connecting ? (
        <Loading01 size={16} className="animate-spin" />
      ) : (
        t("commerceOnboarding.companionCard.connect")
      )}
    </Button>
  );
}

/** Linked but not usable yet → an amber "Finish setup" button that must be
 *  clicked before the source counts as connected. */
export function ConfigureAction({
  disabled,
  title,
  onConfigure,
}: {
  disabled: boolean;
  title: string;
  onConfigure: () => void;
}) {
  const t = useT();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="border-warning/60 text-warning hover:bg-warning/10 hover:text-warning"
      disabled={disabled}
      onClick={onConfigure}
      aria-label={t("commerceOnboarding.companionCard.configureAriaLabel", {
        title,
      })}
    >
      <Settings01 size={16} />
      {t("commerceOnboarding.companionCard.finishSetup")}
    </Button>
  );
}

/** The "Connected ✓" label + trailing controls (gear, unlink) passed as
 *  `controls`. `detail` (repo full name, GA4 property, etc.) replaces the
 *  generic "Conectado" text once known, so the label itself identifies what's
 *  linked instead of repeating it next to the gear. Kept presentational so the
 *  preview can render mock controls. */
export function ConnectedAction({
  detail,
  controls,
}: {
  detail?: string | null;
  controls?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-1">
      <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <CheckCircle size={16} className="text-success" />{" "}
        {detail ? (
          <span className="max-w-40 truncate text-foreground">{detail}</span>
        ) : (
          t("commerceOnboarding.companionCard.connected")
        )}
      </span>
      {controls}
    </div>
  );
}

/** The gear config trigger for a connected source. Shared by both the
 *  shared-SA and OAuth lanes in {@link CompanionCard} so they can't drift, and
 *  by the dev preview so it renders pixel-identical to production. */
export function ConnectedConfigButton({
  ariaLabel,
  onClick,
}: {
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0"
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <Settings01 size={16} />
    </Button>
  );
}
