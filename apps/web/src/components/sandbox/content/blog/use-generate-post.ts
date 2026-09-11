import { toast } from "sonner";
import { useT } from "@/i18n/use-t.ts";
import { useStudioTools } from "@/lib/studio-tools";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import {
  type AuthorRef,
  BRAND_BLOCK_KEY,
  buildGeneratedPostPayload,
  buildPlanningPostBlock,
  type CategoryRef,
  emptyDraftPostPayload,
  filledBrandRules,
  listBlogPayloads,
  listPostsWithMeta,
  mentionableSections,
  newPostId,
  normalizeBrandRules,
  type PlanningMeta,
  planningPostKey,
  sectionResolveTypes,
  setPostStatus,
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

/** Everything the wizard collected — what one post gets written from. */
export interface PostBriefing {
  idea: { key?: string; title: string; body: string };
  /** The territory the idea sits in — steers the writing, and labels the card. */
  pillar?: { key?: string; title: string; body: string };
  format: { name: string; value: string };
  /** Left empty to let the model file the post itself. */
  category?: CategoryRef;
  /** Left empty to let the model attribute the post itself. */
  author?: AuthorRef;
  extraInstructions?: string;
}

interface UseGeneratePostParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  /** The placeholder card just landed on the board under this key. */
  onStarted?: (key: string) => void;
}

/**
 * Write one post from a briefing, in the background.
 *
 * The card is created first and sits in Generating, so the board shows the
 * work in flight rather than nothing at all; the draft is then written onto
 * that same planning key and the card moves itself to Awaiting review. A
 * failure drops it back to Draft with the briefing intact, so the operator can
 * retry from what they already filled in instead of starting over.
 *
 * A picked category or author is handed over as the tool's only option, so the
 * model confirms the operator's choice rather than second-guessing it; leaving
 * either empty passes the whole list and lets the model choose.
 *
 * Resolves when the post is written. Callers fire and forget: the dialog that
 * started it is closed by then.
 */
export function useGeneratePost({
  orgSlug,
  virtualMcpId,
  branch,
  decofile,
  meta,
  onStarted,
}: UseGeneratePostParams) {
  const t = useT();
  const studio = useStudioTools();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });

  return async (briefing: PostBriefing) => {
    const key = planningPostKey(newPostId());
    const planning: PlanningMeta = {
      ideaKey: briefing.idea.key,
      pillarKey: briefing.pillar?.key,
      pillarTitle: briefing.pillar?.title,
      format: briefing.format,
      brief: briefing.idea.body,
    };
    const placeholder = setPostStatus(
      emptyDraftPostPayload({
        title: briefing.idea.title,
        planning,
        now: new Date(),
      }),
      "generating",
      new Date(),
    );
    await save.mutateAsync({
      blockKey: key,
      data: buildPlanningPostBlock(key, placeholder),
    });
    onStarted?.(key);

    const brandBlock = decofile[BRAND_BLOCK_KEY] as
      | Record<string, unknown>
      | undefined;
    const categories: CategoryRef[] = briefing.category
      ? [briefing.category]
      : listBlogPayloads(decofile, "categories")
          .map(({ payload }) => ({
            name: str(payload.name),
            slug: str(payload.slug),
          }))
          .filter((category) => category.slug);
    const authors: AuthorRef[] = briefing.author
      ? [briefing.author]
      : listBlogPayloads(decofile, "authors")
          .map(({ payload }) => ({
            name: str(payload.name),
            email: str(payload.email),
          }))
          .filter((author) => author.email);

    try {
      const draft = await studio.call("BLOG_POST_DRAFT", {
        brand: {
          companyName: str(brandBlock?.companyName),
          description: str(brandBlock?.description),
          language: str(brandBlock?.language),
          tone: str(brandBlock?.tone),
          targetAudience: str(brandBlock?.targetAudience),
          values: filledBrandRules(normalizeBrandRules(brandBlock?.values)),
          dos: filledBrandRules(normalizeBrandRules(brandBlock?.dos)),
          avoid: filledBrandRules(normalizeBrandRules(brandBlock?.avoid)),
        },
        pillar: briefing.pillar
          ? { title: briefing.pillar.title, body: briefing.pillar.body }
          : undefined,
        theme: { title: briefing.idea.title, body: briefing.idea.body },
        format: briefing.format,
        sections: mentionableSections(meta)
          .filter((section) => isGeneratable(section.name))
          .map((section) => ({
            type: section.name as GeneratableSection,
            purpose: section.description,
          })),
        categories,
        authors,
        extraInstructions: briefing.extraInstructions?.trim() || undefined,
      });

      const payload = buildGeneratedPostPayload({
        draft,
        resolveTypes: sectionResolveTypes(meta),
        categories,
        authors,
        planning,
        takenSlugs: listPostsWithMeta(decofile).map((post) => post.slug),
        now: new Date(),
      });
      await save.mutateAsync({
        blockKey: key,
        data: buildPlanningPostBlock(key, payload),
      });
      toast.success(t("sandbox.generatePost.done", { title: draft.title }));
    } catch (err) {
      // Back to Draft, briefing intact: a card stuck in Generating would lie.
      await save.mutateAsync({
        blockKey: key,
        data: buildPlanningPostBlock(
          key,
          setPostStatus(placeholder, "draft", new Date()),
        ),
      });
      toast.error(
        err instanceof Error ? err.message : t("sandbox.generatePost.failed"),
      );
    }
  };
}
