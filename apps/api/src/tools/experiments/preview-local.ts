/**
 * LOCAL DEV ONLY — lets the Experiments review screen preview a
 * not-yet-created (or being-edited) test against a real running site.
 *
 * Two writes, both required — proven the hard way locally:
 * 1. The site's `.deco/TestesAB.json` on disk — `useExperiment`'s own
 *    manifest gate (`active: true` for the key) has to pass before it even
 *    asks `window.__ab` anything.
 * 2. The local deco-ab-testing admin Worker's `PUT /tests` — turns out the
 *    SDK's `?__ab=test:arm` QA override only resolves for a test the Worker
 *    already knows about (it walks the fetched manifest's test list; an
 *    unregistered name is never reached, forced or not). The comment that
 *    used to be here claiming step 2 was unnecessary was wrong.
 *
 * Both writes are inert unless their env vars are set (absent by default —
 * see `AB_TESTING_LOCAL_MANIFEST_PATH`/`AB_TESTING_LOCAL_ADMIN_URL`/
 * `AB_TESTING_LOCAL_ADMIN_TOKEN`/`AB_TESTING_LOCAL_HOST` below). Never wired
 * into EXPERIMENT_CREATE/UPDATE — called directly from the review screen,
 * before anything is persisted, so a rejected draft never touches either.
 */

import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { assertOwnsSite } from "./ownership";
import { assertExperimentsV2 } from "./v2-gate";

const VariantInput = z.object({
  id: z.string().min(1),
  weight: z.number().int().min(0).max(100),
});

export const EXPERIMENT_PREVIEW_SYNC_LOCAL = defineTool({
  name: "EXPERIMENT_PREVIEW_SYNC_LOCAL",
  description:
    "LOCAL DEV ONLY. Writes one entry into a local site's .deco/TestesAB.json on disk, so its dev server can preview a draft experiment via the SDK's `?__ab=` override before it's created. No-ops (returns synced:false) unless AB_TESTING_LOCAL_MANIFEST_PATH is set in this API server's environment. Never call this expecting it to affect anything beyond one developer's local filesystem.",
  annotations: {
    title: "Preview Experiment Locally (dev only)",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z.string().min(1),
    variants: z.array(VariantInput).min(1),
  }),
  outputSchema: z.object({ synced: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);
    await assertExperimentsV2(ctx, organization.id);

    let synced = false;

    // A site reading its manifest from the Worker has no file to gate on.
    const manifestPath = process.env.AB_TESTING_LOCAL_MANIFEST_PATH;
    if (manifestPath) {
      let manifest: Record<string, unknown> = {};
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        // Missing or invalid file — start fresh rather than fail the preview.
      }
      manifest[input.key] = {
        variants: input.variants.map((v) => v.id),
        active: true,
      };
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      synced = true;
    }

    const adminUrl = process.env.AB_TESTING_LOCAL_ADMIN_URL;
    const adminToken = process.env.AB_TESTING_LOCAL_ADMIN_TOKEN;
    const host = process.env.AB_TESTING_LOCAL_HOST;
    if (adminUrl && adminToken && host) {
      try {
        const res = await fetch(
          `${adminUrl}/tests?host=${encodeURIComponent(host)}`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${adminToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              name: input.key,
              enabled: true,
              variants: input.variants,
            }),
          },
        );
        // A silent 4xx here renders control under a forced-arm URL.
        if (res.ok) {
          synced = true;
        } else {
          console.warn(
            `[EXPERIMENT_PREVIEW_SYNC_LOCAL] admin worker PUT ${res.status}:`,
            await res.text().catch(() => ""),
          );
        }
      } catch (err) {
        console.warn(
          "[EXPERIMENT_PREVIEW_SYNC_LOCAL] admin worker PUT failed:",
          err,
        );
      }
    }

    return { synced };
  },
});
