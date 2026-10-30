import type { ComponentProps, ReactNode } from "react";
import { DotsHorizontal } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { useT } from "@/i18n/use-t.ts";

/**
 * One account in "Your own accounts", on one line: logo, name, status, a
 * compact summary, and its actions. Linking opens a token field underneath.
 */
export function AccountRow({
  icon,
  title,
  status,
  meta,
  summary,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  status?: "linked" | "expired" | null;
  meta?: ReactNode;
  summary?: ReactNode;
  action: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div>
      <div className="flex min-h-16 items-center gap-3 px-4 py-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          {icon}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{title}</span>
            {status === "linked" && (
              <Badge variant="success" size="sm">
                {t("settings.ownAccounts.linked")}
              </Badge>
            )}
            {status === "expired" && (
              <Badge variant="warning" size="sm">
                {t("settings.ownAccounts.expired")}
              </Badge>
            )}
          </div>
          {meta && <span className="truncate text-meta">{meta}</span>}
        </div>
        {summary}
        <div className="flex shrink-0 items-center gap-1">{action}</div>
      </div>
      {children}
    </div>
  );
}

export function AccountLogo({
  src,
  alt,
}: {
  src: string | undefined;
  alt: string;
}) {
  if (!src) return <span className="text-sm font-medium">{alt.charAt(0)}</span>;
  return <img src={src} alt={alt} className="size-5 object-contain" />;
}

/** The row's overflow menu; pass `DropdownMenuItem`s as children. */
export function AccountMenu({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("settings.ownAccounts.more")}
          className="text-muted-foreground hover:text-foreground"
        >
          <DotsHorizontal size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The paste-a-token step, shown only while the member is linking. */
export function LinkTokenForm({
  hint,
  submitLabel,
  pending,
  value,
  onChange,
  onSubmit,
  inputProps,
}: {
  hint: ReactNode;
  submitLabel: string;
  pending: boolean;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  inputProps?: ComponentProps<typeof Input>;
}) {
  return (
    <form
      className="flex flex-col gap-2 px-4 pb-4 pl-15"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <p className="text-meta">{hint}</p>
      <div className="flex items-center gap-2">
        <Input
          type="password"
          autoFocus
          {...inputProps}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button type="submit" disabled={value.trim().length === 0 || pending}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
