/**
 * Backfill: hoist legacy inline `data:` media out of thread_messages
 *
 * Thread rows written before the asset-hoisting save sink shipped still carry
 * inline base64 media in `parts`/`metadata`. The agent only ever appends new
 * messages, so those rows are never rewritten by normal operation and keep
 * re-entering LLM context on every read. This one-off repair scans them and
 * rewrites the inline media to object-storage files URLs, reusing the EXACT
 * same hoisting logic as the live write sink (`createAssetHoister` +
 * `hoistInlineAssets`) so the produced keys/URLs cannot drift.
 *
 * Designed to run inside a production pod, where DATABASE_URL and the S3
 * settings are already in the environment:
 *
 *   bun run deco backfill-thread-assets [--dry-run] [--batch 500] [--limit N] \
 *     [--base-url https://host]
 *
 * Idempotent: content-addressed keys mean re-running only touches rows that
 * still contain inline media; updated rows no longer match and are skipped.
 * The UPDATE rewrites only `parts`/`metadata` — it does not touch
 * `threads.updated_at`, so thread ordering is unaffected.
 */

import { sql } from "kysely";
import { closeDatabase, getDb } from "../../database";
import { getObjectStorageS3Service } from "../../object-storage/factory";
import { createBoundObjectStorage } from "../../object-storage/bound-object-storage";
import {
  createAssetHoister,
  hoistInlineAssets,
  type AssetHoister,
} from "../../object-storage/asset-hoister";
import { getBaseUrl } from "../../core/server-constants";

export interface BackfillThreadAssetsOptions {
  dryRun: boolean;
  batch: number;
  limit?: number;
  baseUrl?: string;
}

export async function backfillThreadAssetsCommand(
  opts: BackfillThreadAssetsOptions,
): Promise<number> {
  const { dryRun, batch } = opts;
  const baseUrl = opts.baseUrl ?? getBaseUrl();

  const s3Service = getObjectStorageS3Service();
  if (!s3Service) {
    console.error(
      "[backfill-thread-assets] Object storage (S3) is not configured — " +
        "cannot hoist inline media. Set S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/" +
        "S3_SECRET_ACCESS_KEY and retry.",
    );
    return 1;
  }
  if (/^https?:\/\/localhost(:|\/|$)/.test(baseUrl)) {
    console.warn(
      `[backfill-thread-assets] base URL resolves to "${baseUrl}" — set BASE_URL ` +
        "(or pass --base-url) to the public origin, or stored media URLs will be wrong.",
    );
  }

  console.log(
    `[backfill-thread-assets] starting${dryRun ? " (dry-run)" : ""} — ` +
      `baseUrl=${baseUrl} batch=${batch}${opts.limit ? ` limit=${opts.limit}` : ""}`,
  );

  const database = getDb();
  const { db } = database;
  // One hoister per org (object storage is org-bound; the slug shapes the URL).
  const hoisterByOrg = new Map<string, AssetHoister>();
  const getHoister = (orgId: string, orgSlug: string | null): AssetHoister => {
    const cached = hoisterByOrg.get(orgId);
    if (cached) return cached;
    const hoist = createAssetHoister({
      objectStorage: createBoundObjectStorage(s3Service, orgId),
      baseUrl,
      orgSlug: orgSlug ?? undefined,
      prefix: "thread-assets",
      dryRun,
    });
    hoisterByOrg.set(orgId, hoist);
    return hoist;
  };

  let cursor = "";
  let scanned = 0;
  let changed = 0;
  let errors = 0;

  try {
    for (;;) {
      const remaining = opts.limit ? opts.limit - scanned : Infinity;
      if (remaining <= 0) break;
      const take = Math.min(batch, remaining);

      // `parts`/`metadata` are physically `text` (JSON strings); the schema
      // types them as structured JSON, so we read raw via sql<string> and
      // filter with a raw LIKE over the constant media patterns (no user input).
      const rows = await db
        .selectFrom("thread_messages as tm")
        .innerJoin("threads as t", "t.id", "tm.thread_id")
        .innerJoin("organization as o", "o.id", "t.organization_id")
        .select([
          "tm.id as id",
          sql<string>`tm.parts`.as("parts"),
          sql<string | null>`tm.metadata`.as("metadata"),
          "t.organization_id as orgId",
          "o.slug as orgSlug",
        ])
        .where("tm.id", ">", cursor)
        .where(
          sql<boolean>`(
            tm.parts LIKE '%data:image/%' OR tm.parts LIKE '%data:audio/%' OR tm.parts LIKE '%data:video/%'
            OR tm.metadata LIKE '%data:image/%' OR tm.metadata LIKE '%data:audio/%' OR tm.metadata LIKE '%data:video/%'
          )`,
        )
        .orderBy("tm.id", "asc")
        .limit(take)
        .execute();

      if (rows.length === 0) break;

      for (const row of rows) {
        cursor = row.id;
        scanned++;
        try {
          const hoist = getHoister(row.orgId, row.orgSlug);

          const parts = JSON.parse(row.parts);
          const hoistedParts = await hoistInlineAssets(parts, hoist);
          const partsChanged = hoistedParts !== parts;

          const metadata =
            row.metadata !== null ? JSON.parse(row.metadata) : null;
          const hoistedMetadata = await hoistInlineAssets(metadata, hoist);
          const metadataChanged = hoistedMetadata !== metadata;

          if (!partsChanged && !metadataChanged) continue;
          changed++;

          if (dryRun) continue;
          await db
            .updateTable("thread_messages")
            .set({
              parts: partsChanged ? JSON.stringify(hoistedParts) : row.parts,
              metadata: metadataChanged
                ? JSON.stringify(hoistedMetadata)
                : row.metadata,
            })
            .where("id", "=", row.id)
            .execute();
        } catch (err) {
          errors++;
          console.error(
            `[backfill-thread-assets] row ${row.id} failed, skipping:`,
            err,
          );
        }
      }

      console.log(
        `[backfill-thread-assets] scanned=${scanned} ${
          dryRun ? "would-change" : "changed"
        }=${changed} errors=${errors}`,
      );
    }
  } finally {
    await closeDatabase(database).catch(() => {});
  }

  console.log(
    `[backfill-thread-assets] done — scanned=${scanned} ${
      dryRun ? "would-change" : "changed"
    }=${changed} errors=${errors}`,
  );
  return errors > 0 ? 1 : 0;
}
