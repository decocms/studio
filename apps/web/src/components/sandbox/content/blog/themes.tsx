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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { useHostedAiProviderKeys } from "@/hooks/collections/use-ai-providers";
import { MarkdownEditor } from "@/components/markdown-editor";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { useDeleteBlock } from "@/components/sections-editor/use-delete-block";
import { useAutosave } from "./use-autosave";
import { SaveStatus } from "./save-status";
import {
  BRAND_BLOCK_KEY,
  dedupeSuggestedThemes,
  listPostsWithMeta,
  newThemeKey,
  filledBrandRules,
  normalizeBrandRules,
  scanBlogEntries,
  scanThemes,
} from "./blog-data";
import { AddButton, RemoveButton, str } from "./blocks/primitives";

/** Steps the suggestion goes through, in order. See `phase` below. */
type SuggestPhase = Extract<TranslationKey, `sandbox.themes.phase${string}`>;
const PHASE_READING = "sandbox.themes.phaseReading" satisfies SuggestPhase;

/**
 * The brand block as the tool's input: coerced field by field, because the block
 * is whatever was last written to it — and `normalizeBrandRules` also carries
 * the legacy `string[]` rule lists, which the tool's schema would reject.
 */
function brandInput(block: Record<string, unknown> | undefined) {
  const brand = block ?? {};
  return {
    companyName: str(brand.companyName),
    description: str(brand.description),
    language: str(brand.language),
    tone: str(brand.tone),
    targetAudience: str(brand.targetAudience),
    values: filledBrandRules(normalizeBrandRules(brand.values)),
    dos: filledBrandRules(normalizeBrandRules(brand.dos)),
    avoid: filledBrandRules(normalizeBrandRules(brand.avoid)),
    competitors: filledBrandRules(normalizeBrandRules(brand.competitors)),
    categories: Array.isArray(brand.categories)
      ? brand.categories.filter((c): c is string => typeof c === "string")
      : [],
  };
}

/**
 * The editorial queue: a theme is a title plus a markdown brief, and later the
 * input to a generated draft. One block per theme under `blog-manager/themes/`,
 * so appending five suggestions can't clobber the one being edited.
 */
export function ThemesScreen({
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
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });
  const deleteBlock = useDeleteBlock({ orgSlug, virtualMcpId, branch });

  /** Every suggestion spends org credits, so none of this works without a provider. */
  const hasAi = useHostedAiProviderKeys().length > 0;

  const [openKey, setOpenKey] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [askOpen, setAskOpen] = useState(false);
  const [isSuggesting, setIsSuggesting] = useState(false);
  /**
   * Advanced on a timer, not by the server: the tool is one round trip, so
   * these are its known phases timed against how long each usually takes. Never
   * a real progress report, so the copy stays qualitative.
   */
  const [phase, setPhase] = useState<SuggestPhase>(PHASE_READING);

  const themes = scanThemes(decofile);
  const brand = brandInput(
    decofile[BRAND_BLOCK_KEY] as Record<string, unknown> | undefined,
  );
  const hasBrand = Boolean(brand.companyName || brand.description);

  const addTheme = () => {
    const blockKey = newThemeKey();
    save.mutate({
      blockKey,
      data: { title: "", body: "", createdAt: new Date().toISOString() },
    });
    setOpenKey(blockKey);
  };

  /** Propose themes from the brand context, the blog so far and the guidance. */
  const suggest = async () => {
    setIsSuggesting(true);
    setPhase(PHASE_READING);
    const timers = [
      setTimeout(() => setPhase("sandbox.themes.phaseResearching"), 2_000),
      setTimeout(() => setPhase("sandbox.themes.phaseWriting"), 18_000),
    ];
    try {
      const posts = listPostsWithMeta(decofile);
      const result = await studio.call("BLOG_THEME_SUGGEST", {
        brand,
        // A theme already queued is as covered as a post already written.
        existingTitles: [
          ...posts.map((post) => post.title),
          ...themes.map((theme) => theme.title),
        ].filter(Boolean),
        categories: scanBlogEntries(decofile).categories.map((c) => c.label),
        guidance: guidance.trim() || undefined,
      });

      const fresh = dedupeSuggestedThemes(
        themes.map((theme) => theme.title),
        result.themes,
      );
      if (fresh.length === 0) {
        toast.info(t("sandbox.themes.noNewThemes"));
        return;
      }

      const now = Date.now();
      let created = 0;
      /**
       * One at a time, not a burst of concurrent writes: in fast-preview mode
       * each write replaces the whole decofile cache with the snapshot the
       * server returned, so parallel writes race and the loser's theme
       * disappears from the list until the next refetch.
       */
      for (const [index, theme] of fresh.entries()) {
        try {
          await save.mutateAsync({
            blockKey: newThemeKey(),
            // Stagger the timestamps so the list keeps the model's ranking.
            data: {
              title: theme.title,
              body: theme.body,
              createdAt: new Date(now - index).toISOString(),
            },
          });
          created++;
        } catch (err) {
          console.warn("[themes] could not save a suggested theme", err);
        }
      }

      if (created === 0) {
        toast.error(t("sandbox.themes.suggestFailed"));
        return;
      }
      // The count is what actually landed, so a partial failure reads honestly.
      toast.success(t("sandbox.themes.suggested", { count: String(created) }));
      if (!result.searched) toast.info(t("sandbox.themes.noResearch"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.themes.suggestFailed"),
      );
    } finally {
      for (const timer of timers) clearTimeout(timer);
      setIsSuggesting(false);
    }
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-start justify-between gap-4 px-8 pt-6">
        <div>
          <h2 className="text-lg font-semibold">{t("sandbox.themes.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("sandbox.themes.subtitle")}
          </p>
        </div>
        <SaveStatus
          isPending={save.isPending || deleteBlock.isPending}
          isError={save.isError || deleteBlock.isError}
        />
      </div>

      <div className="flex items-center justify-end gap-3 border-b px-8 py-4">
        {isSuggesting && (
          <span
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
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
                    ? t("sandbox.themes.suggestHint")
                    : t("sandbox.themes.suggestNoBrand")
              }
            >
              <Stars02 size={14} />
              {t("sandbox.themes.suggest")}
            </Button>
          </PopoverTrigger>
          {/* The guidance only matters at the moment you ask, and as a
              standalone field above the list it read as a search box. */}
          <PopoverContent align="end" className="w-80 space-y-3">
            <div className="space-y-1">
              <Label htmlFor="theme-guidance">
                {t("sandbox.themes.guidanceLabel")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("sandbox.themes.guidanceHint")}
              </p>
            </div>
            <Input
              id="theme-guidance"
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              placeholder={t("sandbox.themes.guidancePlaceholder")}
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
              {t("sandbox.themes.suggest")}
            </Button>
          </PopoverContent>
        </Popover>
      </div>

      <div className="min-w-0 flex-1 space-y-3 overflow-y-auto px-8 py-6">
        {themes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("sandbox.themes.empty")}
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {themes.map((theme) => (
              <ThemeRow
                key={theme.key}
                blockKey={theme.key}
                block={decofile[theme.key] as Record<string, unknown>}
                open={openKey === theme.key}
                onToggle={() =>
                  setOpenKey((open) => (open === theme.key ? null : theme.key))
                }
                onRemove={() => {
                  deleteBlock.mutate({ blockKey: theme.key });
                  setOpenKey((open) => (open === theme.key ? null : open));
                }}
                onSave={(data) => save.mutate({ blockKey: theme.key, data })}
              />
            ))}
          </ul>
        )}
        <AddButton label={t("sandbox.themes.add")} onClick={addTheme} />
      </div>
    </div>
  );
}

/**
 * One theme, collapsed to its title until clicked.
 *
 * The row owns its draft rather than the screen holding one for whichever theme
 * is open: a single shared draft would let a save still in flight land on the
 * block of the theme selected next, because the save callback reads the open key
 * when it fires, not when the edit happened. Per-row, each callback closes over
 * its own key by construction.
 */
function ThemeRow({
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
            {title || t("sandbox.themes.untitled")}
          </span>
        </button>
        <RemoveButton label={t("sandbox.themes.remove")} onClick={onRemove} />
      </div>
      {open && (
        <div className="space-y-3 border-t bg-background px-3 py-3">
          <Input
            value={title}
            placeholder={t("sandbox.themes.namePlaceholder")}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="h-9 font-medium"
          />
          <MarkdownEditor
            key={blockKey}
            defaultValue={str(draft.body)}
            placeholder={t("sandbox.themes.bodyPlaceholder")}
            attachments={false}
            onChange={(markdown) => setDraft({ ...draft, body: markdown })}
          />
        </div>
      )}
    </li>
  );
}
