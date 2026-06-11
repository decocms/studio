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
  /** Dir follows the Claude Code skill format (contains SKILL.md). */
  hasSkill?: boolean;
}

export interface OrgFsUsage {
  files: number;
  bytes: number;
}

/** A `/fs/recent` entry — cross-volume, so the volume rides along. */
export interface OrgFsRecentEntry extends OrgFsEntry {
  volume: string;
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
export function useOrgFsStat(volume: string | null, path: string) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsStat(org.id, volume ?? "", path),
    enabled: volume !== null,
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
export function useOrgFsRecent(limit = 60) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsRecent(org.id),
    queryFn: async () => {
      const res = await fsFetch(
        `/api/${encodeURIComponent(org.slug)}/fs/recent?limit=${limit}`,
      );
      return ((await res.json()) as { entries: OrgFsRecentEntry[] }).entries;
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
