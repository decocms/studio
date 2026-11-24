/**
 * Short share links.
 *
 * `POST /api/:org/short-links` stores a page inside the org and returns
 * `/s/<label>-<id>`. `GET /s/...` redirects to that page, which still enforces
 * its own access. Only the id after the last `-` is looked up, so the label is
 * decorative and renaming a project never breaks a link. Link unfurlers get a
 * small HTML card instead of the redirect, because the target is an
 * authenticated SPA page they cannot render.
 */

import { Hono } from "hono";
import type { Kysely } from "kysely";
import { z } from "zod";
import { slugify } from "@decocms/shared/utils/slugify";
import type { StudioContext } from "@/core/studio-context";
import type { Database } from "@/storage/types";
import { isSafeInviteRedirect } from "../../auth/invite-link-token";

const ID_LENGTH = 10;
const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ID_PATTERN = /^[0-9A-Za-z]{10}$/;

const createSchema = z.object({
  targetPath: z.string().min(1).max(4096),
  /** Names shown in the link, outermost first: `["People", "Perfil"]`. */
  labels: z.array(z.string().max(80)).max(3).default([]),
});

function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  // 256 % 62 skews a few characters slightly; fine for unguessable ids.
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

/** `Relatórios Q1` → `relatorios-q1`. */
export function labelSlug(name: string): string {
  return slugify(name.normalize("NFD").replace(/\p{M}/gu, "")).slice(0, 40);
}

function shortLinkPath(id: string, label: string): string {
  return label ? `/s/${label}-${id}` : `/s/${id}`;
}

/** The id is whatever follows the last `-` of the last segment. */
export function parseShortLinkId(path: string): string | null {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const id = last.slice(last.lastIndexOf("-") + 1);
  return ID_PATTERN.test(id) ? id : null;
}

const UNFURLER_UA =
  /bot|crawler|spider|facebookexternalhit|whatsapp|slack-imgproxy|telegram|discord|linkedin|skype|embedly/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unfurlCard(title: string, url: string, target: string): string {
  const t = escapeHtml(title ? `${title} — Studio` : "Studio");
  const u = escapeHtml(url);
  const to = escapeHtml(target);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><meta property="og:title" content="${t}"><meta property="og:site_name" content="deco Studio"><meta property="og:url" content="${u}"><meta http-equiv="refresh" content="0;url=${to}"></head><body></body></html>`;
}

/** One link per page: sharing it again returns the same id, with the names
 *  refreshed in case they changed. */
export async function upsertShortLink(
  db: Kysely<Database>,
  input: {
    organizationId: string;
    targetPath: string;
    labels: string[];
    createdBy: string | null;
  },
): Promise<{ id: string; path: string }> {
  const label = input.labels.map(labelSlug).filter(Boolean).join("/");
  const title = input.labels.filter(Boolean).toReversed().join(" · ");
  const row = await db
    .insertInto("short_links")
    .values({
      id: generateId(),
      organization_id: input.organizationId,
      target_path: input.targetPath,
      label,
      title,
      created_by: input.createdBy,
    })
    .onConflict((oc) =>
      oc.columns(["organization_id", "target_path"]).doUpdateSet((eb) => ({
        label: eb.ref("excluded.label"),
        title: eb.ref("excluded.title"),
      })),
    )
    .returning(["id", "label"])
    .executeTakeFirstOrThrow();
  return { id: row.id, path: shortLinkPath(row.id, row.label) };
}

type Variables = { studioContext: StudioContext };

/** `POST /api/:org/short-links`, mounted under the org-scoped API. */
export function createShortLinkCreateRoutes() {
  const app = new Hono<{ Variables: Variables }>();
  app.post("/short-links", async (c) => {
    const ctx = c.get("studioContext");
    const userId = ctx.auth?.user?.id;
    if (!userId && !ctx.auth?.apiKey?.id) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const org = ctx.organization;
    if (!org?.id || !org.slug) {
      return c.json({ error: "Organization required" }, 400);
    }
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid input" }, 400);
    }
    const { targetPath, labels } = parsed.data;
    if (!isSafeInviteRedirect(targetPath, org.slug)) {
      return c.json(
        { error: "targetPath must be a path inside this organization" },
        400,
      );
    }
    return c.json(
      await upsertShortLink(ctx.db, {
        organizationId: org.id,
        targetPath,
        labels,
        createdBy: userId ?? null,
      }),
    );
  });
  return app;
}

/** `GET /s/*`, mounted at the root: anyone holding the link may follow it. */
export function createShortLinkResolveRoutes(db: Kysely<Database>) {
  const app = new Hono();
  app.get("/*", async (c) => {
    const id = parseShortLinkId(c.req.path);
    const link = id
      ? await db
          .selectFrom("short_links")
          .select(["target_path", "title"])
          .where("id", "=", id)
          .executeTakeFirst()
      : undefined;
    if (!link) return c.text("Link not found", 404);

    if (UNFURLER_UA.test(c.req.header("user-agent") ?? "")) {
      return c.html(
        unfurlCard(
          link.title,
          new URL(c.req.path, c.req.url).toString(),
          link.target_path,
        ),
      );
    }
    return c.redirect(link.target_path, 302);
  });
  return app;
}
