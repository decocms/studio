/**
 * `<runtime.path>/.deco/app.json` — the repo-owned opt-in for serving a
 * project's published decofile to a mobile app. Written by developers via PR
 * (the CMS only writes `.deco/blocks`). Anything unparseable or invalid is
 * treated as absent, so every consumer fails closed.
 */

import { z } from "zod";
import type { RepoContentClient } from "@/git-providers";

const MAX_MANIFEST_CHARS = 64 * 1024;

const AppManifestSchema = z.object({
  kind: z.literal("eitri-app"),
  publishedContent: z.boolean().optional(),
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
