import { useState } from "react";
import { ArrowLeft, Loading02, Stars02 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { MarkdownEditor } from "@/components/markdown-editor";
import { StringField } from "@/components/sections-editor/fields/string-field";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  BRAND_BLOCK_KEY,
  type BrandRequirement,
  buildBlogBlock,
  buildGeneratedPostPayload,
  type CategoryRef,
  defaultScheduledDatetime,
  FORMATS_BLOCK_KEY,
  filledBrandRules,
  generateBlogKey,
  listBlogPayloads,
  listPostsWithMeta,
  mentionableSections,
  missingBrandForGeneration,
  newThemeKey,
  normalizeBrandRules,
  postStructures,
  scanBlogEntries,
  scanThemes,
  sectionResolveTypes,
} from "./blog-data";
import { str } from "./blocks/primitives";

/**
 * Section kinds the draft tool knows how to write. A site may expose more — a
 * product shelf, an image — but those need data no model can invent, so they
 * stay out of generation and a human adds them on review.
 */
const GENERATABLE = [
  "Heading",
  "Paragraph",
  "List",
  "Quote",
  "Callout",
  "Cta",
  "Divider",
] as const;

type GeneratableSection = (typeof GENERATABLE)[number];

function isGeneratable(name: string): name is GeneratableSection {
  return (GENERATABLE as readonly string[]).includes(name);
}

const STEPS = [
  { id: "theme", label: "sandbox.generate.stepTheme" },
  { id: "format", label: "sandbox.generate.stepFormat" },
  { id: "schedule", label: "sandbox.generate.stepSchedule" },
  { id: "extra", label: "sandbox.generate.stepExtra" },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey }>;

type StepId = (typeof STEPS)[number]["id"];

/** Steps the draft goes through, in order. */
type DraftPhase = Extract<TranslationKey, `sandbox.generate.phase${string}`>;
const PHASE_READING = "sandbox.generate.phaseReading" satisfies DraftPhase;

/** Which brand field each blocking requirement points at, for the message. */
const REQUIREMENT_LABEL = {
  companyName: "sandbox.blogBrand.companyNameLabel",
  language: "sandbox.blogBrand.languageLabel",
  description: "sandbox.blogBrand.descriptionLabel",
  tone: "sandbox.blogBrand.toneLabel",
  targetAudience: "sandbox.blogBrand.audienceLabel",
  dos: "sandbox.blogBrand.tabDos",
  avoid: "sandbox.blogBrand.tabGuardrails",
} as const satisfies Record<BrandRequirement, TranslationKey>;

/**
 * Generation: pick a theme, pick a format, choose when it goes live, add any
 * last instruction. The post lands scheduled, never published — a human still
 * reviews it, and the schedule is what they opted into.
 */
export function GenerateScreen({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
}: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
}) {
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const hasAi = useHostedAiProviderKeys().length > 0;

  const brandBlock = decofile[BRAND_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const missingBrand = missingBrandForGeneration(brandBlock);

  const themes = scanThemes(decofile);
  const formatsBlock = decofile[FORMATS_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const formats = filledBrandRules(normalizeBrandRules(formatsBlock?.formats));

  const resolveTypes = sectionResolveTypes(meta);
  const sections = mentionableSections(meta).filter((section) =>
    isGeneratable(section.name),
  );

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<StepId>("theme");
  const [themeKey, setThemeKey] = useState<string | null>(null);
  const [themeDraft, setThemeDraft] = useState({ title: "", body: "" });
  const [formatName, setFormatName] = useState<string | null>(null);
  const [formatDraft, setFormatDraft] = useState({ name: "", value: "" });
  const [scheduledFor, setScheduledFor] = useState(() =>
    defaultScheduledDatetime(new Date()),
  );
  const [extra, setExtra] = useState("");
  const [isDrafting, setIsDrafting] = useState(false);
  const [suggesting, setSuggesting] = useState<StepId | null>(null);
  /** Bumped to remount an editor the suggestion just filled. */
  const [revision, setRevision] = useState(0);
  const [phase, setPhase] = useState<DraftPhase>(PHASE_READING);

  const brandForTools = {
    companyName: str(brandBlock?.companyName),
    description: str(brandBlock?.description),
    language: str(brandBlock?.language),
    tone: str(brandBlock?.tone),
    targetAudience: str(brandBlock?.targetAudience),
    values: filledBrandRules(normalizeBrandRules(brandBlock?.values)),
    dos: filledBrandRules(normalizeBrandRules(brandBlock?.dos)),
    avoid: filledBrandRules(normalizeBrandRules(brandBlock?.avoid)),
  };

  /** Whichever theme the wizard will hand the tool — picked, or written here. */
  const theme =
    themes.find((entry) => entry.key === themeKey) ??
    (themeDraft.title.trim() ? themeDraft : null);
  const format =
    formats.find((entry) => entry.name === formatName) ??
    (formatDraft.name.trim() ? formatDraft : null);

  const reset = () => {
    setOpen(false);
    setStep("theme");
    setThemeKey(null);
    setThemeDraft({ title: "", body: "" });
    setFormatName(null);
    setFormatDraft({ name: "", value: "" });
    setExtra("");
    setScheduledFor(defaultScheduledDatetime(new Date()));
  };

  /** One theme, straight into the inline draft — the wizard needs exactly one. */
  const suggestTheme = async () => {
    setSuggesting("theme");
    try {
      const result = await studio.call("BLOG_THEME_SUGGEST", {
        brand: brandForTools,
        existingTitles: themes.map((entry) => entry.title).filter(Boolean),
        categories: scanBlogEntries(decofile).categories.map((c) => c.label),
        count: 1,
      });
      const first = result.themes[0];
      if (!first) {
        toast.info(t("sandbox.themes.noNewThemes"));
        return;
      }
      setThemeKey(null);
      setThemeDraft({ title: first.title, body: first.body });
      setRevision((n) => n + 1);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.themes.suggestFailed"),
      );
    } finally {
      setSuggesting(null);
    }
  };

  const suggestFormat = async () => {
    setSuggesting("format");
    try {
      const result = await studio.call("BLOG_FORMAT_SUGGEST", {
        brand: brandForTools,
        sections,
        postStructures: postStructures(decofile).map((post) => ({
          title: post.title,
          sections: post.sections,
        })),
        count: 1,
      });
      const first = result.formats[0];
      if (!first) {
        toast.info(t("sandbox.formats.noNewFormats"));
        return;
      }
      setFormatName(null);
      setFormatDraft({ name: first.name, value: first.value });
      setRevision((n) => n + 1);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.formats.suggestFailed"),
      );
    } finally {
      setSuggesting(null);
    }
  };

  const generate = async () => {
    if (!theme || !format) return;
    const scheduled = new Date(scheduledFor);
    if (Number.isNaN(scheduled.getTime())) {
      toast.error(t("sandbox.generate.badDate"));
      return;
    }
    setIsDrafting(true);
    setPhase(PHASE_READING);
    const timers = [
      setTimeout(() => setPhase("sandbox.generate.phaseWriting"), 4_000),
      setTimeout(() => setPhase("sandbox.generate.phaseFinishing"), 30_000),
    ];
    try {
      const categories: CategoryRef[] = listBlogPayloads(
        decofile,
        "categories",
      ).map(({ payload }) => ({
        name: str(payload.name),
        slug: str(payload.slug),
      }));

      const draft = await studio.call("BLOG_POST_DRAFT", {
        brand: brandForTools,
        theme: { title: theme.title, body: theme.body },
        format: { name: format.name, value: format.value },
        sections: sections
          .filter((section) => isGeneratable(section.name))
          .map((section) => ({
            type: section.name as GeneratableSection,
            purpose: section.description,
          })),
        categories: categories.filter((category) => category.slug),
        extraInstructions: extra.trim() || undefined,
      });

      const payload = buildGeneratedPostPayload({
        draft,
        resolveTypes,
        categories,
        scheduledFor: scheduled,
        takenSlugs: listPostsWithMeta(decofile).map((post) => post.slug),
        now: new Date(),
      });
      const key = generateBlogKey(decofile, "posts");
      await save.mutateAsync({
        blockKey: key,
        data: buildBlogBlock(key, "posts", payload),
      });

      /** Written here, but the same thing the Themes and Library screens hold. */
      if (!themeKey && themeDraft.title.trim()) {
        await save.mutateAsync({
          blockKey: newThemeKey(),
          data: { ...themeDraft, createdAt: new Date().toISOString() },
        });
      }
      if (!formatName && formatDraft.name.trim()) {
        await save.mutateAsync({
          blockKey: FORMATS_BLOCK_KEY,
          data: { ...(formatsBlock ?? {}), formats: [...formats, formatDraft] },
        });
      }

      toast.success(t("sandbox.generate.done", { title: draft.title }));
      reset();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.generate.failed"),
      );
    } finally {
      for (const timer of timers) clearTimeout(timer);
      setIsDrafting(false);
    }
  };

  if (missingBrand.length > 0) {
    return (
      <Blocked
        title={t("sandbox.generate.blockedBrandTitle")}
        description={t("sandbox.generate.blockedBrand")}
        items={missingBrand.map((field) => t(REQUIREMENT_LABEL[field]))}
      />
    );
  }

  if (sections.length === 0) {
    return (
      <Blocked
        title={t("sandbox.generate.blockedSectionsTitle")}
        description={t("sandbox.generate.blockedSections")}
      />
    );
  }

  const canContinue =
    step === "theme"
      ? Boolean(theme)
      : step === "format"
        ? Boolean(format)
        : true;
  const stepIndex = STEPS.findIndex((entry) => entry.id === step);

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-4 border-b px-8 py-6">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {t("sandbox.generate.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("sandbox.generate.subtitle")}
          </p>
        </div>
        {!open && (
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            disabled={!hasAi}
            title={hasAi ? undefined : t("sandbox.autonomous.noAiProvider")}
            onClick={() => setOpen(true)}
          >
            <Stars02 size={14} />
            {t("sandbox.generate.new")}
          </Button>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto px-8 py-6">
        {!open ? (
          <p className="text-sm text-muted-foreground">
            {t("sandbox.generate.idle")}
          </p>
        ) : (
          <div className="max-w-3xl space-y-6">
            <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              {STEPS.map((entry, index) => (
                <li
                  key={entry.id}
                  className={cn(
                    "flex items-center gap-2",
                    index === stepIndex
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <span>
                    {index + 1}. {t(entry.label)}
                  </span>
                  {index < STEPS.length - 1 && (
                    <span className="text-muted-foreground/50">›</span>
                  )}
                </li>
              ))}
            </ol>

            {step === "theme" && (
              <Picker
                label={t("sandbox.generate.pickTheme")}
                emptyHint={t("sandbox.generate.noThemes")}
                options={themes.map((entry) => ({
                  id: entry.key,
                  label: entry.title || t("sandbox.themes.untitled"),
                }))}
                selected={themeKey}
                onSelect={setThemeKey}
                onStartWriting={() => setThemeKey(null)}
                onSuggest={() => void suggestTheme()}
                isSuggesting={suggesting === "theme"}
                writing={
                  <>
                    <Input
                      value={themeDraft.title}
                      placeholder={t("sandbox.themes.namePlaceholder")}
                      onChange={(e) =>
                        setThemeDraft({ ...themeDraft, title: e.target.value })
                      }
                      className="h-9 font-medium"
                    />
                    <MarkdownEditor
                      key={`theme-${revision}`}
                      defaultValue={themeDraft.body}
                      placeholder={t("sandbox.themes.bodyPlaceholder")}
                      attachments={false}
                      onChange={(body) =>
                        setThemeDraft({ ...themeDraft, body })
                      }
                    />
                  </>
                }
              />
            )}

            {step === "format" && (
              <Picker
                label={t("sandbox.generate.pickFormat")}
                emptyHint={t("sandbox.generate.noFormats")}
                options={formats.map((entry) => ({
                  id: entry.name,
                  label: entry.name,
                }))}
                selected={formatName}
                onSelect={setFormatName}
                onStartWriting={() => setFormatName(null)}
                onSuggest={() => void suggestFormat()}
                isSuggesting={suggesting === "format"}
                writing={
                  <>
                    <Input
                      value={formatDraft.name}
                      placeholder={t("sandbox.formats.namePlaceholder")}
                      onChange={(e) =>
                        setFormatDraft({ ...formatDraft, name: e.target.value })
                      }
                      className="h-9 font-medium"
                    />
                    <MarkdownEditor
                      key={`format-${revision}`}
                      defaultValue={formatDraft.value}
                      placeholder={t("sandbox.formats.bodyPlaceholder")}
                      attachments={false}
                      mentions={{
                        items: sections,
                        hint: t("sandbox.formats.mentionHint"),
                        emptyLabel: t("sandbox.formats.mentionEmpty"),
                      }}
                      onChange={(value) =>
                        setFormatDraft({ ...formatDraft, value })
                      }
                    />
                  </>
                }
              />
            )}

            {step === "schedule" && (
              <StringField
                schema={{
                  type: "string",
                  format: "date-time",
                  title: t("sandbox.generate.scheduleLabel"),
                  description: t("sandbox.generate.scheduleHint"),
                }}
                value={scheduledFor}
                onChange={(value) => setScheduledFor(str(value))}
                path="generate-scheduled-for"
                label={t("sandbox.generate.scheduleLabel")}
              />
            )}

            {step === "extra" && (
              <div className="space-y-2">
                <Label htmlFor="generate-extra">
                  {t("sandbox.generate.extraLabel")}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t("sandbox.generate.extraHint")}
                </p>
                <Textarea
                  id="generate-extra"
                  rows={4}
                  value={extra}
                  placeholder={t("sandbox.generate.extraPlaceholder")}
                  onChange={(e) => setExtra(e.target.value)}
                />
              </div>
            )}

            <div className="flex items-center gap-3 border-t pt-4">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isDrafting}
                onClick={() => {
                  if (stepIndex === 0) {
                    reset();
                    return;
                  }
                  setStep(STEPS[stepIndex - 1]!.id);
                }}
              >
                <ArrowLeft size={14} />
                {stepIndex === 0
                  ? t("sandbox.generate.cancel")
                  : t("sandbox.generate.back")}
              </Button>
              {isDrafting && (
                <span
                  className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
                  aria-live="polite"
                  role="status"
                >
                  <Loading02 size={12} className="shrink-0 animate-spin" />
                  <span className="truncate">{t(phase)}</span>
                </span>
              )}
              {step === "extra" ? (
                <Button
                  type="button"
                  size="sm"
                  className="ml-auto"
                  disabled={isDrafting || !theme || !format}
                  onClick={() => void generate()}
                >
                  <Stars02 size={14} />
                  {t("sandbox.generate.run")}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  className="ml-auto"
                  disabled={!canContinue}
                  onClick={() => setStep(STEPS[stepIndex + 1]!.id)}
                >
                  {t("sandbox.generate.next")}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Why generation can't start, and what to go fill in. */
function Blocked({
  title,
  description,
  items,
}: {
  title: string;
  description: string;
  items?: string[];
}) {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="max-w-md space-y-3 text-center">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
        {items && items.length > 0 && (
          <ul className="inline-flex flex-wrap justify-center gap-1.5">
            {items.map((item) => (
              <li
                key={item}
                className="rounded-md border bg-card px-2 py-0.5 text-xs text-muted-foreground"
              >
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Pick one of what already exists, or write one here. With nothing to pick
 * from, the writing surface is all there is — the step still has to be
 * answerable on a site that has neither themes nor formats yet.
 */
function Picker({
  label,
  emptyHint,
  options,
  selected,
  onSelect,
  writing,
  onStartWriting,
  onSuggest,
  isSuggesting,
}: {
  label: string;
  emptyHint: string;
  options: Array<{ id: string; label: string }>;
  selected: string | null;
  onSelect: (id: string) => void;
  writing: React.ReactNode;
  onStartWriting: () => void;
  /** Fills the writing surface from the brand context. */
  onSuggest: () => void;
  isSuggesting: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState<"pick" | "write">(
    options.length > 0 ? "pick" : "write",
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <Label>{label}</Label>
        {options.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              const next = mode === "pick" ? "write" : "pick";
              setMode(next);
              if (next === "write") onStartWriting();
            }}
          >
            {mode === "pick"
              ? t("sandbox.generate.writeInstead")
              : t("sandbox.generate.pickInstead")}
          </Button>
        )}
      </div>

      {mode === "write" && (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSuggesting}
            onClick={onSuggest}
          >
            <Stars02 size={14} />
            {t("sandbox.generate.suggest")}
          </Button>
          {isSuggesting && (
            <span
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              aria-live="polite"
              role="status"
            >
              <Loading02 size={12} className="shrink-0 animate-spin" />
              {t("sandbox.generate.suggesting")}
            </span>
          )}
        </div>
      )}

      {mode === "pick" ? (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {options.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => onSelect(option.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors",
                  selected === option.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/50",
                )}
              >
                <span className="truncate">{option.label}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-3">
          {options.length === 0 && (
            <p className="text-xs text-muted-foreground">{emptyHint}</p>
          )}
          {writing}
        </div>
      )}
    </div>
  );
}
