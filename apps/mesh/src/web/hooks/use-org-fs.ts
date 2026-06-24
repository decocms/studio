/**
 * Data layer for the org filesystem browser (the Library page). Talks the
 * org-scoped HTTP contract at `/api/:org/fs/:volume/*` directly (same-origin
 * session auth) — unlike most views this is NOT an MCP tool surface:
 * uploads/downloads move raw bytes, which the HTTP routes are built for.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys";

export interface OrgFsEntry {
  /** Normalized in-volume path, no leading/trailing slash. */
  path: string;
  kind: "file" | "dir";
  size: number;
  updatedAt: string;
  contentHash?: string | null;
  /** Dir follows the Claude Code skill format (contains SKILL.md). */
  hasSkill?: boolean;
  /** This entry's own public flag (served to anyone with the link). */
  readPublic?: boolean;
  /** Public via own flag OR a published ancestor folder (inherited). What the
   *  UI should signal; `readPublic && !effectivePublic` never happens. */
  effectivePublic?: boolean;
}

export interface OrgFsUsage {
  files: number;
  bytes: number;
}

/** A `/fs/recent` entry — cross-volume, so the volume rides along. */
export interface OrgFsRecentEntry extends OrgFsEntry {
  volume: string;
}

/**
 * Content marker for cache-busting previews. Prefer the content hash:
 * the sandbox mount's vfs write-back re-PUTs identical bytes seconds
 * after the deck fast-path mirror, bumping size-agnostic `updatedAt` —
 * a hash-keyed marker doesn't roll on that echo (no spurious iframe
 * reloads / stale-edit badges).
 */
export function entryMarker(entry: {
  size: number;
  updatedAt: string;
  contentHash?: string | null;
}): string {
  return entry.contentHash ?? `${entry.size}-${entry.updatedAt}`;
}

function fsUrl(
  orgSlug: string,
  volume: string,
  op: string,
  params?: Record<string, string>,
): string {
  const qs = new URLSearchParams(params).toString();
  return `/api/${encodeURIComponent(orgSlug)}/fs/${encodeURIComponent(volume)}/${op}${qs ? `?${qs}` : ""}`;
}

async function fsFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string }).error ?? "";
    } catch {
      // non-JSON body
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res;
}

/** Children of `path` ("" = volume root), dirs first then by name. */
export function useOrgFsList(volume: string, path: string) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsList(org.id, volume, path),
    // Keep the previous listing on screen while navigating into a dir.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const res = await fsFetch(fsUrl(org.slug, volume, "list", { path }));
      const body = (await res.json()) as { entries: OrgFsEntry[] };
      return body.entries.toSorted((a, b) =>
        a.kind !== b.kind
          ? a.kind === "dir"
            ? -1
            : 1
          : a.path.localeCompare(b.path),
      );
    },
  });
}

/** Metadata for one entry — null when absent. Powers the Library preview. */
export function useOrgFsStat(
  volume: string | null,
  path: string,
  opts?: { refetchIntervalWhenAbsent?: number },
) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsStat(org.id, volume ?? "", path),
    enabled: volume !== null,
    // Optional poll while the entry doesn't exist yet (e.g. the deck tab
    // waiting out the sandbox mount's write-back lag).
    refetchInterval: opts?.refetchIntervalWhenAbsent
      ? (query) =>
          query.state.data ? false : (opts.refetchIntervalWhenAbsent ?? false)
      : undefined,
    queryFn: async (): Promise<OrgFsEntry | null> => {
      const res = await fetch(fsUrl(org.slug, volume ?? "", "stat", { path }));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { entry: OrgFsEntry }).entry;
    },
  });
}

export function useOrgFsUsage(volume: string) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsUsage(org.id, volume),
    queryFn: async () => {
      const res = await fsFetch(fsUrl(org.slug, volume, "usage"));
      return (await res.json()) as OrgFsUsage;
    },
  });
}

/**
 * Most recently written files across every volume, newest first — the
 * Library home's feed. The query key is limit-agnostic (single consumer);
 * mutations invalidate it alongside the volume prefix.
 */
export function useOrgFsRecent(limit = 60, opts?: { enabled?: boolean }) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsRecent(org.id),
    enabled: opts?.enabled,
    queryFn: async () => {
      const res = await fsFetch(
        `/api/${encodeURIComponent(org.slug)}/fs/recent?limit=${limit}`,
      );
      return ((await res.json()) as { entries: OrgFsRecentEntry[] }).entries;
    },
  });
}

/** A skill folder (dir containing SKILL.md) in the org filesystem. */
export interface OrgFsSkill {
  volume: string;
  path: string;
}

/**
 * Skill folders (dirs containing SKILL.md) across the home volume and the
 * deployment's public skill sets — the attachable-skill set for agent
 * knowledge. Lists each volume's root and keeps the `hasSkill` dirs.
 */
export function useOrgFsSkills(opts?: { enabled?: boolean }) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsSkills(org.id),
    enabled: opts?.enabled,
    queryFn: async (): Promise<OrgFsSkill[]> => {
      const setsRes = await fsFetch(
        `/api/${encodeURIComponent(org.slug)}/fs/public-sets`,
      );
      const { sets } = (await setsRes.json()) as { sets: string[] };
      const volumes = ["home", ...sets.map((s) => `public-${s}`)];
      const perVolume = await Promise.all(
        volumes.map(async (volume) => {
          const res = await fsFetch(
            fsUrl(org.slug, volume, "list", { path: "" }),
          );
          const { entries } = (await res.json()) as { entries: OrgFsEntry[] };
          return entries
            .filter((e) => e.kind === "dir" && e.hasSkill)
            .map((e) => ({ volume, path: e.path }));
        }),
      );
      return perVolume.flat();
    },
  });
}

/** The deployment's shared public skill sets (readonly volumes). */
export function useOrgFsPublicSets() {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsPublicSets(org.id),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fsFetch(
        `/api/${encodeURIComponent(org.slug)}/fs/public-sets`,
      );
      return ((await res.json()) as { sets: string[] }).sets;
    },
  });
}

/** Same-origin byte URL for a file — usable as a download href. */
export function useOrgFsDownloadUrl(volume: string) {
  const { org } = useProjectContext();
  return (path: string) => fsUrl(org.slug, volume, "read", { path });
}

/** Volume-late variant for cross-volume feeds (the Library recent grid). */
export function useOrgFsFileUrl() {
  const { org } = useProjectContext();
  return (volume: string, path: string) =>
    fsUrl(org.slug, volume, "read", { path });
}

/**
 * Write a text file body to a volume path (deck inline editing). Returns
 * the written entry (size/updatedAt) so callers can self-echo-suppress the
 * stat refresh. Invalidation is the CALLER's job — the deck editor needs
 * to record the entry BEFORE the stat query refetches.
 */
export function useOrgFsWriteText(volume: string) {
  const { org } = useProjectContext();
  return useMutation({
    mutationFn: async (input: {
      path: string;
      body: string;
      contentType?: string;
    }): Promise<OrgFsEntry> => {
      const res = await fsFetch(
        fsUrl(org.slug, volume, "file", { path: input.path }),
        {
          method: "PUT",
          headers: {
            "content-type": input.contentType ?? "text/html; charset=utf-8",
          },
          body: input.body,
        },
      );
      return ((await res.json()) as { entry: OrgFsEntry }).entry;
    },
  });
}

/**
 * Toggle a file's public-read flag — share to anyone with the link, or revoke.
 * Optimistically flips the cached `stat` so the Share toggle reacts instantly,
 * then revalidates (rolling back on error).
 */
export function useOrgFsSetPublic(volume: string) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      path: string;
      public: boolean;
    }): Promise<OrgFsEntry> => {
      const res = await fsFetch(
        fsUrl(org.slug, volume, "public", { path: input.path }),
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ public: input.public }),
        },
      );
      return ((await res.json()) as { entry: OrgFsEntry }).entry;
    },
    onMutate: async (input) => {
      const key = KEYS.orgFsStat(org.id, volume, input.path);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<OrgFsEntry | null>(key);
      queryClient.setQueryData<OrgFsEntry | null>(key, (old) =>
        old ? { ...old, readPublic: input.public } : old,
      );
      return { key, previous };
    },
    onError: (_err, _input, ctx) => {
      if (ctx) queryClient.setQueryData(ctx.key, ctx.previous);
    },
    onSettled: (_data, _err, input) => {
      queryClient.invalidateQueries({
        queryKey: KEYS.orgFsStat(org.id, volume, input.path),
      });
      // Refresh the browser listings + recent feed so public badges re-render.
      queryClient.invalidateQueries({
        queryKey: KEYS.orgFsVolume(org.id, volume),
      });
      queryClient.invalidateQueries({ queryKey: KEYS.orgFsRecent(org.id) });
    },
  });
}

/** Upload/mkdir/delete; each invalidates the whole volume's listings+usage. */
export function useOrgFsMutations(volume: string) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: KEYS.orgFsVolume(org.id, volume),
    });
    queryClient.invalidateQueries({ queryKey: KEYS.orgFsRecent(org.id) });
  };

  const upload = useMutation({
    mutationFn: async (input: { dir: string; files: File[] }) => {
      for (const file of input.files) {
        const path = input.dir ? `${input.dir}/${file.name}` : file.name;
        await fsFetch(fsUrl(org.slug, volume, "file", { path }), {
          method: "PUT",
          headers: {
            "content-type": file.type || "application/octet-stream",
          },
          body: file,
        });
      }
    },
    // Settled, not success: files upload sequentially, so a mid-batch failure
    // (quota, size) leaves earlier files written — the listing must refresh.
    onSettled: invalidate,
  });

  const mkdir = useMutation({
    mutationFn: async (path: string) => {
      await fsFetch(fsUrl(org.slug, volume, "dir", { path }), {
        method: "POST",
      });
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (path: string) => {
      await fsFetch(fsUrl(org.slug, volume, "file", { path }), {
        method: "DELETE",
      });
    },
    onSuccess: invalidate,
  });

  return { upload, mkdir, remove };
}
