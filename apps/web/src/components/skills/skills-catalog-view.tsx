/**
 * The skills table, read like Context's files: a package is a folder you open,
 * a skill is a file you preview. Packages lead, the way folders do.
 */

import type { ReactNode } from "react";
import {
  ArrowUp,
  DotsVertical,
  Package,
  Trash01,
  Zap,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { OrgFsSkillCatalogEntry } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import {
  type BundleSummary,
  type CategoryKey,
  categoryLabel,
  categoryOf,
  skillDisplayName,
} from "./skill-catalog";

/** "1 skill" / "20 skills". */
export function useSkillCount() {
  const t = useT();
  return (count: number) =>
    count === 1
      ? t("skills.picker.bundleCountOne")
      : t("skills.picker.bundleCount", { count });
}

/** One line of the table: a package or a single skill, keyed by the reference
 *  a project stores for it. `null` means the catalog no longer has it. */
export type SkillsRow =
  | {
      kind: "package";
      ref: string;
      title: string;
      category: CategoryKey;
      bundle: BundleSummary | null;
    }
  | {
      kind: "skill";
      ref: string;
      title: string;
      category: CategoryKey;
      entry: OrgFsSkillCatalogEntry | null;
    };

export function packageRow(ref: string, bundle: BundleSummary): SkillsRow {
  return {
    kind: "package",
    ref,
    title: bundle.title,
    category: bundle.category,
    bundle,
  };
}

export function skillRow(entry: OrgFsSkillCatalogEntry): SkillsRow {
  return {
    kind: "skill",
    ref: entry.id,
    title: skillDisplayName(entry),
    category: categoryOf(entry),
    entry,
  };
}

/** Packages first, then by name — folders before files. */
function byKindThenName(a: SkillsRow, b: SkillsRow): number {
  if (a.kind !== b.kind) return a.kind === "package" ? -1 : 1;
  return a.title.localeCompare(b.title);
}

const COL = {
  second: "hidden w-48 @md/skills:table-cell",
  count: "hidden w-24 @lg/skills:table-cell",
  end: "w-32 pr-3 text-right",
} as const;

export function SkillsTable({
  rows,
  second,
  sourceOf,
  selected,
  onOpen,
  end,
}: {
  rows: SkillsRow[];
  /** What the second column says: the category, or where a skill syncs from. */
  second: "category" | "source";
  sourceOf: (entry: OrgFsSkillCatalogEntry) => string;
  /** The ref whose preview is open beside the table. */
  selected?: string;
  onOpen: (row: SkillsRow) => void;
  end?: (row: SkillsRow) => ReactNode;
}) {
  const t = useT();
  const skillCount = useSkillCount();
  const sorted = rows.toSorted(byKindThenName);
  return (
    <div className="@container/skills min-w-0">
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">
              <span className="flex items-center gap-1 font-normal text-foreground">
                {t("library.library.name")}
                <ArrowUp size={11} className="shrink-0" />
              </span>
            </TableHead>
            <TableHead className={cn(COL.second, "font-normal")}>
              {second === "category"
                ? t("skills.table.category")
                : t("skills.table.source")}
            </TableHead>
            <TableHead className={cn(COL.count, "font-normal")}>
              {t("skills.table.skills")}
            </TableHead>
            <TableHead className={COL.end} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => {
            const missing =
              row.kind === "package" ? row.bundle === null : row.entry === null;
            const clickable = !missing;
            return (
              <TableRow
                key={row.ref}
                data-state={selected === row.ref ? "selected" : undefined}
                className={cn(
                  "group/row",
                  clickable && "cursor-pointer hover:bg-accent",
                )}
                onClick={clickable ? () => onOpen(row) : undefined}
              >
                <TableCell className="min-w-0 max-w-0 pl-4">
                  <span className="flex min-w-0 items-center gap-2.5">
                    {row.kind === "package" ? (
                      <Package size={16} className="shrink-0 text-foreground" />
                    ) : (
                      <Zap
                        size={16}
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                    <span
                      className={cn(
                        "truncate text-foreground",
                        row.kind === "package" && "font-medium",
                        missing && "text-muted-foreground line-through",
                      )}
                      title={missing ? t("skills.picker.unknown") : row.title}
                    >
                      {row.title}
                    </span>
                  </span>
                </TableCell>
                <TableCell
                  className={cn(COL.second, "truncate text-muted-foreground")}
                >
                  {second === "category"
                    ? categoryLabel(t, row.category)
                    : row.kind === "skill" && row.entry
                      ? sourceOf(row.entry)
                      : ""}
                </TableCell>
                <TableCell
                  className={cn(
                    COL.count,
                    "tabular-nums text-muted-foreground",
                  )}
                >
                  {row.kind === "package" && row.bundle
                    ? skillCount(row.bundle.members.length)
                    : ""}
                </TableCell>
                <TableCell className={COL.end}>{end?.(row)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** A row action that waits for the hover, so the table reads as a list. */
export function RowAction({
  label,
  onClick,
  always = false,
}: {
  label: string;
  onClick: () => void;
  always?: boolean;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn(
        "h-7",
        !always &&
          "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100",
      )}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {label}
    </Button>
  );
}

/** The org's own skills can go; synced ones belong to their repo. */
export function DeleteSkillMenu({ onDelete }: { onDelete: () => void }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <DotsVertical size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          variant="destructive"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash01 size={16} />
          {t("settings.skills.deleteButton")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
