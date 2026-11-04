/**
 * How the card's post goes out: its address, when it goes live, its cover and
 * how it shows in search. Read from and written to the post on the card's
 * branch, the copy the site renders; the card's own copy of the cover and the
 * SEO follows, so the Content tab and the preview show the same.
 */

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  findBlogPageSlug,
  firstCategorySlug,
  getBlogPayload,
  isPlanningPostKey,
  listBlogPayloads,
  missingPostFields,
} from "@decocms/shared/blog";
import type { BlogCard } from "@decocms/shared/blog-card";
import { decoBlockFingerprint } from "@decocms/shared/decofile";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import type { StudioToolInput } from "@decocms/shared/tools/tool-io";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  buildPostBlock,
  slugifyTitle,
  stampPostModified,
  uniquePostSlug,
} from "@/components/sandbox/content/blog/blog-data";
import { dayKey } from "@/components/sandbox/content/blog/post-calendar-data";
import { BlockConflictError } from "@/components/sections-editor/decofile-api";
import { ImageField } from "@/components/sections-editor/fields/image-field";
import { useT } from "@/i18n/use-t.ts";
import { readProjectProfile } from "@/lib/project-profile";
import { KEYS } from "@/lib/query-keys";
import { useProjectContext } from "@/sdk";
import {
  type CardBranch,
  cardWritten,
  useCardBranch,
  writeCardBranch,
} from "./use-card-preview";
import { cardPostKey } from "./card-post-move";

export type CardPatch = StudioToolInput<"BLOG_CARD_UPDATE">["patch"];

/** Past these, search engines cut the title and the description. */
const SEO_TITLE_CHARS = 60;
const SEO_DESCRIPTION_CHARS = 155;

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isHttps = (url: string) => /^https:\/\/\S+$/i.test(url);

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The store's address as a person reads it: `casaaurora.com`. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** An ISO date-time as a `datetime-local` value, in the person's time zone; "" when unreadable. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export interface Draft {
  slug: string;
  /** Null until the person picks a date: the stored one, or the suggestion, shows. */
  goLive: string | null;
  image: string;
  alt: string;
  seoTitle: string;
  seoDescription: string;
}

function draftOf(payload: Record<string, unknown>): Draft {
  const seo = record(payload.seo);
  return {
    slug: str(payload.slug),
    goLive: null,
    image: str(payload.image),
    alt: str(payload.alt),
    seoTitle: str(seo.title),
    seoDescription: str(seo.description),
  };
}

/**
 * The post with the person's publishing fields in: the slug normalized and
 * numbered past the ones `taken`, the go-live date when one was picked, and
 * the search image following the cover unless someone set it apart.
 */
export function publishedPayload(
  payload: Record<string, unknown>,
  draft: Draft,
  taken: readonly string[],
): { payload: Record<string, unknown>; slug: string; renamed: boolean } {
  const normalized = slugifyTitle(draft.slug);
  const slug =
    normalized && taken.includes(normalized)
      ? uniquePostSlug(normalized, [...taken])
      : normalized;
  const seo = record(payload.seo);
  const picked = draft.goLive ? new Date(draft.goLive) : null;
  const goLive =
    picked && !Number.isNaN(picked.getTime()) ? picked.toISOString() : null;
  const seoImageFollows =
    !str(seo.image) || str(seo.image) === str(payload.image);
  return {
    slug,
    renamed: slug !== normalized,
    payload: stampPostModified({
      ...payload,
      slug,
      image: draft.image,
      alt: draft.alt,
      // The day the person picked, as the calendar reads it; the UTC day can be the next one.
      ...(goLive && picked
        ? { scheduledDatetime: goLive, date: dayKey(picked) }
        : {}),
      seo: {
        ...seo,
        title: draft.seoTitle,
        description: draft.seoDescription,
        ...(seoImageFollows ? { image: draft.image } : {}),
      },
    }),
  };
}

export function CardPublishing({
  card,
  site,
  locked,
  onUpdate,
}: {
  card: BlogCard;
  site: VirtualMCPEntity | undefined;
  /** The card's agent is at work, and its next write would undo an edit. */
  locked: boolean;
  onUpdate: (patch: CardPatch) => Promise<unknown>;
}) {
  const t = useT();
  const query = useCardBranch(card);
  if (!cardWritten(card) || !card.postKey) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("contentTrack.publish.notWritten")}
      </p>
    );
  }
  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  const read = query.data;
  const postKey = read ? cardPostKey(card, read.decofile) : null;
  const block = read && postKey ? read.decofile[postKey] : undefined;
  const payload =
    block && typeof block === "object"
      ? getBlogPayload(block as Record<string, unknown>, "posts")
      : undefined;
  if (!read || !postKey || !payload) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("contentTrack.publish.unavailable")}
      </p>
    );
  }
  return (
    <PublishingForm
      // A new head (a save, or the agent's) starts the form from it.
      key={read.draft.version}
      card={card}
      postKey={postKey}
      site={site}
      read={read}
      block={block}
      payload={payload}
      locked={locked}
      onUpdate={onUpdate}
    />
  );
}

function PublishingForm({
  card,
  postKey,
  site,
  read,
  block,
  payload,
  locked,
  onUpdate,
}: {
  card: BlogCard;
  postKey: string;
  site: VirtualMCPEntity | undefined;
  read: CardBranch;
  block: unknown;
  payload: Record<string, unknown>;
  locked: boolean;
  onUpdate: (patch: CardPatch) => Promise<unknown>;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => draftOf(payload));
  const [saving, setSaving] = useState(false);
  const saved = draftOf(payload);
  const dirty =
    draft.goLive !== null ||
    draft.slug !== saved.slug ||
    draft.image !== saved.image ||
    draft.alt !== saved.alt ||
    draft.seoTitle !== saved.seoTitle ||
    draft.seoDescription !== saved.seoDescription;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const host = hostOf((site && readProjectProfile(site).storeUrl) || "");
  const template = findBlogPageSlug(read.decofile) ?? "/blog/:slug";
  const prefix = (template.split(/:slug[*?]?/)[0] ?? "/").replace(
    /:category[*?]?/g,
    firstCategorySlug(payload) || "…",
  );
  const stored = str(payload.scheduledDatetime);
  const suggested = card.hypothesis?.publishAt ?? "";
  const goLive =
    draft.goLive ?? (toLocalInput(stored) || toLocalInput(suggested));
  const isSuggestion =
    draft.goLive === null && !toLocalInput(stored) && !!toLocalInput(suggested);
  const seoTitle = draft.seoTitle || str(payload.title);
  const seoDescription = draft.seoDescription || str(payload.excerpt);
  const seoImage = str(record(payload.seo).image) || draft.image;
  const crumbs = [host, ...prefix.split("/").filter(Boolean), draft.slug]
    .filter(Boolean)
    .join(" › ");

  const save = async () => {
    if (!card.branch) return;
    setSaving(true);
    try {
      const taken = listBlogPayloads(read.decofile, "posts")
        .filter((entry) => entry.key !== postKey)
        .map((entry) => str(entry.payload.slug))
        .filter(Boolean);
      const {
        payload: next,
        slug,
        renamed,
      } = publishedPayload(payload, draft, taken);
      // A slug is every post's address; a live post needs the rest too.
      const missing = missingPostFields(next);
      if (
        missing.includes("slug") ||
        (!isPlanningPostKey(postKey) && missing.length > 0)
      ) {
        toast.error(t("contentTrack.publish.incomplete"));
        return;
      }
      const nextBlock = buildPostBlock(postKey, next);
      const pointer = await writeCardBranch(
        queryClient,
        org.slug,
        { virtualMcpId: card.virtualMcpId, branch: card.branch },
        read,
        {
          set: { [postKey]: nextBlock },
          expect: { [postKey]: await decoBlockFingerprint(block) },
        },
      );
      if (renamed) {
        toast.info(t("sandbox.postEditor.slugDeduped", { slug }));
      }
      try {
        await onUpdate({
          commit: pointer.version,
          post: {
            cover: { url: draft.image, alt: draft.alt },
            seo: { title: draft.seoTitle, description: draft.seoDescription },
          },
        });
        toast.success(t("contentTrack.publish.saved"));
      } catch (err) {
        toast.error(
          t("contentTrack.publish.cardBehind", { error: message(err) }),
        );
        void queryClient.invalidateQueries({
          queryKey: KEYS.blogCardDecofile(
            org.slug,
            card.virtualMcpId,
            card.branch,
            card.commit ?? "",
          ),
        });
      }
    } catch (err) {
      if (err instanceof BlockConflictError) {
        toast.error(t("contentTrack.publish.conflict"));
        void queryClient.invalidateQueries({
          queryKey: KEYS.blogCardDecofile(
            org.slug,
            card.virtualMcpId,
            card.branch,
            card.commit ?? "",
          ),
        });
      } else {
        toast.error(t("contentTrack.publish.failed", { error: message(err) }));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset
      disabled={locked || saving}
      className="flex min-w-0 flex-col gap-4"
    >
      {locked && (
        <p className="text-xs text-muted-foreground">
          {t("contentTrack.publish.locked")}
        </p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="publish-slug" className="text-xs text-muted-foreground">
          {t("contentTrack.publish.slug")}
        </Label>
        <div className="flex min-w-0 items-stretch overflow-hidden rounded-md border border-input">
          <span
            title={`${host}${prefix}`}
            className="flex max-w-[45%] shrink-0 items-center truncate bg-muted px-2 text-xs text-muted-foreground"
          >
            {prefix}
          </span>
          <input
            id="publish-slug"
            value={draft.slug}
            onChange={(e) => set("slug", e.target.value)}
            onBlur={() => set("slug", slugifyTitle(draft.slug))}
            className="min-w-0 flex-1 bg-transparent px-2 py-1.5 text-xs outline-none"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="publish-go-live"
          className="text-xs text-muted-foreground"
        >
          {t("contentTrack.publish.goLive")}
          {isSuggestion && ` · ${t("contentTrack.publish.suggested")}`}
        </Label>
        <Input
          id="publish-go-live"
          type="datetime-local"
          value={goLive}
          onChange={(e) => set("goLive", e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <ImageField
          schema={{
            type: "string",
            format: "image-uri",
            title: t("contentTrack.publish.cover"),
          }}
          value={draft.image}
          onChange={(value) => set("image", str(value))}
          path="publish-cover"
          label={t("contentTrack.publish.cover")}
        />
        <Input
          aria-label={t("contentTrack.publish.alt")}
          value={draft.alt}
          placeholder={t("contentTrack.publish.altMissing")}
          onChange={(e) => set("alt", e.target.value)}
          className="h-8 text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">
          {t("contentTrack.publish.seoPreview")}
        </span>
        <div className="overflow-hidden rounded-xl border border-border bg-background">
          {isHttps(seoImage) && (
            <img
              src={seoImage}
              alt=""
              className="aspect-[1.91/1] w-full bg-muted object-cover"
            />
          )}
          <div className="flex flex-col gap-0.5 p-3">
            <span className="truncate text-[11px] text-muted-foreground">
              {crumbs}
            </span>
            <span className="line-clamp-2 text-[13px] font-medium text-link">
              {seoTitle}
            </span>
            <span className="line-clamp-3 text-xs text-muted-foreground">
              {seoDescription}
            </span>
          </div>
        </div>
        <SeoField
          id="publish-seo-title"
          label={t("contentTrack.publish.seoTitle")}
          value={draft.seoTitle}
          placeholder={str(payload.title)}
          max={SEO_TITLE_CHARS}
          onChange={(value) => set("seoTitle", value)}
        />
        <SeoField
          id="publish-seo-description"
          label={t("contentTrack.publish.seoDescription")}
          value={draft.seoDescription}
          placeholder={str(payload.excerpt)}
          max={SEO_DESCRIPTION_CHARS}
          multiline
          onChange={(value) => set("seoDescription", value)}
        />
      </div>

      {dirty && (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDraft(draftOf(payload))}
          >
            {t("contentTrack.publish.discard")}
          </Button>
          <Button type="button" size="sm" onClick={() => void save()}>
            {t("contentTrack.publish.save")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}

/** A search field with how much of it search engines show. */
function SeoField({
  id,
  label,
  value,
  placeholder,
  max,
  multiline,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  max: number;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const over = value.length > max;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <span
          className={cn(
            "text-[11px] tabular-nums",
            over ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {value.length}/{max}
        </span>
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          rows={3}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="text-xs"
        />
      ) : (
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 text-xs"
        />
      )}
    </div>
  );
}
