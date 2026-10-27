/**
 * The blog's editorial state: brand, writing rules, formats, campaigns, seeds.
 *
 * One home, the organization's file library, under the project's folder. It
 * used to be blocks in the site's own decofile, which pinned it to a git branch
 * and put it out of reach of anything without a browser. Sites carrying those
 * blocks still have them on disk — nothing here reads them, and a form on such
 * a site opens empty rather than filled from a store this no longer writes to.
 * {@link withoutBlogState} is what keeps them from leaking back in.
 *
 * `blocks` keeps the decofile's own shape, so every reader — `readBlogContext`,
 * `scanCampaigns`, `scanCampaignSeeds` — is untouched, and `save`/`remove` take
 * the same `{ blockKey, data }` the decofile mutations took.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { isBlogStateConflict } from "@decocms/shared/blog-state";
import type {
  StudioToolInput,
  StudioToolOutput,
} from "@decocms/shared/tools/tool-io";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import {
  BRAND_BLOCK_KEY,
  CAMPAIGN_KEY_PREFIX,
  CAMPAIGN_SEED_KEY_PREFIX,
  CONTEXT_BLOCK_KEY,
  FORMATS_BLOCK_KEY,
} from "./blog-data";

type RemoteState = StudioToolOutput<"BLOG_STATE_GET">;
type SetInput = StudioToolInput<"BLOG_STATE_SET">;

/** The singleton keys this state used to be stored under. */
const STATE_SINGLETONS = [
  BRAND_BLOCK_KEY,
  CONTEXT_BLOCK_KEY,
  FORMATS_BLOCK_KEY,
];

/** The library's state, as the decofile slice it stands in for. */
function blocksOf(state: RemoteState | undefined): Record<string, unknown> {
  if (!state) return {};
  const blocks: Record<string, unknown> = {};
  if (state.brand) blocks[BRAND_BLOCK_KEY] = state.brand;
  if (state.context) blocks[CONTEXT_BLOCK_KEY] = state.context;
  if (state.formats) blocks[FORMATS_BLOCK_KEY] = state.formats;
  for (const { id, data } of state.campaigns) {
    blocks[`${CAMPAIGN_KEY_PREFIX}${id}`] = data;
  }
  for (const { id, data } of state.campaignSeeds) {
    blocks[`${CAMPAIGN_SEED_KEY_PREFIX}${id}`] = data;
  }
  return blocks;
}

/** Whether a key is one of the five families this hook owns. */
function isBlogStateKey(key: string): boolean {
  return (
    STATE_SINGLETONS.includes(key) ||
    key.startsWith(CAMPAIGN_KEY_PREFIX) ||
    key.startsWith(CAMPAIGN_SEED_KEY_PREFIX)
  );
}

/**
 * A decofile with the five families removed.
 *
 * A site that used to keep them there still has the blocks, and a screen that
 * merges the decofile with the library would read a brand nothing writes to
 * any more — the form fills itself from a store that is no longer the truth.
 * Post drafts stay: `blog-manager/posts/` was never part of this move.
 */
export function withoutBlogState(
  decofile: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(decofile).filter(([key]) => !isBlogStateKey(key)),
  );
}

/** The record id a campaign or seed key carries. */
function idOf(blockKey: string): string {
  const prefix = blockKey.startsWith(CAMPAIGN_KEY_PREFIX)
    ? CAMPAIGN_KEY_PREFIX
    : CAMPAIGN_SEED_KEY_PREFIX;
  return blockKey.slice(prefix.length);
}

/** The one file a `{ blockKey, data }` write lands in, as the tool takes it. */
function writeFor(
  blockKey: string,
  data: Record<string, unknown>,
): Partial<SetInput> | null {
  if (blockKey === BRAND_BLOCK_KEY) return { brand: data };
  if (blockKey === CONTEXT_BLOCK_KEY) return { context: data };
  if (blockKey === FORMATS_BLOCK_KEY) {
    return { formats: data as SetInput["formats"] };
  }
  const record = { id: idOf(blockKey), data } as { id: string; data: never };
  if (blockKey.startsWith(CAMPAIGN_KEY_PREFIX)) return { campaigns: [record] };
  if (blockKey.startsWith(CAMPAIGN_SEED_KEY_PREFIX)) {
    return { campaignSeeds: [record] };
  }
  return null;
}

/** The `remove` arguments for a key, or null when the key is not a record. */
function removeFor(blockKey: string): Partial<SetInput> | null {
  if (blockKey.startsWith(CAMPAIGN_KEY_PREFIX)) {
    return { removeCampaigns: [idOf(blockKey)] };
  }
  if (blockKey.startsWith(CAMPAIGN_SEED_KEY_PREFIX)) {
    return { removeCampaignSeeds: [idOf(blockKey)] };
  }
  return null;
}

/**
 * The library file a block key lands in, as a path suffix.
 *
 * The browser does not know the project's folder name and has no business
 * computing it — the server pins it. Matching on the tail of the paths the read
 * reported is enough to find the version of the file about to be replaced.
 */
function pathSuffix(blockKey: string): string {
  if (blockKey === BRAND_BLOCK_KEY) return "/brand.json";
  if (blockKey === CONTEXT_BLOCK_KEY) return "/context.json";
  if (blockKey === FORMATS_BLOCK_KEY) return "/formats.json";
  const dir = blockKey.startsWith(CAMPAIGN_KEY_PREFIX)
    ? "campaigns"
    : "campaign-seeds";
  return `/${dir}/${idOf(blockKey)}.json`;
}

export interface BlogStateWrite {
  blockKey: string;
  data: Record<string, unknown>;
}

export interface BlogState {
  /** The five families, shaped exactly like the decofile slice they replace. */
  blocks: Record<string, unknown>;
  /** False while the library is still being read. */
  ready: boolean;
  save: {
    mutate: (write: BlogStateWrite) => void;
    mutateAsync: (write: BlogStateWrite) => Promise<unknown>;
    isPending: boolean;
    isError: boolean;
  };
  remove: {
    mutate: (args: { blockKey: string }) => void;
    mutateAsync: (args: { blockKey: string }) => Promise<unknown>;
    isPending: boolean;
    isError: boolean;
  };
  /**
   * The key whose last write was refused because the file had changed, or
   * null. The editor offers to reload or to overwrite; `keepMine` is the
   * overwrite.
   */
  conflict: string | null;
  keepMine: () => void;
  reloadTheirs: () => void;
}

export function useBlogState({
  orgSlug,
  virtualMcpId,
  enabled = true,
}: {
  orgSlug: string;
  virtualMcpId: string;
  /** False for an organization with the feature off — the tool refuses it. */
  enabled?: boolean;
}): BlogState {
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const queryKey = KEYS.blogState(orgSlug, virtualMcpId);
  const remote = useQuery({
    queryKey,
    enabled,
    queryFn: () => studio.call("BLOG_STATE_GET", { virtualMcpId }),
  });

  /**
   * The versions this tab produced itself, over the ones the read reported.
   * Without them a second edit would be refused against the version its own
   * first edit replaced.
   */
  const written = useRef<Record<string, string>>({});
  const versionsNow = () => ({
    ...(queryClient.getQueryData<RemoteState>(queryKey)?.versions ?? {}),
    ...written.current,
  });

  /** State, not a ref: the banner offering the choice has to render. */
  const [conflict, setConflict] = useState<string | null>(null);
  const pendingData = useRef<Record<string, Record<string, unknown>>>({});

  const library = useMutation({
    /** Serialized per project: two autosaves must not land out of order. */
    scope: { id: `blog-state:${orgSlug}:${virtualMcpId}` },
    mutationFn: async ({
      blockKey,
      data,
      force,
    }: BlogStateWrite & { force?: boolean }) => {
      const fields = writeFor(blockKey, data);
      if (!fields) throw new Error(`Not blog state: ${blockKey}`);
      const suffix = pathSuffix(blockKey);
      const versions = versionsNow();
      const path = Object.keys(versions).find((candidate) =>
        candidate.endsWith(suffix),
      );
      const hash = force || !path ? undefined : versions[path];
      const result = await studio.call("BLOG_STATE_SET", {
        virtualMcpId,
        ...fields,
        ...(hash && path ? { expect: { [path]: hash } } : {}),
      });
      return { blockKey, result };
    },
    onMutate: ({ blockKey, data }) => {
      pendingData.current[blockKey] = data;
      queryClient.setQueryData(queryKey, (current: RemoteState | undefined) =>
        current ? optimistic(current, blockKey, data) : current,
      );
    },
    onSuccess: ({ blockKey, result }) => {
      for (const { path, contentHash } of result.written) {
        if (contentHash) written.current[path] = contentHash;
      }
      setConflict((current) => (current === blockKey ? null : current));
      delete pendingData.current[blockKey];
    },
    onError: (error, { blockKey }) => {
      if (isBlogStateConflict(error)) {
        setConflict(blockKey);
        return;
      }
      delete pendingData.current[blockKey];
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const save = {
    mutate: (write: BlogStateWrite) => library.mutate(write),
    mutateAsync: (write: BlogStateWrite) => library.mutateAsync(write),
    isPending: library.isPending,
    isError: library.isError,
  };

  const remove = useMutation({
    scope: { id: `blog-state:${orgSlug}:${virtualMcpId}` },
    mutationFn: async ({ blockKey }: { blockKey: string }) => {
      const fields = removeFor(blockKey);
      if (!fields) throw new Error(`Not a blog record: ${blockKey}`);
      return await studio.call("BLOG_STATE_SET", { virtualMcpId, ...fields });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  const keepMine = () => {
    const data = conflict ? pendingData.current[conflict] : undefined;
    if (!conflict || !data) return;
    library.mutate({ blockKey: conflict, data, force: true });
  };

  const reloadTheirs = () => {
    if (conflict) delete pendingData.current[conflict];
    setConflict(null);
    void queryClient.invalidateQueries({ queryKey });
  };

  return {
    blocks: blocksOf(remote.data),
    ready: remote.isSuccess,
    save,
    remove,
    conflict,
    keepMine,
    reloadTheirs,
  };
}

/** The read's cache, with one block replaced, so the editor does not flicker. */
function optimistic(
  current: RemoteState,
  blockKey: string,
  data: Record<string, unknown>,
): RemoteState {
  if (blockKey === BRAND_BLOCK_KEY) return { ...current, brand: data };
  if (blockKey === CONTEXT_BLOCK_KEY) return { ...current, context: data };
  if (blockKey === FORMATS_BLOCK_KEY) return { ...current, formats: data };
  const campaign = blockKey.startsWith(CAMPAIGN_KEY_PREFIX);
  const id = idOf(blockKey);
  const list = campaign ? current.campaigns : current.campaignSeeds;
  const next = list.some((record) => record.id === id)
    ? list.map((record) => (record.id === id ? { id, data } : record))
    : [...list, { id, data }];
  return campaign
    ? { ...current, campaigns: next }
    : { ...current, campaignSeeds: next };
}
