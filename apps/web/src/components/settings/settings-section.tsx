import { Card } from "@decocms/ui/components/card.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ArrowUpRight } from "@untitledui/icons";
import { Children, isValidElement, type ReactNode } from "react";
import { Main } from "@/components/main";
import { useT } from "@/i18n/use-t";

interface SettingsSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  docsHref?: string;
  actions?: ReactNode;
  className?: string;
  /** Extra classes for the header row (title + description + actions). */
  headerClassName?: string;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  docsHref,
  actions,
  className,
  headerClassName,
  children,
}: SettingsSectionProps) {
  const t = useT();

  return (
    <Main.Section className={className}>
      {(title || description || docsHref || actions) && (
        <Main.Section.Header className={cn("px-4", headerClassName)}>
          <div className="flex min-w-0 flex-col gap-1">
            {title && <Main.Section.Title>{title}</Main.Section.Title>}
            {(description || docsHref) && (
              <Main.Section.Description className="leading-snug">
                {description}
                {docsHref && (
                  <a
                    href={docsHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 ml-1 text-foreground hover:underline"
                  >
                    {t("settings.common.documentation")}{" "}
                    <ArrowUpRight size={12} />
                  </a>
                )}
              </Main.Section.Description>
            )}
          </div>
          {actions && <Main.Section.Actions>{actions}</Main.Section.Actions>}
        </Main.Section.Header>
      )}
      {children}
    </Main.Section>
  );
}

interface SettingsCardProps {
  className?: string;
  children: ReactNode;
}

export function SettingsCard({ className, children }: SettingsCardProps) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <Card className={cn("p-0 gap-0 overflow-hidden", className)}>
      {items.map((child, idx) => (
        <div key={idx}>
          {idx > 0 && <div className="h-px bg-border mx-5" />}
          {child}
        </div>
      ))}
    </Card>
  );
}

interface SettingsCardItemProps {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}

export function SettingsCardItem({
  icon,
  title,
  description,
  action,
  onClick,
  className,
  children,
}: SettingsCardItemProps) {
  const content = (
    <>
      {icon && (
        <div className="size-8 shrink-0 rounded-lg bg-muted/60 flex items-center justify-center text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{title}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        )}
        {children}
      </div>
    </>
  );

  return (
    <div
      className={cn(
        children
          ? "flex items-start gap-3 px-4 py-4"
          : "flex items-center gap-3 px-4 py-4",
        onClick && "hover:bg-muted/50",
        className,
      )}
    >
      {onClick ? (
        <button
          type="button"
          className={cn(
            "flex min-w-0 flex-1 gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            children ? "items-start" : "items-center",
          )}
          onClick={onClick}
        >
          {content}
        </button>
      ) : (
        content
      )}
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

interface SettingsCardActionsProps {
  children: ReactNode;
  className?: string;
}

export function SettingsCardActions({
  children,
  className,
}: SettingsCardActionsProps) {
  return (
    <div
      className={cn("flex items-center justify-end gap-2 px-4 py-4", className)}
    >
      {children}
    </div>
  );
}
