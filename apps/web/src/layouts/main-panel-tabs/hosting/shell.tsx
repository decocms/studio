/**
 * The Hosting tab's shared presentation: the section frame it borrows from the
 * settings kit, the card list its key-value sections render into, the animated
 * details row a table can unfold, and the one delete confirmation every
 * section asks the same way.
 */

import type { ReactNode } from "react";
import { ChevronRight, Copy01 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
} from "@decocms/ui/components/collapsible.tsx";
import { IconButton } from "@decocms/ui/components/icon-button.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  TableCell,
  TableHead,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SettingsSection } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import type { EnvScope } from "./api";

export function HostingSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SettingsSection title={title} actions={actions}>
      {children}
    </SettingsSection>
  );
}

/** A card of hairline-separated rows, for lists that are not tables. */
export function ListCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden p-0 divide-y divide-border",
        className,
      )}
    >
      {children}
    </Card>
  );
}

export function ListRow({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex min-h-12 items-center gap-3 px-4 py-2", className)}
    >
      {children}
    </div>
  );
}

/** A quiet line inside a card: an error, or a list with nothing in it yet. */
export function ListMessage({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-muted-foreground">{children}</p>;
}

export function RowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ListCard>
      {Array.from({ length: rows }, (_, i) => (
        <ListRow key={i}>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="size-7 rounded-lg" />
        </ListRow>
      ))}
    </ListCard>
  );
}

/** A muted column header, for tables whose rows carry the emphasis. */
export function Th({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <TableHead
      className={cn("text-xs font-medium text-muted-foreground", className)}
    >
      {children}
    </TableHead>
  );
}

/** The chevron that unfolds a row's details; rotates to point down when open. */
export function ExpandChevron({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <IconButton
      label={
        open
          ? t("mainPanelTabs.hostingTab.hideDetails")
          : t("mainPanelTabs.hostingTab.showDetails")
      }
      size="icon-sm"
      className="-ml-1.5 text-muted-foreground"
      aria-expanded={open}
      onClick={onClick}
    >
      <ChevronRight
        className={cn(
          "transition-transform duration-200 motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
    </IconButton>
  );
}

/**
 * A table row's unfolding details. The row is always in the DOM so the table
 * keeps its column grid; the content inside animates open and closed.
 */
export function TableDetailsRow({
  open,
  colSpan,
  children,
}: {
  open: boolean;
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <TableRow className="border-0 hover:bg-transparent">
      <TableCell colSpan={colSpan} className="p-0 whitespace-normal">
        <Collapsible open={open}>
          <CollapsibleContent>
            <div className="border-b border-border bg-muted/30 px-4 py-3">
              {children}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </TableCell>
    </TableRow>
  );
}

/** A card row's unfolding details, same motion as the table variant. */
export function RowDetails({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible open={open}>
      <CollapsibleContent>
        <div className="border-t border-border bg-muted/30 px-4 py-3">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ScopeBadge({ scope }: { scope: EnvScope }) {
  const t = useT();
  return (
    <Badge variant={scope === "build" ? "outline" : "secondary"}>
      {scope === "build"
        ? t("mainPanelTabs.hostingTab.secretScopeBuild")
        : t("mainPanelTabs.hostingTab.secretScopeRuntime")}
    </Badge>
  );
}

export function CopyValueButton({ value }: { value: string }) {
  const t = useT();
  return (
    <IconButton
      label={t("mainPanelTabs.hostingTab.dnsCopy")}
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        toast.success(t("mainPanelTabs.hostingTab.dnsCopied"));
      }}
    >
      <Copy01 className="size-3.5" />
    </IconButton>
  );
}

/** The delete confirmation every section asks: `open` while a target is set. */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t("mainPanelTabs.hostingTab.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
            disabled={pending}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
