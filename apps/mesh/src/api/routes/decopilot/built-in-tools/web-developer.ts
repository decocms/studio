/**
 * web-developer built-in tools.
 *
 * Per-run injection. Attached by dispatchRun when the agent id matches
 * `isWebDeveloper`. Every tool here is hard-scoped to
 * `web-developer/{threadId}/` under the org's object storage — the model
 * supplies a slug, never a raw key, so it can't escape its thread or
 * stomp on another agent's files.
 *
 * The returned URL is the stable `/api/{orgSlug}/files/{key}` route
 * (302-redirects to a fresh presigned URL on every request). The chat
 * iframes it directly; saves overwrite in place so the iframe just
 * reloads.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import {
  getWebDeveloperPrefix,
  isValidSlug,
  resolveWebDeveloperThread,
  webDeveloperKey,
} from "@/agents/web-developer";
import type { MeshContext } from "@/core/mesh-context";

function fileUrl(orgSlug: string, key: string): string {
  return `/api/${encodeURIComponent(orgSlug)}/files/${key}`;
}

function requireSetup(
  ctx: MeshContext,
):
  | { ok: true; threadId: string; orgSlug: string }
  | { ok: false; error: string } {
  const threadId = resolveWebDeveloperThread(ctx);
  if (!threadId) {
    return { ok: false, error: "Thread context required to write pages." };
  }
  const orgSlug = ctx.organization?.slug;
  if (!orgSlug) {
    return { ok: false, error: "Organization context required." };
  }
  if (!ctx.objectStorage) {
    return {
      ok: false,
      error: "Object storage is not configured for this deployment.",
    };
  }
  return { ok: true, threadId, orgSlug };
}

const WriteHtmlPageInputSchema = z.object({
  slug: z
    .string()
    .min(1)
    .describe(
      'Page slug, no extension. Use "index" for the main page. Subpaths ' +
        'like "pricing/team" are allowed. Letters, digits, dot, dash, ' +
        "underscore, slash only.",
    ),
  html: z
    .string()
    .min(1)
    .describe("Full HTML document starting with <!doctype html>."),
});

function createWriteHtmlPageTool(ctx: MeshContext) {
  return tool({
    description:
      "Write a static HTML page to this thread's storage. Overwrites any " +
      "existing page at the same slug. Returns a stable URL that the chat " +
      "UI iframes for the user — the same URL keeps working across edits.",
    inputSchema: zodSchema(WriteHtmlPageInputSchema),
    execute: async (input) => {
      const setup = requireSetup(ctx);
      if (!setup.ok) return { success: false, error: setup.error };
      if (!isValidSlug(input.slug)) {
        return {
          success: false,
          error:
            'Invalid slug. Use letters, digits, ".", "-", "_", "/" — no ' +
            'leading slash, no "..".',
        };
      }

      const key = webDeveloperKey(setup.threadId, input.slug);
      await ctx.objectStorage!.put(key, input.html, {
        contentType: "text/html; charset=utf-8",
      });

      return {
        success: true,
        slug: input.slug,
        key,
        url: fileUrl(setup.orgSlug, key),
        bytes: new TextEncoder().encode(input.html).length,
      };
    },
  });
}

const ReadHtmlPageInputSchema = z.object({
  slug: z.string().min(1).describe("Page slug to read, no extension."),
});

function createReadHtmlPageTool(ctx: MeshContext) {
  return tool({
    description:
      "Read the current HTML for a page in this thread. Use this before " +
      "editing so you start from the latest version.",
    inputSchema: zodSchema(ReadHtmlPageInputSchema),
    execute: async (input) => {
      const setup = requireSetup(ctx);
      if (!setup.ok) return { success: false, error: setup.error };
      if (!isValidSlug(input.slug)) {
        return { success: false, error: "Invalid slug." };
      }

      const key = webDeveloperKey(setup.threadId, input.slug);
      try {
        const result = await ctx.objectStorage!.get(key);
        if ("error" in result) {
          return {
            success: false,
            error: `Page too large to read inline (${result.size} bytes).`,
          };
        }
        return {
          success: true,
          slug: input.slug,
          key,
          url: fileUrl(setup.orgSlug, key),
          html: result.content,
          bytes: result.size,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Page not found.",
        };
      }
    },
  });
}

const ListHtmlPagesInputSchema = z.object({});

function createListHtmlPagesTool(ctx: MeshContext) {
  return tool({
    description:
      "List all HTML pages written in this thread. Useful to see what " +
      "pages already exist before naming a new slug.",
    inputSchema: zodSchema(ListHtmlPagesInputSchema),
    execute: async () => {
      const setup = requireSetup(ctx);
      if (!setup.ok) return { success: false, error: setup.error };

      const prefix = getWebDeveloperPrefix(setup.threadId);
      const result = await ctx.objectStorage!.list({ prefix, maxKeys: 100 });
      const pages = result.objects.map((o) => {
        const relative = o.key.startsWith(prefix)
          ? o.key.slice(prefix.length)
          : o.key;
        const slug = relative.replace(/\.html$/i, "");
        return {
          slug,
          key: o.key,
          url: fileUrl(setup.orgSlug, o.key),
          bytes: o.size,
          updatedAt: o.lastModified?.toISOString(),
        };
      });
      return { success: true, pages };
    },
  });
}

const DeleteHtmlPageInputSchema = z.object({
  slug: z.string().min(1).describe("Page slug to delete, no extension."),
});

function createDeleteHtmlPageTool(ctx: MeshContext) {
  return tool({
    description:
      "Delete a page from this thread's storage. The iframe for that URL " +
      "will 404 after deletion.",
    inputSchema: zodSchema(DeleteHtmlPageInputSchema),
    execute: async (input) => {
      const setup = requireSetup(ctx);
      if (!setup.ok) return { success: false, error: setup.error };
      if (!isValidSlug(input.slug)) {
        return { success: false, error: "Invalid slug." };
      }

      const key = webDeveloperKey(setup.threadId, input.slug);
      await ctx.objectStorage!.delete(key);
      return { success: true, slug: input.slug, key };
    },
  });
}

export function createWebDeveloperTools(ctx: MeshContext) {
  return {
    write_html_page: createWriteHtmlPageTool(ctx),
    read_html_page: createReadHtmlPageTool(ctx),
    list_html_pages: createListHtmlPagesTool(ctx),
    delete_html_page: createDeleteHtmlPageTool(ctx),
  };
}
