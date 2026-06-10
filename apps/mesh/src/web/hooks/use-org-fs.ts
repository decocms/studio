/**
 * Data layer for the org filesystem browser (settings → Files). Talks the
 * org-scoped HTTP contract at `/api/:org/fs/:volume/*` directly (same-origin
 * session auth) — unlike most settings views this is NOT an MCP tool surface:
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
}

export interface OrgFsUsage {
  files: number;
  bytes: number;
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
    // Sandboxes write into these volumes live — keep the open folder fresh
    // without a manual Refresh (focused window only; TanStack default).
    refetchInterval: 5_000,
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

export function useOrgFsUsage(volume: string) {
  const { org } = useProjectContext();
  return useQuery({
    queryKey: KEYS.orgFsUsage(org.id, volume),
    refetchInterval: 15_000,
    queryFn: async () => {
      const res = await fsFetch(fsUrl(org.slug, volume, "usage"));
      return (await res.json()) as OrgFsUsage;
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

/** Upload/mkdir/delete; each invalidates the whole volume's listings+usage. */
export function useOrgFsMutations(volume: string) {
  const { org } = useProjectContext();
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: KEYS.orgFsVolume(org.id, volume),
    });

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
    onSuccess: invalidate,
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
