import { useState } from "react";
import {
  BookClosed,
  Calendar,
  ChevronDown,
  ChevronRight,
  Lightbulb01,
  Loading02,
  Stars02,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { extractPages } from "@/components/sections-editor/page-list";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { EmptyMessage } from "../empty-message";
import {
  type BrandRule,
  normalizeBrandRules,
  selectBrandEvidenceBlocks,
} from "./blog-data";
import { AddButton, RemoveButton, str } from "./blocks/primitives";

/**
 * Autonomous content: Planner, Ideas and Library behind one collection row.
 * Library holds the brand context, persisted to the site's own
 * `.deco/blocks/blog-manager-brand.json` as plain JSON.
 */
export const BRAND_BLOCK_KEY = "blog-manager-brand";

/** Stable empty seed — `useAutosave` re-seeds on reference change. */
const EMPTY_BRAND: Record<string, unknown> = {};

/** Free-text fields the extractor may fill. */
const TEXT_FIELDS = ["description", "tone", "targetAudience"] as const;
/** Fields holding `{ name, value }` rules. */
const RULE_FIELDS = ["values", "dos", "avoid", "competitors"] as const;

/**
 * Fixed rail of the Context tab. Unlike Content OS's Library, whose items are
 * rows in a table, these four are the shape of the brand block itself.
 */
const CONTEXT_SECTIONS = [
  { id: "basics", label: "sandbox.blogBrand.tabBasics" },
  { id: "dos", label: "sandbox.blogBrand.tabDos" },
  { id: "guardrails", label: "sandbox.blogBrand.tabGuardrails" },
  { id: "extra", label: "sandbox.blogBrand.tabExtra" },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey }>;

type ContextSection = (typeof CONTEXT_SECTIONS)[number]["id"];

const NAV = [
  {
    id: "planner",
    icon: Calendar,
    label: "sandbox.collectionsSidebar.planner",
  },
  { id: "ideas", icon: Lightbulb01, label: "sandbox.collectionsSidebar.ideas" },
  {
    id: "library",
    icon: BookClosed,
    label: "sandbox.collectionsSidebar.library",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  icon: unknown;
  label: TranslationKey;
}>;

type NavId = (typeof NAV)[number]["id"];

/** Steps the extract goes through, in order. See `phase` in LibraryScreen. */
type ExtractPhase = Extract<TranslationKey, `sandbox.blogBrand.phase${string}`>;
const PHASE_READING = "sandbox.blogBrand.phaseReading" satisfies ExtractPhase;

function strList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

export function AutonomousContent(props: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
}) {
  const t = useT();
  const [screen, setScreen] = useState<NavId>("planner");

  return (
    <div className="flex h-full">
      <nav className="w-[176px] shrink-0 space-y-0.5 border-r p-1.5">
        {NAV.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setScreen(id)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
              screen === id
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon size={16} className="shrink-0" />
            <span className="flex-1 truncate">{t(label)}</span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1">
        {screen === "library" ? (
          <LibraryScreen {...props} />
        ) : screen === "planner" ? (
          <EmptyMessage
            icon={Calendar}
            title={t("sandbox.planner.emptyTitle")}
            description={t("sandbox.planner.empty")}
          />
        ) : (
          <EmptyMessage
            icon={Lightbulb01}
            title={t("sandbox.ideas.underDevTitle")}
            description={t("sandbox.ideas.underDev")}
          />
        )}
      </div>
    </div>
  );
}

function LibraryScreen({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
}) {
  const block = decofile[BRAND_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });

  const [brand, setBrand] = useAutosave(block ?? EMPTY_BRAND, (next) => {
    save.mutate({ blockKey: BRAND_BLOCK_KEY, data: next });
  });

  const setField = (key: string, value: unknown) =>
    setBrand({ ...brand, [key]: value });

  const [isExtracting, setIsExtracting] = useState(false);
  /**
   * Which step of the extract is running. Advanced on a timer, not by the
   * server: the tool is one round trip, so these are the pipeline's known
   * phases timed against how long each usually takes — never a real progress
   * report, so the copy stays qualitative.
   */
  const [phase, setPhase] = useState<ExtractPhase>(PHASE_READING);
  /** Bumped to remount the markdown editors: they read `defaultValue` once. */
  const [editorRevision, setEditorRevision] = useState(0);
  const [tab, setTab] = useState<"context" | "formats">("context");
  const [section, setSection] = useState<ContextSection>("basics");

  /** The site's own content, ranked by how much it reveals about the voice. */
  const evidence = selectBrandEvidenceBlocks(
    decofile,
    extractPages(decofile).map((page) => page.key),
  );

  /** Fill from the site's own blocks, writing only into fields still empty. */
  const extract = async () => {
    if (evidence.length === 0) return;
    setIsExtracting(true);
    setPhase(PHASE_READING);
    const timers = [
      setTimeout(() => setPhase("sandbox.blogBrand.phaseInferring"), 4_000),
      setTimeout(() => setPhase("sandbox.blogBrand.phaseSearching"), 15_000),
    ];
    try {
      const result = await studio.call("BLOG_BRAND_EXTRACT", {
        blocks: evidence,
      });
      const next: Record<string, unknown> = { ...brand };
      const filled: string[] = [];

      if (!str(next.companyName) && result.companyName) {
        next.companyName = result.companyName;
        filled.push("companyName");
      }
      if (!str(next.language) && result.language) {
        next.language = result.language;
        filled.push("language");
      }
      for (const field of TEXT_FIELDS) {
        if (!str(next[field]) && result[field]) {
          next[field] = result[field];
          filled.push(field);
        }
      }
      for (const field of RULE_FIELDS) {
        if (
          normalizeBrandRules(next[field]).length === 0 &&
          result[field]?.length
        ) {
          next[field] = result[field];
          filled.push(field);
        }
      }
      if (strList(next.categories).length === 0 && result.categories?.length) {
        next.categories = result.categories;
        filled.push("categories");
      }

      setBrand(next);
      setEditorRevision((n) => n + 1);
      toast.success(
        filled.length > 0
          ? t("sandbox.blogBrand.extractFilled", {
              count: String(filled.length),
            })
          : t("sandbox.blogBrand.extractNothingEmpty"),
      );
      if (result.searchedCompetitors && result.competitors.length === 0) {
        toast.info(t("sandbox.blogBrand.noCompetitorsFound"));
      }
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.blogBrand.extractFailed"),
      );
    } finally {
      for (const timer of timers) clearTimeout(timer);
      setIsExtracting(false);
    }
  };

  const ruleListFor = (
    field: (typeof RULE_FIELDS)[number],
    labels: { add: string; namePlaceholder: string; bodyPlaceholder: string },
  ) => (
    <RuleList
      rules={normalizeBrandRules(brand[field])}
      onChange={(rules) => setField(field, rules)}
      revision={editorRevision}
      idPrefix={field}
      {...labels}
    />
  );

  const sectionBody = () => {
    switch (section) {
      case "basics":
        return (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="brand-company-name"
                label={t("sandbox.blogBrand.companyNameLabel")}
                value={str(brand.companyName)}
                onChange={(v) => setField("companyName", v)}
              />
              <Field
                id="brand-language"
                label={t("sandbox.blogBrand.languageLabel")}
                placeholder="pt-BR"
                value={str(brand.language)}
                onChange={(v) => setField("language", v)}
              />
            </div>
            <TextAreaField
              id="brand-description"
              label={t("sandbox.blogBrand.descriptionLabel")}
              value={str(brand.description)}
              onChange={(v) => setField("description", v)}
            />
            <TextAreaField
              id="brand-tone"
              label={t("sandbox.blogBrand.toneLabel")}
              hint={t("sandbox.blogBrand.toneHint")}
              value={str(brand.tone)}
              onChange={(v) => setField("tone", v)}
              rows={5}
            />
            <TextAreaField
              id="brand-audience"
              label={t("sandbox.blogBrand.audienceLabel")}
              value={str(brand.targetAudience)}
              onChange={(v) => setField("targetAudience", v)}
            />
          </div>
        );
      case "dos":
        return (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("sandbox.blogBrand.dosHint")}
            </p>
            {ruleListFor("dos", {
              add: t("sandbox.blogBrand.addDo"),
              namePlaceholder: t("sandbox.blogBrand.dosNamePlaceholder"),
              bodyPlaceholder: t("sandbox.blogBrand.dosBodyPlaceholder"),
            })}
          </div>
        );
      case "guardrails":
        return (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {t("sandbox.blogBrand.dontsHint")}
            </p>
            {ruleListFor("avoid", {
              add: t("sandbox.blogBrand.addDont"),
              namePlaceholder: t("sandbox.blogBrand.dontsNamePlaceholder"),
              bodyPlaceholder: t("sandbox.blogBrand.dontsBodyPlaceholder"),
            })}
          </div>
        );
      case "extra":
        return (
          <div className="space-y-8">
            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.valuesLabel")}</Label>
              {ruleListFor("values", {
                add: t("sandbox.blogBrand.addValue"),
                namePlaceholder: t("sandbox.blogBrand.valuesNamePlaceholder"),
                bodyPlaceholder: t("sandbox.blogBrand.valuesBodyPlaceholder"),
              })}
            </section>

            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.categoriesLabel")}</Label>
              <StringList
                addLabel={t("sandbox.blogBrand.addCategory")}
                values={strList(brand.categories)}
                onChange={(v) => setField("categories", v)}
              />
            </section>

            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.competitorsLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.competitorsHint")}
              </p>
              {ruleListFor("competitors", {
                add: t("sandbox.blogBrand.addCompetitor"),
                namePlaceholder: t(
                  "sandbox.blogBrand.competitorsNamePlaceholder",
                ),
                bodyPlaceholder: t(
                  "sandbox.blogBrand.competitorsBodyPlaceholder",
                ),
              })}
            </section>
          </div>
        );
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-4 px-8 pt-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {t("sandbox.library.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("sandbox.library.subtitle")}
          </p>
        </div>
        <SaveStatus isPending={save.isPending} isError={save.isError} />
      </div>

      {/* Tab row doubles as the action bar — the extract fills every section. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-8">
        <div className="flex gap-1">
          <TabButton
            active={tab === "context"}
            onClick={() => setTab("context")}
          >
            {t("sandbox.library.tabContext")}
          </TabButton>
          <TabButton
            active={tab === "formats"}
            onClick={() => setTab("formats")}
          >
            {t("sandbox.library.tabFormats")}
          </TabButton>
        </div>
        {tab === "context" && (
          <div className="flex min-w-0 items-center gap-3">
            {isExtracting && (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                aria-live="polite"
                role="status"
              >
                <Loading02 size={12} className="shrink-0 animate-spin" />
                <span className="truncate">{t(phase)}</span>
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="my-2 shrink-0"
              disabled={isExtracting || evidence.length === 0}
              title={
                evidence.length > 0
                  ? t("sandbox.blogBrand.extractHint", {
                      count: String(evidence.length),
                    })
                  : t("sandbox.blogBrand.extractNoContent")
              }
              onClick={() => void extract()}
            >
              <Stars02 size={14} />
              {t("sandbox.blogBrand.extractButton")}
            </Button>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {tab === "formats" ? (
          <EmptyMessage
            title={t("sandbox.library.formatsUnderDevTitle")}
            description={t("sandbox.library.formatsUnderDev")}
          />
        ) : (
          <div className="grid grid-cols-[240px_1fr] gap-8 px-8 py-6">
            <nav className="sticky top-0 h-fit space-y-0.5 rounded-xl border bg-card p-1.5">
              {CONTEXT_SECTIONS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setSection(entry.id)}
                  className={cn(
                    "w-full rounded-lg px-2.5 py-2 text-left text-sm transition-colors cursor-pointer",
                    section === entry.id
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {t(entry.label)}
                </button>
              ))}
            </nav>
            <div className="min-w-0 max-w-3xl">{sectionBody()}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Underlined tab, matching the Content OS library header. */
function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-3 py-3 text-sm transition-colors cursor-pointer",
        active
          ? "border-foreground font-medium text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-10"
      />
    </div>
  );
}

function TextAreaField({
  id,
  label,
  hint,
  value,
  onChange,
  rows = 3,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <Textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * List of `{ name, value }` rules. A row shows the name; clicking it opens that
 * rule's markdown body, and only one is open at a time — a column of editors is
 * unreadable once there are more than two rules. Rows key by index (no stable
 * id, no reordering); `revision` keys the editors so an outside fill remounts
 * them.
 */
function RuleList({
  rules,
  onChange,
  revision,
  idPrefix,
  add,
  namePlaceholder,
  bodyPlaceholder,
}: {
  rules: BrandRule[];
  onChange: (rules: BrandRule[]) => void;
  revision: number;
  idPrefix: string;
  add: string;
  namePlaceholder: string;
  bodyPlaceholder: string;
}) {
  const t = useT();
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const replaceAt = (index: number, patch: Partial<BrandRule>) =>
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const remove = (index: number) => {
    onChange(rules.filter((_, i) => i !== index));
    // Indices shift on delete, so anything but the untouched prefix is stale.
    setOpenIndex((open) => (open === null || open < index ? open : null));
  };

  return (
    <div className="space-y-2">
      <ul className="divide-y overflow-hidden rounded-lg border">
        {rules.map((rule, index) => {
          const open = openIndex === index;
          return (
            <li key={index} className="group/item bg-card">
              <div className="flex items-center gap-1 pr-2">
                <button
                  type="button"
                  onClick={() => setOpenIndex(open ? null : index)}
                  aria-expanded={open}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                >
                  {open ? (
                    <ChevronDown size={14} className="shrink-0" />
                  ) : (
                    <ChevronRight
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                  <span
                    className={cn(
                      "truncate",
                      !rule.name && "text-muted-foreground",
                    )}
                  >
                    {rule.name || t("sandbox.blogBrand.untitledRule")}
                  </span>
                </button>
                <RemoveButton
                  label={t("sandbox.blogBrand.removeItem")}
                  onClick={() => remove(index)}
                />
              </div>
              {open && (
                <div className="space-y-3 border-t bg-background px-3 py-3">
                  <Input
                    value={rule.name}
                    placeholder={namePlaceholder}
                    onChange={(e) => replaceAt(index, { name: e.target.value })}
                    className="h-9 font-medium"
                  />
                  <MarkdownEditor
                    key={`${idPrefix}-${index}-${revision}`}
                    defaultValue={rule.value}
                    placeholder={bodyPlaceholder}
                    attachments={false}
                    onChange={(markdown) =>
                      replaceAt(index, { value: markdown })
                    }
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <AddButton
        label={add}
        onClick={() => {
          onChange([...rules, { name: "", value: "" }]);
          setOpenIndex(rules.length);
        }}
      />
    </div>
  );
}

/** Editable list of plain names — used for the blog category taxonomy. */
function StringList({
  addLabel,
  values,
  onChange,
}: {
  addLabel: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        {values.map((value, index) => (
          <div key={index} className="group/item flex items-center gap-1.5">
            <Input
              value={value}
              onChange={(e) =>
                onChange(
                  values.map((v, i) => (i === index ? e.target.value : v)),
                )
              }
              className="h-9"
            />
            <RemoveButton
              label={t("sandbox.blogBrand.removeItem")}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            />
          </div>
        ))}
      </div>
      <AddButton label={addLabel} onClick={() => onChange([...values, ""])} />
    </div>
  );
}
