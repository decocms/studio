import { toast } from "sonner";
import { useT, type TranslationKey } from "@/i18n/use-t.ts";
import { useHideDefaultBlogBlocks } from "@/hooks/use-hide-default-blog-blocks";
import { useStudioTools } from "@/lib/studio-tools";
import { useSaveBlock } from "@/components/sections-editor/use-save-block";
import { type LiveMeta } from "@/components/sections-editor/resolve-schema";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import {
  type AuthorRef,
  blocksForFormat,
  buildGeneratedPostPayload,
  buildPlanningPostBlock,
  type CampaignEntry,
  type CategoryRef,
  contextForTools,
  emptyDraftPostPayload,
  listAuthorRefs,
  listBlogPayloads,
  listPostsWithMeta,
  newPostId,
  type PlanningMeta,
  planningPostKey,
  readBlogContext,
  sectionResolveTypes,
  setPostStatus,
} from "./blog-data";
import { str } from "./blocks/primitives";
import { MAX_OFFERED_PHOTOS } from "@decocms/shared/blog-campaign";

type Gap = StudioToolOutput<"BLOG_POST_DRAFT">["gaps"][number];

/**
 * The campaign's photographs, breadth first, capped at what the tool accepts.
 *
 * Flattening product by product overruns the cap on any well-stocked campaign
 * and spends the whole allowance on its first few items. Taking one from each
 * before a second from any means the references describe the range the post is
 * actually about.
 */
function referencePhotos(
  products: readonly { images?: readonly string[] }[],
): string[] {
  const picked: string[] = [];
  for (let round = 0; picked.length < MAX_OFFERED_PHOTOS; round += 1) {
    const before = picked.length;
    for (const product of products) {
      const url = product.images?.[round];
      if (!url) continue;
      picked.push(url);
      if (picked.length >= MAX_OFFERED_PHOTOS) return picked;
    }
    if (picked.length === before) break;
  }
  return picked;
}

/**
 * A gap code, worded.
 *
 * The tool answers in codes rather than sentences: it runs server-side with no
 * notion of who is reading, and a sentence it composed would arrive in English
 * inside an interface the person set to their own language.
 */
const GAP_KEYS = {
  "no-store-data": "sandbox.generatePost.gapNoStoreData",
  "sections-dropped": "sandbox.generatePost.gapSectionsDropped",
  "no-bucket": "sandbox.generatePost.gapNoBucket",
  "no-image-model": "sandbox.generatePost.gapNoImageModel",
  "images-failed": "sandbox.generatePost.gapImagesFailed",
  "drafts-failed": "sandbox.generatePost.gapDraftsFailed",
} as const satisfies Record<Gap["code"], TranslationKey>;

/** Everything the wizard collected — what the drafts get written from. */
export interface PostBriefing {
  campaign: CampaignEntry;
  format: { name: string; value: string };
  extraInstructions?: string;
  /** How many drafts to write, each taking its own angle. */
  count: number;
  /** Where a generated image is uploaded. Absent means no image is made. */
  fileConfigId?: string;
}

interface UseGeneratePostParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  decofile: Record<string, unknown>;
  meta: LiveMeta;
  /** The placeholder cards just landed on the board under these keys. */
  onStarted?: (keys: string[]) => void;
}

/**
 * Write a campaign's posts from a briefing, in the background.
 *
 * One card per requested draft is created first and sits in Generating, so the
 * board shows the work in flight rather than nothing at all; each draft is then
 * written onto its own planning key and moves itself to Awaiting review. A
 * failure drops the card back to Draft with the briefing intact, so the
 * operator can retry from what they already filled in.
 *
 * One call, not one per draft: the grounding pass that reads the store is the
 * slow half and its answer is the same for every angle.
 *
 * Every save is awaited in turn because they all land on the same decofile and
 * are serialized there anyway — firing them together only queues them.
 *
 * Resolves when the posts are written. Callers fire and forget: the dialog that
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
  const hideDefaults = useHideDefaultBlogBlocks();
  const save = useSaveBlock({ orgSlug, virtualMcpId, branch });

  return async (briefing: PostBriefing) => {
    const planning: PlanningMeta = {
      campaignKey: briefing.campaign.key,
      format: briefing.format,
      brief: briefing.campaign.trigger.note,
    };
    const placeholder = setPostStatus(
      emptyDraftPostPayload({
        title: briefing.campaign.name,
        planning,
        now: new Date(),
      }),
      "generating",
      new Date(),
    );

    const keys = Array.from({ length: briefing.count }, () =>
      planningPostKey(newPostId()),
    );

    const { merged } = readBlogContext(decofile);
    const brand = contextForTools(merged);
    const categories: CategoryRef[] = listBlogPayloads(decofile, "categories")
      .map(({ payload }) => ({
        name: str(payload.name),
        slug: str(payload.slug),
      }))
      .filter((category) => category.slug);
    const authors: AuthorRef[] = listAuthorRefs(decofile);
    const blocks = blocksForFormat(briefing.format, meta, decofile, {
      hideDefaults,
    });
    // How each block already stores its product slot, so the ids the writer
    // chose land in the shape this site reads.
    const productShapes = Object.fromEntries(
      blocks.map((block) => [block.name, block.example]),
    );

    /**
     * A card left in Generating for a draft that never arrived would lie.
     *
     * Bounded on both sides: `from` skips the drafts that were written, which
     * are finished posts and not ours to overwrite, and `to` stops at the cards
     * that exist — resetting a key that was never created would conjure an
     * empty card instead of clearing one.
     *
     * Best effort by construction. This runs on the failure path, where the
     * save it would make is the one that just failed, and the caller fires this
     * whole routine with `void` — a throw here would surface as an unhandled
     * rejection rather than as anything the operator can read.
     */
    const abandon = async (from: number, to = keys.length) => {
      for (const key of keys.slice(from, to)) {
        try {
          await save.mutateAsync({
            blockKey: key,
            data: buildPlanningPostBlock(
              key,
              setPostStatus(placeholder, "draft", new Date()),
            ),
          });
        } catch (err) {
          console.warn("[generatePost] could not reset a card", err);
        }
      }
    };

    /**
     * The covers, drawn once the words exist, keyed by the draft's position.
     *
     * The campaign's product photographs go in as references, which is what
     * makes a cover worth having: without them the model draws a plausible
     * product the brand does not sell. Every image URL the campaign carries is
     * offered; the tool takes the first few that answer.
     *
     * Empty map on any failure. A post without a cover is a post someone
     * finishes in the editor, and it is already saved by then.
     */
    const illustrate = async (
      posts: { cover: { prompt: string; alt: string } }[],
      brief: PostBriefing,
    ): Promise<Map<string, string>> => {
      if (!brief.fileConfigId || posts.length === 0) return new Map();
      try {
        const drawn = await studio.call("BLOG_POST_ILLUSTRATE", {
          requests: posts.map((post, i) => ({
            id: String(i),
            prompt: post.cover.prompt,
            alt: post.cover.alt,
          })),
          // One photograph per product before a second from any of them, so a
          // campaign is represented by its range rather than by its first item.
          productImages: referencePhotos(brief.campaign.intent.products),
          companyName: brand.companyName ?? "",
          fileConfigId: brief.fileConfigId,
        });
        return new Map(drawn.images.map((image) => [image.id, image.url]));
      } catch (err) {
        console.warn("[generatePost] illustrating failed", err);
        return new Map();
      }
    };

    /** Cards land first so the board shows the work, not a frozen dialog. */
    let created = 0;
    try {
      for (const key of keys) {
        await save.mutateAsync({
          blockKey: key,
          data: buildPlanningPostBlock(key, placeholder),
        });
        created += 1;
      }
    } catch (err) {
      await abandon(0, created);
      toast.error(
        err instanceof Error ? err.message : t("sandbox.generatePost.failed"),
      );
      return;
    }
    onStarted?.(keys);

    /** How many keys hold a real draft, so a later failure cannot erase them. */
    let written = 0;
    try {
      /**
       * Reading the store is its own request, and the slow one. Folded into
       * the drafting call the pair ran past the edge proxy, which answers 524
       * and hangs up while the server keeps spending.
       *
       * Enrichment: a pass that fails leaves `grounding` undefined and the
       * draft is written from the campaign alone, which is thinner rather
       * than absent.
       */
      const grounding = await studio
        .call("BLOG_SITE_GROUND", {
          virtualMcpId,
          purpose: "post",
          focus: `${briefing.campaign.name}: ${briefing.campaign.trigger.note}`,
          language: brand.language,
        })
        .catch((err) => {
          console.warn("[generatePost] grounding failed", err);
          return undefined;
        });

      const result = await studio.call("BLOG_POST_DRAFT", {
        virtualMcpId,
        grounding: grounding
          ? { report: grounding.report, outcome: grounding.outcome }
          : undefined,
        brand: {
          companyName: brand.companyName,
          description: brand.description,
          language: brand.language,
          storeUrl: brand.storeUrl,
          targetAudience: brand.targetAudience,
          tone: brand.tone,
          dos: brand.dos,
          avoid: brand.avoid,
          vocabulary: brand.vocabulary,
          voiceExamples: brand.voiceExamples,
        },
        campaign: {
          name: briefing.campaign.name,
          period: briefing.campaign.period,
          trigger: briefing.campaign.trigger,
          intent: {
            objective: briefing.campaign.intent.objective,
            targets: briefing.campaign.intent.targets,
            products: briefing.campaign.intent.products,
            keywords: briefing.campaign.intent.keywords,
          },
          guardrails: briefing.campaign.guardrails,
        },
        format: briefing.format,
        blocks,
        categories,
        // The draft tool only attributes the post — identity is enough.
        authors: authors.map(({ name, email }) => ({ name, email })),
        extraInstructions: briefing.extraInstructions?.trim() || undefined,
        count: briefing.count,
      });

      /**
       * Covers are drawn after the words exist, by their own call.
       *
       * One image is allowed ninety seconds, so three drafts spent longer on
       * pictures than the whole request was given. Splitting them also buys
       * the thing that makes a cover worth having: the campaign's product
       * photographs go in as references, so the image shows what the brand
       * actually sells instead of a plausible invention.
       */
      const covers = await illustrate(result.posts, briefing);

      const resolveTypes = sectionResolveTypes(meta, { hideDefaults });
      const takenSlugs = listPostsWithMeta(decofile).map((post) => post.slug);
      for (const [i, draft] of result.posts.entries()) {
        const key = keys[i];
        if (!key) break;
        const payload = buildGeneratedPostPayload({
          draft: {
            ...draft,
            cover: { ...draft.cover, url: covers.get(String(i)) ?? "" },
          },
          resolveTypes,
          productShapes,
          categories,
          authors,
          planning,
          takenSlugs,
          now: new Date(),
        });
        takenSlugs.push(str(payload.slug));
        await save.mutateAsync({
          blockKey: key,
          data: buildPlanningPostBlock(key, payload),
        });
        written = i + 1;
      }
      await abandon(written);

      if (result.posts.length > 0) {
        toast.success(
          t("sandbox.generatePost.done", {
            count: String(result.posts.length),
          }),
        );
      }
      for (const gap of result.gaps) {
        toast.warning(t(GAP_KEYS[gap.code], { count: gap.count ?? 0 }));
      }
    } catch (err) {
      // From `written`: a draft already saved is a finished post, not a casualty.
      await abandon(written);
      toast.error(
        err instanceof Error ? err.message : t("sandbox.generatePost.failed"),
      );
    }
  };
}
