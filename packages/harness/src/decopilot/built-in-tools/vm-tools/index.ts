/**
 * VM File Tools — runner-agnostic.
 *
 * Registers the eight LLM-visible tools (read/write/edit/grep/glob/bash +
 * copy_to_sandbox/share_with_user) on top of the injected `SandboxFsHooks`.
 * The hooks speak the unified `/_sandbox/*` surface with plain JSON bodies and
 * own the handle resolution + auto-restart retry layer, so this module never
 * imports the sandbox-provider package directly (cycle-break, spec §4.3).
 */

import { tool, zodSchema } from "ai";
import path from "node:path";
import { maybeTruncate } from "./common";
import {
  buildBashDescription,
  BashInputSchema,
  COPY_TO_SANDBOX_DESCRIPTION,
  CopyToSandboxInputSchema,
  EDIT_DESCRIPTION,
  EditInputSchema,
  GLOB_DESCRIPTION,
  GREP_DESCRIPTION,
  GlobInputSchema,
  GrepInputSchema,
  READ_DESCRIPTION,
  ReadInputSchema,
  SHARE_WITH_USER_DESCRIPTION,
  ShareWithUserInputSchema,
  TOOL_APPROVAL,
  buildWriteDescription,
  WriteInputSchema,
} from "./schemas";
import type { VmToolsParams } from "./types";

const MESH_STORAGE_SCHEME = "mesh-storage://";

/**
 * Resolve a `copy_to_sandbox` input to a fetchable URL the daemon can GET.
 * Accepts only org-scoped storage references — `mesh-storage://KEY` (the
 * shape that lands in chat annotations) or a bare KEY. Both are minted
 * to a presigned GET via `ctx.objectStorage`, so the daemon only ever
 * fetches from S3/R2 endpoints mesh controls.
 *
 * Arbitrary `http(s)://` URLs are intentionally rejected: for public
 * URLs the model can use `bash` + `curl` (which is approval-gated, like
 * any shell command), and excluding them keeps the daemon's fetch path
 * free of SSRF concerns.
 *
 * The tool-arg interceptor (`resolveArgsStorageRefs` in file-materializer)
 * substitutes mesh-storage:// → presigned-URL before this handler runs in
 * the happy path. This function is the safety net when interception didn't
 * happen, plus the path for bare keys.
 */
async function resolveSourceUrl(
  raw: string,
  ctx: VmToolsParams["ctx"],
): Promise<string> {
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    throw new Error(
      "copy_to_sandbox does not accept arbitrary URLs — pass a " +
        "mesh-storage:// URI or a bare org storage key. For public URLs, " +
        "use the bash tool (curl).",
    );
  }
  const key = raw.startsWith(MESH_STORAGE_SCHEME)
    ? raw.slice(MESH_STORAGE_SCHEME.length)
    : raw;
  if (!key || key.startsWith("/") || key.includes("..")) {
    throw new Error(`Invalid source: ${raw}`);
  }
  const storage = ctx.objectStorage;
  if (!storage) {
    throw new Error("Object storage is not configured for this org");
  }
  return storage.presignedGetUrl(key);
}

function sanitizeFilename(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/") || trimmed.includes("\\")) return null;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    return null;
  }
  if (trimmed.length > 255) return null;
  return trimmed;
}

/**
 * Build a stable file-redirect URL. Must encode each path segment so
 * keys carrying URL-special chars (`?`, `#`, `&`, space, ...) survive
 * round-trip — the `/api/:org/files/*` route reads `c.req.path` which
 * truncates at the first unescaped `?`.
 */
function toFileDownloadUrl(
  baseUrl: string,
  orgSlug: string,
  key: string,
): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `${baseUrl}/api/${encodeURIComponent(orgSlug)}/files/${encodedKey}`;
}

export type { VmToolsParams } from "./types";

export function createVmTools(params: VmToolsParams) {
  const {
    fs,
    htmlPageBuffer,
    deckBuffer,
    toolOutputMap,
    needsApproval,
    pendingImages,
    ctx,
    threadId,
    orgFs = false,
  } = params;
  const approvalFor = (mutating: boolean) => (mutating ? needsApproval : false);

  // Proxy an arbitrary `/_sandbox/*` route through the fs hooks' retry layer.
  // Used by the tools whose daemon surface the typed flat ops don't model
  // (image-read, html-buffer write/edit, write_from_url, upload_to_url).
  const call = (
    daemonPath: string,
    input: Record<string, unknown>,
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> => fs.onProxy(daemonPath, input, method);

  const read = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.read),
    description: READ_DESCRIPTION,
    inputSchema: zodSchema(ReadInputSchema),
    execute: async (input) => {
      const result = (await call("/_sandbox/read", input)) as
        | { kind: "text"; content: string; lineCount: number }
        | {
            kind: "image";
            mediaType: string;
            base64: string;
            size: number;
          };
      if (result.kind === "image") {
        // Queue the image for injection as a user message in prepareStep.
        // Tool result is text-only — providers don't all carry images in
        // tool result messages, but everyone supports them in user content.
        pendingImages.push({
          url: `data:${result.mediaType};base64,${result.base64}`,
          mediaType: result.mediaType,
          label: `[Image at ${input.path}]`,
        });
        return {
          kind: "image" as const,
          path: input.path,
          mediaType: result.mediaType,
          size: result.size,
          message: "Image attached below.",
        };
      }
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const write = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.write),
    description: buildWriteDescription(orgFs),
    inputSchema: zodSchema(WriteInputSchema),
    execute: async (input) => {
      const daemonResult = await call("/_sandbox/write", input);
      // Enqueue the mirror; the actual S3 PUT happens once per step from
      // `htmlPageBuffer.flush()`, so a burst of writes/edits to the same
      // slug collapses to a single round-trip.
      const preview = htmlPageBuffer.enqueue(input.path, input.content);
      // Deck fast path: mirror `org/<slug>/decks/*.html` content server-
      // side at step end (skips the mount's slow vfs write-back).
      deckBuffer?.enqueue(input.path, input.content);
      return preview
        ? { ...(daemonResult as object), htmlPreview: preview }
        : daemonResult;
    },
  });

  const edit = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.edit),
    description: EDIT_DESCRIPTION,
    inputSchema: zodSchema(EditInputSchema),
    execute: async (input) => {
      const daemonResult = (await call("/_sandbox/edit", input)) as {
        ok: boolean;
        replacements: number;
        content?: string;
      };
      const postEditContent = daemonResult.content;
      const { content: _omit, ...resultForClient } = daemonResult;
      if (typeof postEditContent !== "string") return resultForClient;
      const preview = htmlPageBuffer.enqueue(input.path, postEditContent);
      deckBuffer?.enqueue(input.path, postEditContent);
      return preview
        ? { ...resultForClient, htmlPreview: preview }
        : resultForClient;
    },
  });

  const grep = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.grep),
    description: GREP_DESCRIPTION,
    inputSchema: zodSchema(GrepInputSchema),
    execute: async (input) => {
      const result = await call("/_sandbox/grep", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const glob = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.glob),
    description: GLOB_DESCRIPTION,
    inputSchema: zodSchema(GlobInputSchema),
    execute: async (input) => {
      const result = await call("/_sandbox/glob", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const bash = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.bash),
    description: buildBashDescription(orgFs),
    inputSchema: zodSchema(BashInputSchema),
    execute: async (input) => {
      const result = await call("/_sandbox/bash", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const copy_to_sandbox = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.copy_to_sandbox),
    description: COPY_TO_SANDBOX_DESCRIPTION,
    inputSchema: zodSchema(CopyToSandboxInputSchema),
    execute: async (input) => {
      const sourceUrl = await resolveSourceUrl(input.url, ctx);
      const result = await call("/_sandbox/write_from_url", {
        url: sourceUrl,
        path: input.target,
      });
      return result as { ok: boolean; path: string; size: number };
    },
  });

  const share_with_user = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.share_with_user),
    description: SHARE_WITH_USER_DESCRIPTION,
    inputSchema: zodSchema(ShareWithUserInputSchema),
    execute: async (input) => {
      const orgSlug = ctx.organization?.slug;
      const storage = ctx.objectStorage;
      if (!orgSlug || !storage) {
        throw new Error("Object storage is not configured for this org");
      }
      const filename = sanitizeFilename(
        input.name ?? path.basename(input.source),
      );
      if (!filename) {
        throw new Error(`Invalid filename: ${input.name ?? input.source}`);
      }
      const key = `model-outputs/${threadId}/${filename}`;
      const presignedPutUrl = await storage.presignedPutUrl(key);
      await call("/_sandbox/upload_to_url", {
        path: input.source,
        url: presignedPutUrl,
      });
      return {
        key,
        filename,
        downloadUrl: toFileDownloadUrl(ctx.baseUrl, orgSlug, key),
      };
    },
  });

  return {
    read,
    write,
    edit,
    grep,
    glob,
    bash,
    // With org-fs mounts live, both legacy transfer tools disappear:
    // `org/output/` + the thread-outputs chips replace share_with_user
    // (model-outputs), and chat attachments land in `org/upload/` via the
    // uploads volume, replacing copy_to_sandbox. Only register them when
    // the deployment hasn't flipped the flag. (`orgFs` is the harness-package
    // DI'd equivalent of the cluster's `getSettings().orgFsClusterMounts`.)
    ...(orgFs ? {} : { share_with_user, copy_to_sandbox }),
  };
}
