/**
 * `<runtime.path>/.deco/app.json` — the repo-owned opt-in for serving a
 * project's published decofile to a mobile app. Written by developers via PR
 * (the CMS only writes `.deco/blocks`). Anything unparseable or invalid is
 * treated as absent, so every consumer fails closed.
 */

import { repoIdentityKey } from "@decocms/shared/git-providers";
import { z } from "zod";
import type { RepoContentClient } from "@/git-providers";
import { createSingleFlight } from "@/decofile/single-flight";
import { createTtlLruCache } from "@/lib/ttl-lru-cache";

const MAX_MANIFEST_CHARS = 64 * 1024;

const AppManifestSchema = z.object({
  kind: z.literal("eitri-app"),
  publishedContent: z.boolean().optional(),
  /** The only VTEX account the draft preview's commerce relay may read. */
  vtexAccount: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;

export function parseAppManifest(text: string | null): AppManifest | null {
  if (text === null || text.length > MAX_MANIFEST_CHARS) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = AppManifestSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function appManifestPath(packagePath: string | null): string {
  return packagePath ? `${packagePath}/.deco/app.json` : ".deco/app.json";
}

/** Provider errors propagate (the caller decides between stale and 502). */
export async function readAppManifest(
  client: RepoContentClient,
  ref: string,
  packagePath: string | null,
): Promise<AppManifest | null> {
  return parseAppManifest(
    await client.readFileAtRef(ref, appManifestPath(packagePath)),
  );
}

/** `invalid`: the file is there but unparseable — callers fail closed. */
export type CachedAppManifest = AppManifest | "absent" | "invalid";

const manifestCache = createTtlLruCache<CachedAppManifest>({
  ttlMs: 60_000,
  maxSize: 1000,
});
const manifestFlight = createSingleFlight<CachedAppManifest>();

/** The manifest at `ref`, re-read from the provider at most once a minute. */
export async function readAppManifestCached(
  client: RepoContentClient,
  ref: string,
  packagePath: string | null,
): Promise<CachedAppManifest> {
  const key = `${repoIdentityKey(client.repo)}#${ref}:${packagePath ?? ""}`;
  const hit = manifestCache.get(key);
  if (hit) return hit;
  return manifestFlight.run(key, async () => {
    const text = await client.readFileAtRef(ref, appManifestPath(packagePath));
    const value: CachedAppManifest =
      text === null ? "absent" : (parseAppManifest(text) ?? "invalid");
    manifestCache.set(key, value);
    return value;
  });
}

/** True when `previewServerUrl` is a Studio app-preview storage folder
 *  (`…/api/<org>/files/app-preview/<project>/`) — the CI-built app canvas. */
export function isAppPreviewServerUrl(previewServerUrl: string): boolean {
  try {
    return /^\/api\/[^/]+\/files\/app-preview\/[^?#]+\/$/.test(
      new URL(previewServerUrl).pathname,
    );
  } catch {
    return false;
  }
}
