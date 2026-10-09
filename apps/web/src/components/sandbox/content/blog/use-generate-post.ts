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

type Gap = StudioToolOutput<"BLOG_POST_DRAFT">["gaps"][number];

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
    for (const key of keys) {
      await save.mutateAsync({
        blockKey: key,
        data: buildPlanningPostBlock(key, placeholder),
      });
    }
    onStarted?.(keys);

    const { merged } = readBlogContext(decofile);
    const brand = contextForTools(merged);
    const categories: CategoryRef[] = listBlogPayloads(decofile, "categories")
      .map(({ payload }) => ({
        name: str(payload.name),
        slug: str(payload.slug),
      }))
      .filter((category) => category.slug);
    const authors: AuthorRef[] = listAuthorRefs(decofile);

    /** A card left in Generating for a draft that never arrived would lie. */
    const abandon = async (from: number) => {
      for (const key of keys.slice(from)) {
        await save.mutateAsync({
          blockKey: key,
          data: buildPlanningPostBlock(
            key,
            setPostStatus(placeholder, "draft", new Date()),
          ),
        });
      }
    };

    try {
      const result = await studio.call("BLOG_POST_DRAFT", {
        virtualMcpId,
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
        blocks: blocksForFormat(briefing.format, meta, decofile, {
          hideDefaults,
        }),
        categories,
        // The draft tool only attributes the post — identity is enough.
        authors: authors.map(({ name, email }) => ({ name, email })),
        extraInstructions: briefing.extraInstructions?.trim() || undefined,
        count: briefing.count,
        fileConfigId: briefing.fileConfigId,
      });

      const resolveTypes = sectionResolveTypes(meta, { hideDefaults });
      const takenSlugs = listPostsWithMeta(decofile).map((post) => post.slug);
      for (const [i, draft] of result.posts.entries()) {
        const key = keys[i];
        if (!key) break;
        const payload = buildGeneratedPostPayload({
          draft,
          resolveTypes,
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
      }
      await abandon(result.posts.length);

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
      await abandon(0);
      toast.error(
        err instanceof Error ? err.message : t("sandbox.generatePost.failed"),
      );
    }
  };
}
