import { useState } from "react";
import { Loading02, Stars02 } from "@untitledui/icons";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import {
  type AuthorRef,
  BRAND_BLOCK_KEY,
  type BrandRequirement,
  type CategoryRef,
  FORMATS_BLOCK_KEY,
  filledBrandRules,
  listBlogPayloads,
  missingBrandForGeneration,
  normalizeBrandRules,
  scanIdeas,
  scanPillars,
} from "./blog-data";
import { PickList, str } from "./blocks/primitives";
import type { PostBriefing } from "./use-generate-post";

const STEPS = [
  { id: "idea", label: "sandbox.generatePost.stepIdea" },
  { id: "format", label: "sandbox.generatePost.stepFormat" },
  { id: "extra", label: "sandbox.generatePost.stepExtra" },
] as const satisfies ReadonlyArray<{ id: string; label: TranslationKey }>;

type StepId = (typeof STEPS)[number]["id"];

/** An idea from the tray, opened straight into the wizard. */
export interface IdeaSeed {
  key: string;
  title: string;
  body: string;
}

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

interface Suggestion {
  title: string;
  body: string;
}

/**
 * The generation happy path: which idea, in what shape, with what details.
 *
 * There is no pillar step — the idea carries its own pillar, and asking twice
 * would let the two disagree. Given a `seed` the idea is settled and the wizard
 * opens on the format.
 *
 * Category and author are the one place where leaving a field empty is itself a
 * choice: the model then files and attributes the post.
 */
export function GeneratePostDialog({
  open,
  onOpenChange,
  decofile,
  hasAi,
  seed,
  onGenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  decofile: Record<string, unknown>;
  hasAi: boolean;
  /** Writing from an idea already on the board, rather than from scratch. */
  seed?: IdeaSeed;
  onGenerate: (briefing: PostBriefing) => void;
}) {
  const t = useT();
  const studio = useStudioTools();

  const [step, setStep] = useState<StepId>(seed ? "format" : "idea");
  const [ideaKey, setIdeaKey] = useState(seed?.key ?? "");
  const [ideaTitle, setIdeaTitle] = useState(seed?.title ?? "");
  const [ideaBody, setIdeaBody] = useState(seed?.body ?? "");
  const [ideaSuggestions, setIdeaSuggestions] = useState<Suggestion[]>([]);
  const [formatName, setFormatName] = useState("");
  const [formatValue, setFormatValue] = useState("");
  const [categorySlug, setCategorySlug] = useState("");
  const [authorEmail, setAuthorEmail] = useState("");
  const [extra, setExtra] = useState("");
  const [suggesting, setSuggesting] = useState(false);

  const brandBlock = decofile[BRAND_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const missingBrand = missingBrandForGeneration(brandBlock);
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

  const ideas = scanIdeas(decofile);
  const pickedIdea = ideas.find((entry) => entry.key === ideaKey);
  /** The pillar is the idea's — asking for it again would let the two disagree. */
  const pillar = scanPillars(decofile).find(
    (entry) => entry.key === pickedIdea?.pillarKey,
  );
  const formatsBlock = decofile[FORMATS_BLOCK_KEY] as
    | Record<string, unknown>
    | undefined;
  const formats = filledBrandRules(normalizeBrandRules(formatsBlock?.formats));
  const categories: CategoryRef[] = listBlogPayloads(decofile, "categories")
    .map(({ payload }) => ({
      name: str(payload.name),
      slug: str(payload.slug),
    }))
    .filter((category) => category.slug);
  const authors: AuthorRef[] = listBlogPayloads(decofile, "authors")
    .map(({ payload }) => ({
      name: str(payload.name),
      email: str(payload.email),
    }))
    .filter((author) => author.email);

  const reset = () => {
    setStep(seed ? "format" : "idea");
    setIdeaKey(seed?.key ?? "");
    setIdeaTitle(seed?.title ?? "");
    setIdeaBody(seed?.body ?? "");
    setIdeaSuggestions([]);
    setFormatName("");
    setFormatValue("");
    setCategorySlug("");
    setAuthorEmail("");
    setExtra("");
  };

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) reset();
  };

  const suggestIdeas = async () => {
    setSuggesting(true);
    try {
      const result = await studio.call("BLOG_THEME_SUGGEST", {
        brand: brandForTools,
        existingTitles: [],
        formats: formats.map((f) => f.name).filter(Boolean),
        guidance: pillar
          ? `Every idea must be one angle inside the pillar "${pillar.title}": ${pillar.body}`
          : undefined,
        count: 4,
      });
      setIdeaSuggestions(result.themes);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("sandbox.generatePost.suggestFailed"),
      );
    } finally {
      setSuggesting(false);
    }
  };

  // Seeded, the pillar and the angle are settled — only the shape is still open.
  const steps = seed ? STEPS.filter((entry) => entry.id !== "idea") : STEPS;
  const stepIndex = steps.findIndex((entry) => entry.id === step);
  const canAdvance =
    step === "idea"
      ? ideaTitle.trim().length > 0
      : step === "format"
        ? formatName.trim().length > 0 && formatValue.trim().length > 0
        : true;
  const isLast = step === "extra";

  const submit = () => {
    onGenerate({
      idea: {
        key: ideaKey || undefined,
        title: ideaTitle.trim(),
        body: ideaBody.trim(),
      },
      pillar: pillar
        ? { key: pillar.key, title: pillar.title, body: pillar.body }
        : undefined,
      format: { name: formatName.trim(), value: formatValue.trim() },
      category: categories.find((c) => c.slug === categorySlug),
      author: authors.find((a) => a.email === authorEmail),
      extraInstructions: extra.trim() || undefined,
    });
    close(false);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("sandbox.generatePost.title")}</DialogTitle>
          <DialogDescription>
            {t("sandbox.generatePost.subtitle")}
          </DialogDescription>
        </DialogHeader>

        {missingBrand.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("sandbox.generatePost.blockedBrand", {
              fields: missingBrand
                .map((f) => t(REQUIREMENT_LABEL[f]))
                .join(", "),
            })}
          </p>
        ) : (
          <>
            <ol className="flex shrink-0 items-center gap-1.5 text-xs">
              {steps.map((entry, index) => (
                <li
                  key={entry.id}
                  className={cn(
                    "rounded-md px-2 py-1",
                    index === stepIndex
                      ? "bg-primary text-primary-foreground"
                      : index < stepIndex
                        ? "text-foreground"
                        : "text-muted-foreground",
                  )}
                >
                  {t(entry.label)}
                </li>
              ))}
            </ol>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-1">
              {step === "idea" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {pillar
                      ? t("sandbox.generatePost.ideaHintInPillar", {
                          pillar: pillar.title,
                        })
                      : t("sandbox.generatePost.ideaHint")}
                  </p>
                  {ideas.length > 0 && (
                    <PickList
                      options={ideas.map((idea) => idea.title).filter(Boolean)}
                      value={pickedIdea?.title ?? ""}
                      emptyLabel={t("sandbox.generatePost.writeAnIdea")}
                      onChange={(title) => {
                        const picked = ideas.find(
                          (idea) => idea.title === title,
                        );
                        setIdeaKey(picked?.key ?? "");
                        setIdeaTitle(picked?.title ?? "");
                        setIdeaBody(picked?.body ?? "");
                      }}
                    />
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="generate-idea-title">
                      {t("sandbox.generatePost.ideaTitleLabel")}
                    </Label>
                    <Input
                      id="generate-idea-title"
                      value={ideaTitle}
                      onChange={(e) => {
                        setIdeaKey("");
                        setIdeaTitle(e.target.value);
                      }}
                      placeholder={t(
                        "sandbox.generatePost.ideaTitlePlaceholder",
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="generate-idea-body">
                      {t("sandbox.generatePost.ideaBodyLabel")}
                    </Label>
                    <Textarea
                      id="generate-idea-body"
                      value={ideaBody}
                      onChange={(e) => setIdeaBody(e.target.value)}
                      placeholder={t(
                        "sandbox.generatePost.ideaBodyPlaceholder",
                      )}
                      rows={3}
                    />
                  </div>
                  <SuggestButton
                    label={t("sandbox.generatePost.suggestIdeas")}
                    hint={t("sandbox.generatePost.suggestIdeasHint")}
                    disabled={!hasAi || suggesting}
                    busy={suggesting}
                    onSuggest={suggestIdeas}
                  />
                  <SuggestionCards
                    suggestions={ideaSuggestions}
                    onPick={(pick) => {
                      setIdeaTitle(pick.title);
                      setIdeaBody(pick.body);
                    }}
                  />
                </>
              )}

              {step === "format" && (
                <>
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.generatePost.formatHint")}
                  </p>
                  <PickList
                    options={formats.map((f) => f.name)}
                    value={formatName}
                    onChange={(name) => {
                      setFormatName(name);
                      setFormatValue(
                        formats.find((f) => f.name === name)?.value ?? "",
                      );
                    }}
                  />
                  <div className="space-y-2">
                    <Label htmlFor="generate-format-name">
                      {t("sandbox.generatePost.formatNameLabel")}
                    </Label>
                    <Input
                      id="generate-format-name"
                      value={formatName}
                      onChange={(e) => setFormatName(e.target.value)}
                      placeholder={t(
                        "sandbox.generatePost.formatNamePlaceholder",
                      )}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="generate-format-value">
                      {t("sandbox.generatePost.formatValueLabel")}
                    </Label>
                    <Textarea
                      id="generate-format-value"
                      value={formatValue}
                      onChange={(e) => setFormatValue(e.target.value)}
                      placeholder={t(
                        "sandbox.generatePost.formatValuePlaceholder",
                      )}
                      rows={4}
                    />
                  </div>
                </>
              )}

              {step === "extra" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="generate-category">
                      {t("sandbox.generatePost.categoryLabel")}
                    </Label>
                    <PickList
                      options={categories.map((c) => c.name)}
                      value={
                        categories.find((c) => c.slug === categorySlug)?.name ??
                        ""
                      }
                      emptyLabel={t("sandbox.generatePost.inferIt")}
                      onChange={(name) =>
                        setCategorySlug(
                          categories.find((c) => c.name === name)?.slug ?? "",
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="generate-author">
                      {t("sandbox.generatePost.authorLabel")}
                    </Label>
                    <PickList
                      options={authors.map((a) => a.name)}
                      value={
                        authors.find((a) => a.email === authorEmail)?.name ?? ""
                      }
                      emptyLabel={t("sandbox.generatePost.inferIt")}
                      onChange={(name) =>
                        setAuthorEmail(
                          authors.find((a) => a.name === name)?.email ?? "",
                        )
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="generate-extra">
                      {t("sandbox.generatePost.extraLabel")}
                    </Label>
                    <Textarea
                      id="generate-extra"
                      value={extra}
                      onChange={(e) => setExtra(e.target.value)}
                      placeholder={t("sandbox.generatePost.extraPlaceholder")}
                      rows={3}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.generatePost.inferHint")}
                  </p>
                </>
              )}
            </div>

            <DialogFooter className="shrink-0 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                disabled={stepIndex === 0}
                onClick={() => setStep(steps[stepIndex - 1]!.id)}
              >
                {t("sandbox.generatePost.back")}
              </Button>
              {isLast ? (
                <Button type="button" disabled={!hasAi} onClick={submit}>
                  <Stars02 size={14} />
                  {t("sandbox.generatePost.generate")}
                </Button>
              ) : (
                <Button
                  type="button"
                  disabled={!canAdvance}
                  onClick={() => setStep(steps[stepIndex + 1]!.id)}
                >
                  {t("sandbox.generatePost.next")}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The "ask the model" row: what it will do, and the button that does it. */
function SuggestButton({
  label,
  hint,
  disabled,
  busy,
  onSuggest,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  busy: boolean;
  onSuggest: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t pt-3">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onSuggest}
      >
        {busy ? (
          <Loading02 size={14} className="animate-spin" />
        ) : (
          <Stars02 size={14} />
        )}
        {label}
      </Button>
    </div>
  );
}

/** Suggested ideas, as cards — picking one fills the fields above. */
function SuggestionCards({
  suggestions,
  onPick,
}: {
  suggestions: Suggestion[];
  onPick: (suggestion: Suggestion) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {suggestions.map((suggestion) => (
        <li key={suggestion.title}>
          <button
            type="button"
            onClick={() => onPick(suggestion)}
            className="w-full cursor-pointer rounded-lg border bg-card p-2.5 text-left transition-colors hover:border-primary/40"
          >
            <p className="text-sm font-medium">{suggestion.title}</p>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {suggestion.body}
            </p>
          </button>
        </li>
      ))}
    </ul>
  );
}
