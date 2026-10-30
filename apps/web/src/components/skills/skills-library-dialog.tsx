/**
 * The skills library: everything the org already has, ready to add to a
 * project. Categories on the left, packages as cards, and a package opens
 * into its own page — an app store's shape. The page underneath only lists
 * what the project uses.
 */

import { useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Package,
  Plus,
  Zap,
} from "@untitledui/icons";
import { SKILL_CATEGORY_IDS, bundleRef } from "@decocms/shared/skills";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { SearchInput } from "@decocms/ui/components/search-input.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { OrgFsSkillCatalogEntry } from "@/hooks/use-org-fs";
import { useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import {
  type BundleSummary,
  type CategoryKey,
  categoryLabel,
  categoryOf,
  skillDisplayName,
} from "./skill-catalog";
import { useSkillCount } from "./skills-catalog-view";

/** Single skills shown under "All" before "Show all". */
const SINGLES = 6;

function Tile({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center bg-muted text-foreground",
        size === "lg" ? "size-13 rounded-2xl" : "size-10 rounded-xl",
      )}
    >
      <Package size={size === "lg" ? 24 : 18} />
    </span>
  );
}

/** Add, or the lime check once the project has it. */
function AddToggle({
  label,
  added,
  onAdd,
}: {
  label: string;
  added: boolean;
  onAdd: () => void;
}) {
  const t = useT();
  if (added) {
    return (
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-brand text-foreground"
        title={t("skills.library.added")}
      >
        <Check size={14} />
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="icon"
      className="size-7 shrink-0"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onAdd();
      }}
    >
      <Plus size={14} />
    </Button>
  );
}

/** Over a project's skills: one line that opens the library. */
export function SkillsLibraryBanner({
  packages,
  skills,
  onBrowse,
}: {
  packages: number;
  skills: number;
  onBrowse: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onBrowse}
      className="surface surface-interactive flex w-full cursor-pointer items-center gap-4 px-4 py-3.5 text-left"
    >
      <span className="flex shrink-0 -space-x-2.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="flex size-9 items-center justify-center rounded-xl bg-muted text-foreground ring-2 ring-card"
          >
            <Package size={16} />
          </span>
        ))}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground">
          {t("skills.library.title")}
        </span>
        <span className="text-meta truncate">
          {t("skills.library.summary", { packages, skills })}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-foreground">
        {t("skills.library.browse")}
        <ChevronRight size={16} className="text-muted-foreground" />
      </span>
    </button>
  );
}

function PackageCard({
  bundle,
  added,
  onOpen,
  onAdd,
}: {
  bundle: BundleSummary;
  added: boolean;
  onOpen: () => void;
  onAdd: () => void;
}) {
  const t = useT();
  const skillCount = useSkillCount();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      className="surface surface-interactive flex cursor-pointer items-center gap-3 p-3"
    >
      <Tile />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">
          {bundle.title}
        </span>
        <span className="text-meta truncate">
          {bundle.description} · {skillCount(bundle.members.length)}
        </span>
      </span>
      <AddToggle
        label={t("skills.library.addPackage", { name: bundle.title })}
        added={added}
        onAdd={onAdd}
      />
    </div>
  );
}

function SkillLine({
  entry,
  added,
  onAdd,
}: {
  entry: OrgFsSkillCatalogEntry;
  /** Absent inside a package: its skills come with it, not one by one. */
  added?: boolean;
  onAdd?: () => void;
}) {
  const t = useT();
  const name = skillDisplayName(entry);
  return (
    <div className="flex items-center gap-3 py-3 pr-3 pl-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Zap size={14} />
      </span>
      <span className="mr-2 flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {name}
        </span>
        <span className="text-meta truncate">
          {entry.description || t("settings.skills.noDescription")}
        </span>
      </span>
      {onAdd && (
        <AddToggle
          label={t("skills.library.addPackage", { name })}
          added={added ?? false}
          onAdd={onAdd}
        />
      )}
    </div>
  );
}

function Label({ children }: { children: string }) {
  return <h3 className="text-meta pb-2.5">{children}</h3>;
}

export function SkillsLibraryDialog({
  open,
  onOpenChange,
  bundles,
  entries,
  taken,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bundles: BundleSummary[];
  entries: OrgFsSkillCatalogEntry[];
  /** References the project already has. */
  taken: string[];
  onAdd: (ref: string) => void;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const skillCount = useSkillCount();
  const [category, setCategory] = useState<CategoryKey | "all">("all");
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [allSingles, setAllSingles] = useState(false);
  const has = (ref: string) => taken.includes(ref);
  const bundle = bundles.find((b) => b.id === bundleId) ?? null;

  const bundled = new Set(bundles.flatMap((b) => b.members.map((m) => m.id)));
  const singlesAll = entries.filter(
    (e) => !e.disableModelInvocation && !bundled.has(e.id),
  );
  const query = search.trim().toLowerCase();
  const matchesSkill = (e: OrgFsSkillCatalogEntry) =>
    skillDisplayName(e).toLowerCase().includes(query) ||
    e.name.toLowerCase().includes(query) ||
    (e.description ?? "").toLowerCase().includes(query);
  // A search looks everywhere; otherwise the rail narrows to one category.
  const inScope = (key: CategoryKey) =>
    query !== "" || category === "all" || key === category;
  const packages = bundles.filter(
    (b) =>
      inScope(b.category) &&
      (!query ||
        b.title.toLowerCase().includes(query) ||
        b.description.toLowerCase().includes(query) ||
        b.members.some(matchesSkill)),
  );
  const singles = singlesAll.filter(
    (e) => inScope(categoryOf(e)) && (!query || matchesSkill(e)),
  );
  const shownSingles =
    category === "all" && !query && !allSingles
      ? singles.slice(0, SINGLES)
      : singles;

  const rail: { key: CategoryKey | "all"; label: string; count: number }[] = [
    {
      key: "all",
      label: t("library.context.all"),
      count: bundles.length + singlesAll.length,
    },
    ...[...SKILL_CATEGORY_IDS, "other" as const]
      .map((key) => ({
        key,
        label: categoryLabel(t, key),
        count:
          bundles.filter((b) => b.category === key).length +
          singlesAll.filter((e) => categoryOf(e) === key).length,
      }))
      .filter((c) => c.count > 0),
  ];
  const pick = (key: CategoryKey | "all") => {
    setCategory(key);
    setBundleId(null);
    setSearch("");
    setAllSingles(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) pick("all");
      }}
    >
      <DialogContent className="grid h-[82vh] grid-cols-1 gap-0 overflow-hidden p-0 sm:max-w-5xl md:grid-cols-[220px_1fr]">
        <nav className="hidden min-h-0 flex-col gap-0.5 overflow-y-auto border-r border-border bg-muted/40 px-3 py-5 md:flex">
          <DialogTitle className="px-2 text-base">
            {t("skills.library.title")}
          </DialogTitle>
          <DialogDescription className="text-meta px-2 pb-4">
            {t("skills.library.from", { org: org.name })}
          </DialogDescription>
          {rail.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => pick(c.key)}
              className={cn(
                "flex h-8 items-center justify-between gap-2 rounded-lg px-2 text-left text-sm transition-colors",
                category === c.key && !query
                  ? "bg-background font-medium text-foreground shadow-xs"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <span className="truncate">{c.label}</span>
              <span className="text-meta">{c.count}</span>
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 min-w-0 flex-col">
          {bundle ? (
            <>
              <div className="flex shrink-0 flex-col gap-4 border-b border-border px-6 pt-5 pb-5 pr-14">
                <button
                  type="button"
                  onClick={() => setBundleId(null)}
                  className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft size={14} />
                  {category === "all"
                    ? t("skills.library.title")
                    : categoryLabel(t, category)}
                </button>
                <div className="flex items-start gap-4">
                  <Tile size="lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-lg font-medium text-foreground">
                      {bundle.title}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {bundle.description}
                    </span>
                    <span className="text-meta pt-1">
                      {skillCount(bundle.members.length)} ·{" "}
                      {categoryLabel(t, bundle.category)}
                    </span>
                  </div>
                  {has(bundleRef(bundle.id)) ? (
                    <span className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-foreground">
                      <Check size={14} />
                      {t("skills.library.added")}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      className="shrink-0"
                      onClick={() => onAdd(bundleRef(bundle.id))}
                    >
                      <Plus size={14} />
                      {t("skills.table.addToProject")}
                    </Button>
                  )}
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-6">
                <div className="surface divide-y divide-border overflow-hidden">
                  {bundle.members.map((entry) => (
                    <SkillLine key={entry.id} entry={entry} />
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="shrink-0 border-b border-border px-6 py-4 pr-14">
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={t("skills.picker.search")}
                  className="w-full"
                />
              </div>
              <div className="flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto p-6">
                {packages.length > 0 && (
                  <section>
                    <Label>{t("skills.picker.bundles")}</Label>
                    <div className="grid grid-cols-1 gap-2.5 lg:grid-cols-2">
                      {packages.map((b) => (
                        <PackageCard
                          key={b.id}
                          bundle={b}
                          added={has(bundleRef(b.id))}
                          onOpen={() => setBundleId(b.id)}
                          onAdd={() => onAdd(bundleRef(b.id))}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {singles.length > 0 && (
                  <section>
                    <Label>{t("skills.library.individual")}</Label>
                    <div className="surface divide-y divide-border overflow-hidden">
                      {shownSingles.map((entry) => (
                        <SkillLine
                          key={entry.id}
                          entry={entry}
                          added={has(entry.id)}
                          onAdd={() => onAdd(entry.id)}
                        />
                      ))}
                      {shownSingles.length < singles.length && (
                        <button
                          type="button"
                          onClick={() => setAllSingles(true)}
                          className="w-full cursor-pointer px-3 py-3 text-left text-sm text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        >
                          {t("skills.library.showAll", {
                            count: singles.length,
                          })}
                        </button>
                      )}
                    </div>
                  </section>
                )}
                {packages.length === 0 && singles.length === 0 && (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    {t("skills.picker.empty")}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
