/**
 * Autonomous content: Generate, Themes and Library behind one collection row.
 * Library holds the brand, the writing rules and the post formats, each persisted to the site's own `.deco/blocks/blog-manager-*.json` as plain JSON. The brand and the writing rules are two blocks behind one seamless screen, and the fill button runs both passes.
 *
 * Scheduling deliberately lives outside this tab — it is a first-party feature
 * of the blog, and generation only produces the drafts it schedules.
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loading02,
  Stars02,
} from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useHideDefaultBlogBlocks } from "@/hooks/use-hide-default-blog-blocks";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { MarkdownEditor } from "@/components/markdown-editor";
import type { MarkdownMentions } from "@/components/markdown-editor";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
import { extractPages } from "@/components/sections-editor/page-list";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import { RecordEditor } from "./record-editor";
import { CategoryEditor } from "./category-editor";
import {
  type BlogKind,
  BRAND_BLOCK_KEY,
  type BrandRule,
  CONTEXT_BLOCK_KEY,
  buildBlogBlock,
  dedupeSuggestedThemes,
  defaultFormatSections,
  emptyBlogPayload,
  FORMATS_BLOCK_KEY,
  generateBlogKey,
  mentionableSections,
  filledBrandRules,
  newPillarKey,
  normalizeBrandRules,
  normalizeTitleKey,
  normalizeVoiceExamples,
  type VoiceExample,
  postStructures,
  scanBlogEntries,
  scanPillars,
  selectBrandEvidence,
  applyExtractResult,
  asBlock,
  type FillMode,
  contextForTools,
  readBlogContext,
  pickBlogFields,
  BRAND_FIELDS,
  CONTEXT_FIELDS,
  unknownCitations,
} from "./blog-data";
import { AddButton, RemoveButton, str } from "./blocks/primitives";
import {
  fetchCatalogEvidence,
  hasVtexCatalog,
} from "./blocks/catalog-evidence";

/** Stable empty seed — `useAutosave` re-seeds on reference change. */
const EMPTY_FORMATS: Record<string, unknown> = {};

/** Free-text brand fields the extractor may fill. */
const BRAND_TEXT_FIELDS = ["description", "targetAudience"] as const;
/** Brand fields holding `{ name, value }` rules. */
const BRAND_RULE_FIELDS = [
  "values",
  "competitors",
  "keywords",
  "differentiators",
  "commercialPolicies",
  "specialDates",
] as const;
/** Writing-context fields holding `{ name, value }` rules. */
const CONTEXT_RULE_FIELDS = ["dos", "avoid", "vocabulary"] as const;
/** Fields holding example sentences, which are not `{ name, value }` rules. */
const CONTEXT_EXAMPLE_FIELDS = ["voiceExamples"] as const;

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

/** The tabs of the Context screen. */
type ContextTab = "brand" | "formats" | "pillars" | "authors" | "categories";

/** Steps the extract goes through, in order. See `phase` in BlogContext. */
type ExtractPhase = Extract<TranslationKey, `sandbox.blogBrand.phase${string}`>;
const PHASE_READING = "sandbox.blogBrand.phaseReading" satisfies ExtractPhase;

/** Steps the format suggestion goes through, in order. */
type FormatPhase = Extract<TranslationKey, `sandbox.formats.phase${string}`>;
const FORMAT_PHASE_READING =
  "sandbox.formats.phaseReading" satisfies FormatPhase;

/** Steps the pillar suggestion goes through, in order. */
type PillarPhase = Extract<TranslationKey, `sandbox.pillars.phase${string}`>;
const PILLAR_PHASE_READING =
  "sandbox.pillars.phaseReading" satisfies PillarPhase;

/**
 * A plain format anyone can start from, written locally: no model, no credits,
 * and so nothing to fail. Cites only sections the site actually has.
 */
function starterFormat(
  t: ReturnType<typeof useT>,
  sections: string[],
): BrandRule {
  return {
    name: t("sandbox.formats.starterName"),
    value: sections.length
      ? t("sandbox.formats.starterBody", {
          sections: sections.map((name) => `@${name}`).join(", "),
        })
      : t("sandbox.formats.starterBodyNoSections"),
  };
}

/**
 * The blog's editorial Context: Brand, Formats, Content pillars, plus the
 * Authors and Categories reference data — each persisted to the site's own
 * `.deco/blocks/`. Replaces the old "Autonomous content" shell; generation now
 * lives on the Posts board, and themes are reconceived as pillars here.
 */
export function BlogContext({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
  onOpenPost,
  onManageCategoryPosts,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  /** Open a post in the Posts area (from a category's post links). */
  onOpenPost?: (key: string) => void;
  /** Jump to the Posts area to manage a category's posts. */
  onManageCategoryPosts?: (slug: string) => void;
}) {
  const storedBrand = asBlock(decofile[BRAND_BLOCK_KEY]);
  const storedContext = asBlock(decofile[CONTEXT_BLOCK_KEY]);
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  /** Every button here spends org credits, so none of them work without a provider. */
  const hasAi = useHostedAiProviderKeys().length > 0;
  const hideDefaultBlocks = useHideDefaultBlogBlocks();

  /**
   * Each draft is seeded from a whole stored block — a reference straight off
   * the decofile, because `useAutosave` re-seeds on reference change and a
   * value derived per render would discard the edit in progress. Narrowing to
   * the fields the block owns happens on the way out instead, which is also
   * what makes a legacy brand block shed the rules it no longer owns.
   */
  const [brand, setBrand] = useAutosave(storedBrand, (next) => {
    save.mutate({
      blockKey: BRAND_BLOCK_KEY,
      data: pickBlogFields(next, BRAND_FIELDS),
    });
  });

  /**
   * The writing rules. Before the split they lived in the brand block, so that
   * is what seeds this one while `blog-manager-context` is absent.
   */
  const [context, setContext] = useAutosave(
    decofile[CONTEXT_BLOCK_KEY] ? storedContext : storedBrand,
    (next) => {
      save.mutate({
        blockKey: CONTEXT_BLOCK_KEY,
        data: pickBlogFields(next, CONTEXT_FIELDS),
      });
    },
  );

  const setField = (key: string, value: unknown) =>
    setBrand({ ...brand, [key]: value });

  const setContextField = (key: string, value: unknown) =>
    setContext({ ...context, [key]: value });

  const formatsBlock = decofile[FORMATS_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const [formatsData, setFormatsData] = useAutosave(
    formatsBlock ?? EMPTY_FORMATS,
    (next) => save.mutate({ blockKey: FORMATS_BLOCK_KEY, data: next }),
  );
  const formats = normalizeBrandRules(formatsData.formats);
  const setFormats = (rules: BrandRule[]) =>
    setFormatsData({ ...formatsData, formats: rules });

  /** The sections a format's brief may cite, and the `@` picker's contents. */
  const sections = mentionableSections(meta, {
    hideDefaults: hideDefaultBlocks,
  });
  const sectionNames = sections.map((s) => s.name);
  const mentions: MarkdownMentions = {
    items: sections,
    hint: t("sandbox.formats.mentionHint"),
    emptyLabel: t("sandbox.formats.mentionEmpty"),
  };

  const [isSuggesting, setIsSuggesting] = useState(false);
  const [formatPhase, setFormatPhase] =
    useState<FormatPhase>(FORMAT_PHASE_READING);

  const [isExtracting, setIsExtracting] = useState(false);
  const [fillOpen, setFillOpen] = useState(false);
  /**
   * Which step of the extract is running. Only the handover between the two passes is real; the rest is on a timer, so the copy stays qualitative.
   */
  const [phase, setPhase] = useState<ExtractPhase>(PHASE_READING);
  /** Bumped to remount the markdown editors: they read `defaultValue` once. */
  const [editorRevision, setEditorRevision] = useState(0);
  const [tab, setTab] = useState<ContextTab>("brand");
  const [section, setSection] = useState<ContextSection>("basics");

  /** The site's own content, ranked by how much it reveals about the voice. */
  const evidence = selectBrandEvidence(decofile, extractPages(decofile));

  /**
   * Whether anything here was written already. With nothing to overwrite the
   * two fill modes do the same thing, so asking which one would be a question
   * with one answer.
   */
  const hasWrittenContext = [
    ...BRAND_FIELDS.map((field) => brand[field]),
    ...CONTEXT_FIELDS.map((field) => context[field]),
  ].some((value) =>
    typeof value === "string"
      ? value.trim().length > 0
      : filledBrandRules(normalizeBrandRules(value)).length > 0,
  );

  /**
   * Fill from the site's own blocks, writing only into fields still empty.
   *
   * Two passes, in order: who the brand is, then how it writes. The second is
   * given the first's answer — writing rules read out of a site's copy are only
   * as good as the understanding of whose copy it is — so they cannot run
   * concurrently, and a failed brand pass aborts rather than inferring rules
   * against a blank profile.
   */
  const extract = async (mode: FillMode) => {
    if (evidence.blocks.length === 0) return;
    setIsExtracting(true);
    setPhase(PHASE_READING);
    // Starts now so it overlaps the first model call instead of adding to it.
    const catalogRead = hasVtexCatalog(meta)
      ? fetchCatalogEvidence({ orgSlug, virtualMcpId, branch, threadId: null })
      : Promise.resolve("");
    const timers = [
      setTimeout(() => setPhase("sandbox.blogBrand.phaseResearching"), 15_000),
    ];
    try {
      const catalog = await catalogRead;
      const brandResult = await studio.call("BLOG_BRAND_EXTRACT", {
        blocks: evidence.blocks,
        seo: evidence.seo,
        catalog: catalog || undefined,
      });
      const nextBrand: Record<string, unknown> = { ...brand };
      const filled = applyExtractResult(nextBrand, brandResult, {
        mode,
        textFields: ["companyName", "language", ...BRAND_TEXT_FIELDS],
        ruleFields: BRAND_RULE_FIELDS,
      });
      setBrand(nextBrand);

      // The search belongs to the brand pass; don't relabel the next one.
      for (const timer of timers) clearTimeout(timer);
      setPhase("sandbox.blogBrand.phaseInferring");
      const contextResult = await studio.call("BLOG_CONTEXT_EXTRACT", {
        brand: brandResult,
        blocks: evidence.blocks,
        seo: evidence.seo,
      });
      const nextContext: Record<string, unknown> = { ...context };
      filled.push(
        ...applyExtractResult(nextContext, contextResult, {
          mode,
          textFields: ["tone"],
          ruleFields: CONTEXT_RULE_FIELDS,
          exampleFields: CONTEXT_EXAMPLE_FIELDS,
        }),
      );
      setContext(nextContext);

      setEditorRevision((n) => n + 1);
      toast.success(
        filled.length > 0
          ? t(
              mode === "replace"
                ? "sandbox.blogBrand.extractReplaced"
                : "sandbox.blogBrand.extractFilled",
              { count: String(filled.length) },
            )
          : t("sandbox.blogBrand.extractNothingEmpty"),
      );
      if (brandResult.searched && brandResult.competitors.length === 0) {
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

  /** Append formats whose name isn't taken yet; returns how many landed. */
  const addFormats = (proposed: BrandRule[]) => {
    const taken = new Set(formats.map((f) => normalizeTitleKey(f.name)));
    const fresh = proposed.filter(
      (f) => f.name.trim() && !taken.has(normalizeTitleKey(f.name)),
    );
    if (fresh.length === 0) return 0;
    setFormats([...formats, ...fresh]);
    setEditorRevision((n) => n + 1);
    return fresh.length;
  };

  /** The starter format, written locally — no model, no credits, no failure. */
  const addStarterFormat = () => {
    const added = addFormats([
      starterFormat(t, defaultFormatSections(sectionNames)),
    ]);
    if (added === 0) {
      toast.info(t("sandbox.formats.noNewFormats"));
      return;
    }
    toast.success(t("sandbox.formats.starterAdded"));
  };

  /** Name the formats this blog already writes in, from the shape of its posts. */
  const suggestFormats = async () => {
    setIsSuggesting(true);
    setFormatPhase(FORMAT_PHASE_READING);
    const timer = setTimeout(
      () => setFormatPhase("sandbox.formats.phaseWriting"),
      6_000,
    );
    try {
      const result = await studio.call("BLOG_FORMAT_SUGGEST", {
        brand: contextForTools({ ...brand, ...context }),
        sections,
        postStructures: postStructures(decofile).map((post) => ({
          title: post.title,
          sections: post.sections,
        })),
      });

      const fresh = addFormats(result.formats);
      if (fresh === 0) {
        toast.info(t("sandbox.formats.noNewFormats"));
        return;
      }
      toast.success(t("sandbox.formats.suggested", { count: String(fresh) }));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.formats.suggestFailed"),
      );
    } finally {
      clearTimeout(timer);
      setIsSuggesting(false);
    }
  };

  const ruleListFor = (
    field:
      | (typeof BRAND_RULE_FIELDS)[number]
      | (typeof CONTEXT_RULE_FIELDS)[number],
    labels: { add: string; namePlaceholder: string; bodyPlaceholder: string },
  ) => {
    const writesToContext = (CONTEXT_RULE_FIELDS as readonly string[]).includes(
      field,
    );
    const source = writesToContext ? context : brand;
    const setValue = writesToContext ? setContextField : setField;
    return (
      <RuleList
        rules={normalizeBrandRules(source[field])}
        onChange={(rules) => setValue(field, rules)}
        revision={editorRevision}
        idPrefix={field}
        {...labels}
      />
    );
  };

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
              value={str(context.tone)}
              onChange={(v) => setContextField("tone", v)}
              rows={5}
            />
            <TextAreaField
              id="brand-audience"
              label={t("sandbox.blogBrand.audienceLabel")}
              value={str(brand.targetAudience)}
              onChange={(v) => setField("targetAudience", v)}
            />
            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.voiceExamplesLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.voiceExamplesHint")}
              </p>
              <VoiceExampleList
                examples={normalizeVoiceExamples(context.voiceExamples)}
                onChange={(next) => setContextField("voiceExamples", next)}
              />
            </section>
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
            <section className="space-y-2 pt-4">
              <Label>{t("sandbox.blogBrand.vocabularyLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.vocabularyHint")}
              </p>
              {ruleListFor("vocabulary", {
                add: t("sandbox.blogBrand.addVocabulary"),
                namePlaceholder: t(
                  "sandbox.blogBrand.vocabularyNamePlaceholder",
                ),
                bodyPlaceholder: t(
                  "sandbox.blogBrand.vocabularyBodyPlaceholder",
                ),
              })}
            </section>
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

            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.differentiatorsLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.differentiatorsHint")}
              </p>
              {ruleListFor("differentiators", {
                add: t("sandbox.blogBrand.addDifferentiator"),
                namePlaceholder: t(
                  "sandbox.blogBrand.differentiatorsNamePlaceholder",
                ),
                bodyPlaceholder: t(
                  "sandbox.blogBrand.differentiatorsBodyPlaceholder",
                ),
              })}
            </section>

            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.keywordsLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.keywordsHint")}
              </p>
              {ruleListFor("keywords", {
                add: t("sandbox.blogBrand.addKeyword"),
                namePlaceholder: t("sandbox.blogBrand.keywordsNamePlaceholder"),
                bodyPlaceholder: t("sandbox.blogBrand.keywordsBodyPlaceholder"),
              })}
            </section>

            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.specialDatesLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.specialDatesHint")}
              </p>
              {ruleListFor("specialDates", {
                add: t("sandbox.blogBrand.addSpecialDate"),
                namePlaceholder: t(
                  "sandbox.blogBrand.specialDatesNamePlaceholder",
                ),
                bodyPlaceholder: t(
                  "sandbox.blogBrand.specialDatesBodyPlaceholder",
                ),
              })}
            </section>

            <section className="space-y-2">
              <Label>{t("sandbox.blogBrand.policiesLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.blogBrand.policiesHint")}
              </p>
              {ruleListFor("commercialPolicies", {
                add: t("sandbox.blogBrand.addPolicy"),
                namePlaceholder: t("sandbox.blogBrand.policiesNamePlaceholder"),
                bodyPlaceholder: t("sandbox.blogBrand.policiesBodyPlaceholder"),
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
            {t("sandbox.blogContext.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("sandbox.blogContext.subtitle")}
          </p>
        </div>
        <SaveStatus isPending={save.isPending} isError={save.isError} />
      </div>

      {/* Tab row doubles as the action bar — the extract fills every section. */}
      <div className="flex shrink-0 items-center justify-between gap-4 border-b px-8">
        <div className="flex gap-1">
          <TabButton active={tab === "brand"} onClick={() => setTab("brand")}>
            {t("sandbox.blogContext.tabBrand")}
          </TabButton>
          <TabButton
            active={tab === "formats"}
            onClick={() => setTab("formats")}
          >
            {t("sandbox.blogContext.tabFormats")}
          </TabButton>
          <TabButton
            active={tab === "pillars"}
            onClick={() => setTab("pillars")}
          >
            {t("sandbox.blogContext.tabPillars")}
          </TabButton>
          <TabButton
            active={tab === "authors"}
            onClick={() => setTab("authors")}
          >
            {t("sandbox.blogContext.tabAuthors")}
          </TabButton>
          <TabButton
            active={tab === "categories"}
            onClick={() => setTab("categories")}
          >
            {t("sandbox.blogContext.tabCategories")}
          </TabButton>
        </div>
        {tab === "brand" && (
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
              disabled={isExtracting || evidence.blocks.length === 0 || !hasAi}
              title={
                !hasAi
                  ? t("sandbox.autonomous.noAiProvider")
                  : evidence.blocks.length > 0
                    ? t("sandbox.blogBrand.extractHint", {
                        count: String(evidence.blocks.length),
                      })
                    : t("sandbox.blogBrand.extractNoContent")
              }
              onClick={() => {
                if (hasWrittenContext) setFillOpen(true);
                else void extract("empty");
              }}
            >
              <Stars02 size={14} />
              {t("sandbox.blogBrand.extractButton")}
            </Button>
            <Dialog open={fillOpen} onOpenChange={setFillOpen}>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    {t("sandbox.blogBrand.fillDialogTitle")}
                  </DialogTitle>
                  <DialogDescription>
                    {t("sandbox.blogBrand.fillDialogDescription")}
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                  {(
                    [
                      {
                        mode: "empty",
                        label: "sandbox.blogBrand.fillOnlyEmpty",
                        hint: "sandbox.blogBrand.fillOnlyEmptyHint",
                      },
                      {
                        mode: "replace",
                        label: "sandbox.blogBrand.fillReplace",
                        hint: "sandbox.blogBrand.fillReplaceHint",
                      },
                    ] as const satisfies ReadonlyArray<{
                      mode: FillMode;
                      label: TranslationKey;
                      hint: TranslationKey;
                    }>
                  ).map((option) => (
                    <button
                      key={option.mode}
                      type="button"
                      onClick={() => {
                        setFillOpen(false);
                        void extract(option.mode);
                      }}
                      className="cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <span className="text-sm font-medium">
                        {t(option.label)}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t(option.hint)}
                      </span>
                    </button>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
        {tab === "formats" && (
          <div className="flex min-w-0 items-center gap-3">
            {isSuggesting && (
              <span
                className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                aria-live="polite"
                role="status"
              >
                <Loading02 size={12} className="shrink-0 animate-spin" />
                <span className="truncate">{t(formatPhase)}</span>
              </span>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="my-2 shrink-0"
              title={t("sandbox.formats.starterHint")}
              onClick={addStarterFormat}
            >
              {t("sandbox.formats.starterButton")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="my-2 shrink-0"
              disabled={isSuggesting || !hasAi}
              title={
                hasAi
                  ? t("sandbox.formats.suggestHint")
                  : t("sandbox.autonomous.noAiProvider")
              }
              onClick={() => void suggestFormats()}
            >
              <Stars02 size={14} />
              {t("sandbox.formats.suggestButton")}
            </Button>
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {tab === "authors" ? (
          <EntityPanel
            kind="authors"
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            branch={branch}
            decofile={decofile}
            hint={t("sandbox.blogContext.authorsHint")}
            addLabel={t("sandbox.blogContext.addAuthor")}
            emptyLabel={t("sandbox.blogContext.authorsEmpty")}
            renderEditor={(key) => (
              <RecordEditor
                key={`author:${key}`}
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                kind="authors"
                blockKey={key}
                block={decofile[key] as Record<string, unknown>}
                meta={meta}
                decofile={decofile}
              />
            )}
          />
        ) : tab === "categories" ? (
          <EntityPanel
            kind="categories"
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            branch={branch}
            decofile={decofile}
            hint={t("sandbox.blogContext.categoriesHint")}
            addLabel={t("sandbox.blogContext.addCategory")}
            emptyLabel={t("sandbox.blogContext.categoriesEmpty")}
            renderEditor={(key) => (
              <CategoryEditor
                key={`category:${key}`}
                orgSlug={orgSlug}
                virtualMcpId={virtualMcpId}
                branch={branch}
                blockKey={key}
                block={decofile[key] as Record<string, unknown>}
                decofile={decofile}
                meta={meta}
                onManagePosts={(slug) => onManageCategoryPosts?.(slug)}
                onOpenPost={(postKey) => onOpenPost?.(postKey)}
              />
            )}
          />
        ) : tab === "pillars" ? (
          <PillarsPanel
            orgSlug={orgSlug}
            virtualMcpId={virtualMcpId}
            branch={branch}
            decofile={decofile}
            hasAi={hasAi}
          />
        ) : tab === "formats" ? (
          <div className="min-w-0 max-w-3xl space-y-3 px-8 py-6">
            <p className="text-xs text-muted-foreground">
              {t("sandbox.formats.hint")}
            </p>
            <RuleList
              rules={formats}
              onChange={setFormats}
              revision={editorRevision}
              idPrefix="format"
              add={t("sandbox.formats.add")}
              namePlaceholder={t("sandbox.formats.namePlaceholder")}
              bodyPlaceholder={t("sandbox.formats.bodyPlaceholder")}
              mentions={mentions}
              citationWarning={(value) => {
                const unknown = unknownCitations(value, sectionNames);
                return unknown.length === 0
                  ? null
                  : t("sandbox.formats.unknownCitations", {
                      names: unknown.map((name) => `@${name}`).join(", "),
                    });
              }}
            />
          </div>
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
 * Example sentences, each with the side of the line it sits on.
 *
 * Flat rows rather than the collapsible {@link RuleList}: there is nothing to
 * name and nothing to write a body for, and the pair only teaches when both
 * sides are readable at once. The toggle is the whole point — the same sentence
 * read as "like this" and as "never this" are opposite instructions.
 */
function VoiceExampleList({
  examples,
  onChange,
}: {
  examples: VoiceExample[];
  onChange: (examples: VoiceExample[]) => void;
}) {
  const t = useT();
  const replaceAt = (index: number, patch: Partial<VoiceExample>) =>
    onChange(examples.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  return (
    <div className="space-y-2">
      {examples.length > 0 && (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {examples.map((example, index) => (
            <li
              key={index}
              className="flex items-center gap-2 bg-card px-3 py-2"
            >
              <Input
                aria-label={t("sandbox.blogBrand.voiceExamplesLabel")}
                placeholder={t("sandbox.blogBrand.voiceExamplesPlaceholder")}
                value={example.text}
                onChange={(e) => replaceAt(index, { text: e.target.value })}
                className="min-w-0 flex-1 border-0 shadow-none focus-visible:ring-0"
              />
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={example.sounds}
                  onCheckedChange={(sounds) => replaceAt(index, { sounds })}
                />
                <span className="whitespace-nowrap">
                  {t(
                    example.sounds
                      ? "sandbox.blogBrand.voiceExamplesSounds"
                      : "sandbox.blogBrand.voiceExamplesDoesNotSound",
                  )}
                </span>
              </label>
              <RemoveButton
                label={t("sandbox.blogBrand.removeItem")}
                onClick={() => onChange(examples.filter((_, i) => i !== index))}
              />
            </li>
          ))}
        </ul>
      )}
      <AddButton
        label={t("sandbox.blogBrand.addVoiceExample")}
        onClick={() => onChange([...examples, { text: "", sounds: true }])}
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
  mentions,
  citationWarning,
}: {
  rules: BrandRule[];
  onChange: (rules: BrandRule[]) => void;
  revision: number;
  idPrefix: string;
  add: string;
  namePlaceholder: string;
  bodyPlaceholder: string;
  /** Enables `@` in the body editor. Only formats cite site sections. */
  mentions?: MarkdownMentions;
  /** Message for a body citing something that doesn't exist, or null. */
  citationWarning?: (value: string) => string | null;
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
          const warning = open ? citationWarning?.(rule.value) : null;
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
                    mentions={mentions}
                    onChange={(markdown) =>
                      replaceAt(index, { value: markdown })
                    }
                  />
                  {warning && <p className="text-xs text-warning">{warning}</p>}
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

/**
 * The pillars tab: the editorial queue of recurring territories. One block per
 * pillar under `blog-manager/pillars/` (reads the legacy themes prefix too), so
 * appending suggestions can't clobber the one being edited.
 */
function PillarsPanel({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  hasAi,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  hasAi: boolean;
}) {
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [phase, setPhase] = useState<PillarPhase>(PILLAR_PHASE_READING);

  const pillars = scanPillars(decofile);
  const { merged } = readBlogContext(decofile);
  const hasBrand = Boolean(str(merged.companyName) || str(merged.description));

  const addPillar = () => {
    const blockKey = newPillarKey();
    save.mutate({
      blockKey,
      data: { title: "", body: "", createdAt: new Date().toISOString() },
    });
    setOpenKey(blockKey);
  };

  const suggest = async () => {
    setIsSuggesting(true);
    setPhase(PILLAR_PHASE_READING);
    const timer = setTimeout(
      () => setPhase("sandbox.pillars.phaseWriting"),
      4_000,
    );
    try {
      const result = await studio.call("BLOG_PILLAR_SUGGEST", {
        brand: contextForTools(merged),
        existingPillars: pillars.map((p) => p.title).filter(Boolean),
        guidance: guidance.trim() || undefined,
      });

      const fresh = dedupeSuggestedThemes(
        pillars.map((p) => p.title),
        result.pillars,
      );
      if (fresh.length === 0) {
        toast.info(t("sandbox.pillars.noNew"));
        return;
      }

      const now = Date.now();
      let created = 0;
      // One at a time — parallel writes race the fast-preview decofile cache.
      for (const [index, pillar] of fresh.entries()) {
        try {
          await save.mutateAsync({
            blockKey: newPillarKey(),
            data: {
              title: pillar.title,
              body: pillar.body,
              createdAt: new Date(now - index).toISOString(),
            },
          });
          created++;
        } catch (err) {
          console.warn("[pillars] could not save a suggested pillar", err);
        }
      }

      if (created === 0) {
        toast.error(t("sandbox.pillars.suggestFailed"));
        return;
      }
      toast.success(t("sandbox.pillars.suggested", { count: String(created) }));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.pillars.suggestFailed"),
      );
    } finally {
      clearTimeout(timer);
      setIsSuggesting(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-start justify-between gap-3 px-8 pb-3 pt-4">
        <p className="max-w-xl text-xs text-muted-foreground">
          {t("sandbox.pillars.hint")}
        </p>
        <div className="flex shrink-0 items-center gap-3">
          {isSuggesting && (
            <span
              className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
              aria-live="polite"
              role="status"
            >
              <Loading02 size={12} className="shrink-0 animate-spin" />
              <span className="truncate">{t(phase)}</span>
            </span>
          )}
          <Popover open={askOpen} onOpenChange={setAskOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                disabled={isSuggesting || !hasBrand || !hasAi}
                title={
                  !hasAi
                    ? t("sandbox.autonomous.noAiProvider")
                    : hasBrand
                      ? t("sandbox.pillars.suggestHint")
                      : t("sandbox.pillars.suggestNoBrand")
                }
              >
                <Stars02 size={14} />
                {t("sandbox.pillars.suggest")}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 space-y-3">
              <div className="space-y-1">
                <Label htmlFor="pillar-guidance">
                  {t("sandbox.pillars.guidanceLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.pillars.guidanceHint")}
                </p>
              </div>
              <Input
                id="pillar-guidance"
                value={guidance}
                onChange={(e) => setGuidance(e.target.value)}
                placeholder={t("sandbox.pillars.guidancePlaceholder")}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  setAskOpen(false);
                  void suggest();
                }}
                className="h-9"
              />
              <Button
                type="button"
                size="sm"
                className="w-full"
                onClick={() => {
                  setAskOpen(false);
                  void suggest();
                }}
              >
                <Stars02 size={14} />
                {t("sandbox.pillars.suggest")}
              </Button>
            </PopoverContent>
          </Popover>
          <SaveStatus
            isPending={save.isPending || deleteBlock.isPending}
            isError={save.isError || deleteBlock.isError}
          />
        </div>
      </div>

      <div className="min-w-0 flex-1 space-y-3 overflow-y-auto px-8 pb-6">
        {pillars.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("sandbox.pillars.empty")}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {pillars.map((pillar) => (
              <PillarRow
                key={pillar.key}
                blockKey={pillar.key}
                block={decofile[pillar.key] as Record<string, unknown>}
                open={openKey === pillar.key}
                onToggle={() =>
                  setOpenKey((open) =>
                    open === pillar.key ? null : pillar.key,
                  )
                }
                onRemove={() => {
                  deleteBlock.mutate({ blockKey: pillar.key });
                  setOpenKey((open) => (open === pillar.key ? null : open));
                }}
                onSave={(data) => save.mutate({ blockKey: pillar.key, data })}
              />
            ))}
          </ul>
        )}
        <AddButton label={t("sandbox.pillars.add")} onClick={addPillar} />
      </div>
    </div>
  );
}

/** One pillar, collapsed to its title until clicked. Owns its own draft. */
function PillarRow({
  blockKey,
  block,
  open,
  onToggle,
  onRemove,
  onSave,
}: {
  blockKey: string;
  block: Record<string, unknown>;
  open: boolean;
  onToggle: () => void;
  onRemove: () => void;
  onSave: (data: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useAutosave(block, onSave);
  const title = str(draft.title);

  return (
    <li className="group/item bg-card">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={onToggle}
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
          <span className={cn("truncate", !title && "text-muted-foreground")}>
            {title || t("sandbox.pillars.untitled")}
          </span>
        </button>
        <RemoveButton label={t("sandbox.pillars.remove")} onClick={onRemove} />
      </div>
      {open && (
        <div className="space-y-3 border-t bg-background px-3 py-3">
          <Input
            value={title}
            placeholder={t("sandbox.pillars.namePlaceholder")}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="h-9 font-medium"
          />
          <MarkdownEditor
            key={blockKey}
            defaultValue={str(draft.body)}
            placeholder={t("sandbox.pillars.bodyPlaceholder")}
            attachments={false}
            onChange={(markdown) => setDraft({ ...draft, body: markdown })}
          />
        </div>
      )}
    </li>
  );
}

/**
 * Master-detail for a blog reference collection (authors / categories): a list
 * on the left with add/remove, the existing editor on the right. Lets Authors
 * and Categories live inside Context instead of their own sidebar rows.
 */
function EntityPanel({
  kind,
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  hint,
  addLabel,
  emptyLabel,
  renderEditor,
}: {
  kind: BlogKind;
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  hint: string;
  addLabel: string;
  emptyLabel: string;
  renderEditor: (key: string) => React.ReactNode;
}) {
  const t = useT();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const del = useDeleteBlock({ orgSlug, virtualMcpId, branch });
  const [openKey, setOpenKey] = useState<string | null>(null);
  const entries = scanBlogEntries(decofile)[kind];

  const add = () => {
    const key = generateBlogKey(decofile, kind);
    save.mutate({
      blockKey: key,
      data: buildBlogBlock(key, kind, emptyBlogPayload(kind)),
    });
    setOpenKey(key);
  };

  return (
    <div className="min-w-0 max-w-3xl space-y-3 px-8 py-6">
      <p className="text-xs text-muted-foreground">{hint}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {entries.map((entry) => {
            const open = openKey === entry.key;
            return (
              <li key={entry.key} className="group/item bg-card">
                <div className="flex items-center gap-1 pr-2">
                  <button
                    type="button"
                    onClick={() => setOpenKey(open ? null : entry.key)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors hover:bg-muted/50"
                  >
                    {open ? (
                      <ChevronDown size={14} className="shrink-0" />
                    ) : (
                      <ChevronRight
                        size={14}
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="truncate">{entry.label}</span>
                    {entry.subtitle && (
                      <span className="truncate text-xs text-muted-foreground">
                        {entry.subtitle}
                      </span>
                    )}
                  </button>
                  <RemoveButton
                    label={t("sandbox.blogContext.removeEntry")}
                    onClick={() => {
                      del.mutate({ blockKey: entry.key });
                      if (open) setOpenKey(null);
                    }}
                  />
                </div>
                {open && (
                  <div className="border-t bg-background px-4 py-4">
                    {renderEditor(entry.key)}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <AddButton label={addLabel} onClick={add} />
    </div>
  );
}
