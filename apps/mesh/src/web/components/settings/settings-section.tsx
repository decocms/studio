import { Card } from "@deco/ui/components/card.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowUpRight } from "@untitledui/icons";
import { Children, isValidElement, type ReactNode } from "react";

interface SettingsSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  docsHref?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function SettingsSection({
  title,
  description,
  docsHref,
  actions,
  className,
  children,
}: SettingsSectionProps) {
  return (
    <section className={cn("flex flex-col gap-3", className)}>
      {(title || description || docsHref || actions) && (
        <div className="flex items-center justify-between gap-3 px-4">
          <div className="flex flex-col gap-1 min-w-0">
            {title && (
              <h2 className="text-[15px] font-medium leading-tight">{title}</h2>
            )}
            {(description || docsHref) && (
              <p className="text-sm text-muted-foreground leading-snug">
                {description}
                {docsHref && (
                  <a
                    href={docsHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-0.5 ml-1 text-foreground hover:underline"
                  >
                    Docs <ArrowUpRight size={12} />
                  </a>
                )}
              </p>
            )}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
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
  return (
    <div
      className={cn(
        children
          ? "flex items-start gap-3 px-4 py-4"
          : "flex items-center gap-3 px-4 py-4",
        onClick && "hover:bg-muted/50 cursor-pointer",
        className,
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
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
      {action && (
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          {action}
        </div>
      )}
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

interface SettingsPageProps {
  className?: string;
  children: ReactNode;
}

export function SettingsPage({ className, children }: SettingsPageProps) {
  return (
    <div className={cn("flex flex-col gap-10", className)}>{children}</div>
  );
}
