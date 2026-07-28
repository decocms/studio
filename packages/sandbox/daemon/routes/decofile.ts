import { join } from "node:path";
import type { TenantConfigStore } from "../config-store";
import { generateDecofileFromBlocksDeduped } from "./fs";

interface DecofileDeps {
  repoDir: string;
  store: TenantConfigStore;
}

/**
 * `GET /_sandbox/decofile`
 *
 * The working-tree DRAFT decofile — every `.deco/blocks/*.json` merged — served
 * for a production site to pull and render against (see the pull-based Fast
 * Preview design). Replaces pushing the same payload into a POST body, which
 * only deco's own runtime honours; Next.js and friends render on GET only.
 *
 * Unauthenticated, like its neighbours `/_sandbox/{events,scripts,idle}`: the
 * fetcher is an arbitrary production server, not the cluster, so it cannot
 * carry the daemon bearer token. `entry.ts` matches it ahead of the token gate.
 * Readable by anyone holding the sandbox handle — the same capability boundary
 * `/_sandbox/fast-preview` already relies on.
 *
 * Content-addressed: the response carries an `ETag` over the merged bytes, so
 * callers cache by version and re-fetch only when the draft actually changes.
 * `?v=` is accepted and ignored — it exists so the caller can cache-bust by URL.
 *
 * Returns the merged object as raw text (no `JSON.parse` round-trip) to respect
 * the daemon's single-threaded budget: this payload is routinely >10MB.
 */
export function makeDecofileHandler(deps: DecofileDeps) {
  return async (req: Request): Promise<Response> => {
    const app = deps.store.read()?.application;
    // `.deco/blocks` sits under the package path (the dev-script cwd) when the
    // project isn't at the repo root; daemon reads resolve against repoDir.
    const packagePath = app?.packageManager?.path ?? "";
    const blocksDir = join(deps.repoDir, packagePath, ".deco", "blocks");

    const decofile = await generateDecofileFromBlocksDeduped(blocksDir);
    if (decofile === null) {
      return new Response(
        JSON.stringify({ error: "No .deco/blocks to serve." }),
        {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }

    // Wyhash over the merged bytes — native speed, so even a multi-MB payload
    // stays well inside the health probe's budget. Not a security boundary,
    // only a change detector.
    const etag = `W/"${Bun.hash(decofile).toString(16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }

    return new Response(decofile, {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag,
        // The draft changes on every save; never let a shared cache hold it.
        // Callers key their own cache on the ETag instead.
        "cache-control": "no-store",
        // Server-to-server fetch, but the browser may probe it during dev.
        "access-control-allow-origin": "*",
      },
    });
  };
}
