/**
 * "Suggest links" — the review-first internal-linking enrichment. Runs
 * BLOG_LINK_SUGGEST over the post body against the site's other posts, resolves
 * each suggestion to a real post + on-site path (dropping anything invented or
 * not found verbatim), and lets the user accept the ones to apply. The model
 * proposes; the human curates; nothing is written to the post until Apply.
 */
import { useState } from "react";
import { Check, Link01, Loading02 } from "@untitledui/icons";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { applyBlogPageSlug, findBlogPageSlug } from "./blog-preview-url";
import { listPostsWithMeta } from "./blog-data";
import { applyLinksToBlocks, postBodyText } from "./link-enrich";

interface ResolvedSuggestion {
  quote: string;
  href: string;
  title: string;
}

export function SuggestLinksButton({
  decofile,
  sections,
  currentKey,
  hasAi,
  onApply,
}: {
  decofile: Record<string, unknown>;
  sections: Array<Record<string, unknown>>;
  /** The post being edited — excluded from its own link targets. */
  currentKey: string;
  hasAi: boolean;
  onApply: (nextSections: Array<Record<string, unknown>>) => void;
}) {
  const t = useT();
  const studio = useStudioTools();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ResolvedSuggestion[]>([]);
  const [accepted, setAccepted] = useState<Set<number>>(new Set());

  const template = findBlogPageSlug(decofile);
  const candidates = listPostsWithMeta(decofile).filter(
    (p) => p.key !== currentKey && p.slug,
  );

  const run = async () => {
    setLoading(true);
    try {
      const body = postBodyText(sections);
      const result = await studio.call("BLOG_LINK_SUGGEST", {
        body,
        posts: candidates.map((p) => ({ title: p.title, slug: p.slug })),
      });

      const resolved: ResolvedSuggestion[] = [];
      const seen = new Set<string>();
      for (const s of result.suggestions) {
        const post = candidates.find((p) => p.slug === s.slug);
        if (!post || !template) continue;
        const href = applyBlogPageSlug(template, {
          category: post.categorySlugs[0] ?? "",
          slug: post.slug,
        });
        if (!href) continue;
        if (!body.includes(s.quote)) continue;
        const key = `${s.quote}→${post.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ quote: s.quote, href, title: post.title });
      }

      setItems(resolved);
      setAccepted(new Set(resolved.map((_, i) => i)));
      setOpen(true);
      if (resolved.length === 0) toast.info(t("sandbox.linkSuggest.none"));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("sandbox.linkSuggest.failed"),
      );
    } finally {
      setLoading(false);
    }
  };

  const toggle = (index: number) =>
    setAccepted((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const apply = () => {
    const links = items
      .filter((_, i) => accepted.has(i))
      .map((x) => ({ quote: x.quote, href: x.href }));
    const { blocks, applied } = applyLinksToBlocks(sections, links);
    onApply(blocks);
    setOpen(false);
    toast.success(t("sandbox.linkSuggest.applied", { count: String(applied) }));
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading || !hasAi || candidates.length === 0}
        title={
          !hasAi
            ? t("sandbox.autonomous.noAiProvider")
            : candidates.length === 0
              ? t("sandbox.linkSuggest.noCandidates")
              : t("sandbox.linkSuggest.hint")
        }
        onClick={() => void run()}
      >
        {loading ? (
          <Loading02 size={14} className="animate-spin" />
        ) : (
          <Link01 size={14} />
        )}
        {t("sandbox.linkSuggest.button")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("sandbox.linkSuggest.title")}</DialogTitle>
            <DialogDescription>
              {t("sandbox.linkSuggest.description")}
            </DialogDescription>
          </DialogHeader>
          {items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t("sandbox.linkSuggest.none")}
            </p>
          ) : (
            <ul className="max-h-[50vh] space-y-1 overflow-y-auto">
              {items.map((item, index) => {
                const on = accepted.has(index);
                return (
                  <li key={`${item.quote}-${item.href}`}>
                    <button
                      type="button"
                      onClick={() => toggle(index)}
                      className="flex w-full items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors hover:bg-muted/50"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          on
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-input",
                        )}
                      >
                        {on && <Check size={11} />}
                      </span>
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="font-medium">“{item.quote}”</span>
                        <span className="text-muted-foreground">
                          {" → "}
                          {item.title}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <DialogFooter>
            <Button
              type="button"
              disabled={accepted.size === 0}
              onClick={apply}
            >
              {t("sandbox.linkSuggest.apply", { count: String(accepted.size) })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
