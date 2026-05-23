/**
 * VM File Tools — runner-agnostic.
 *
 * Registers the six LLM-visible tools (read/write/edit/grep/glob/bash) on
 * top of any `SandboxProvider.proxyDaemonRequest`. All runners speak the
 * unified `/_decopilot_vm/*` surface with plain JSON bodies.
 */

import { tool, zodSchema } from "ai";
import path from "node:path";
import type { SandboxProvider } from "@decocms/sandbox/provider";
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
  WRITE_DESCRIPTION,
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

/**
 * Sentinel error class for "the daemon proxy itself threw" — meaning the
 * sandbox is unreachable (dead, restarting, or never provisioned). Callers
 * upstream of `daemonRequest` use this to distinguish a recoverable
 * sandbox-death from a request-level failure (4xx/5xx from a live daemon).
 */
class DaemonUnreachableError extends Error {
  readonly code = "DAEMON_UNREACHABLE" as const;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Daemon proxy failed");
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

async function daemonRequest(
  runner: SandboxProvider,
  handle: string,
  path: string,
  body: Record<string, unknown> | null,
  method: "GET" | "POST" | "PUT" = "POST",
): Promise<unknown> {
  let res: Response;
  try {
    const init: {
      method: string;
      headers: Headers;
      body: string | null;
    } = {
      method,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
    };
    // GET/HEAD must not carry a body; the runners' proxy strips it anyway,
    // but constructing it is wasteful and obscures intent.
    if (method !== "GET" && body !== null) {
      init.body = JSON.stringify(body);
    }
    res = await runner.proxyDaemonRequest(handle, path, init);
  } catch (cause) {
    throw new DaemonUnreachableError(cause);
  }
  const rawText = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    console.error(
      "[vm-tools] Failed to parse JSON response runner=%s path=%s status=%d rawText=%s",
      runner.kind,
      path,
      res.status,
      rawText.slice(0, 2000),
    );
    const statusHint =
      res.status >= 500
        ? " (server error)"
        : res.status === 0
          ? " (no response)"
          : "";
    throw new Error(
      `Daemon ${path} returned invalid JSON (HTTP ${res.status}${statusHint}): ${rawText.slice(0, 800)}`,
    );
  }
  if (!res.ok) {
    console.error(
      "[vm-tools] Non-OK response runner=%s path=%s status=%d body=%s",
      runner.kind,
      path,
      res.status,
      rawText.slice(0, 2000),
    );
    throw new Error(
      (json as { error?: string }).error ??
        `Daemon ${path} failed (${res.status})`,
    );
  }
  return json;
}

export function createVmTools(params: VmToolsParams) {
  const {
    runner,
    ensureHandle,
    invalidateHandle,
    canAutoRestart,
    htmlPageBuffer,
    toolOutputMap,
    needsApproval,
    pendingImages,
    ctx,
    threadId,
  } = params;
  const approvalFor = (mutating: boolean) => (mutating ? needsApproval : false);

  /**
   * Format the user-visible "sandbox unreachable" message. Ephemeral agents
   * have no server button — auto-restart is the only recovery path, so if
   * we got here both attempts already failed. GitHub-linked agents do have
   * a UI button, so the original "ask user to start it" message applies.
   */
  const formatUnreachableMessage = (cause: unknown): string => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return canAutoRestart
      ? `Sandbox is unreachable and auto-restart did not recover it: ${detail}`
      : "The sandbox is not running. Ask the user to start it by clicking the server button (left side of the header bar).";
  };

  const call = async (
    daemonPath: string,
    input: Record<string, unknown>,
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> => {
    const tryOnce = async (handle: string) =>
      daemonRequest(runner, handle, daemonPath, input, method);
    const firstHandle = await ensureHandle();
    try {
      return await tryOnce(firstHandle);
    } catch (firstErr) {
      // Only retry on daemon-unreachable (sandbox dead). HTTP-level errors
      // from a live daemon (4xx/5xx) are surfaced as-is — a retry would
      // just repeat the same failure.
      if (!(firstErr instanceof DaemonUnreachableError) || !canAutoRestart) {
        if (firstErr instanceof DaemonUnreachableError) {
          throw new Error(formatUnreachableMessage(firstErr.cause ?? firstErr));
        }
        throw firstErr;
      }
      console.warn(
        `[vm-tools] daemon ${daemonPath} unreachable — reaping sandbox and retrying once`,
        firstErr.cause ?? firstErr,
      );
      try {
        await invalidateHandle();
      } catch (reapErr) {
        console.warn("[vm-tools] invalidateHandle failed", reapErr);
      }
      let secondHandle: string;
      try {
        secondHandle = await ensureHandle();
      } catch (provisionErr) {
        throw new Error(
          `Failed to restart sandbox: ${
            provisionErr instanceof Error
              ? provisionErr.message
              : String(provisionErr)
          }`,
        );
      }
      try {
        return await tryOnce(secondHandle);
      } catch (secondErr) {
        if (secondErr instanceof DaemonUnreachableError) {
          throw new Error(
            formatUnreachableMessage(secondErr.cause ?? secondErr),
          );
        }
        throw secondErr;
      }
    }
  };

  const read = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.read),
    description: READ_DESCRIPTION,
    inputSchema: zodSchema(ReadInputSchema),
    execute: async (input) => {
      const result = (await call("/_decopilot_vm/read", input)) as
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
    description: WRITE_DESCRIPTION,
    inputSchema: zodSchema(WriteInputSchema),
    execute: async (input) => {
      const daemonResult = await call("/_decopilot_vm/write", input);
      // Enqueue the mirror; the actual S3 PUT happens once per step from
      // `htmlPageBuffer.flush()`, so a burst of writes/edits to the same
      // slug collapses to a single round-trip.
      const preview = htmlPageBuffer.enqueue(input.path, input.content);
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
      const daemonResult = await call("/_decopilot_vm/edit", input);
      // `edit` carries old_string/new_string, not the full file. Read it
      // back from the daemon after the replacement lands so the buffer
      // sees the post-edit state. The bytes value returned to the chat
      // row reflects this latest read, but only the final state per slug
      // gets PUT at flush time.
      const readResult = (await call("/_decopilot_vm/read", {
        path: input.path,
      })) as
        | { kind: "text"; content: string }
        | { kind: "image"; mediaType: string };
      if (readResult.kind !== "text") return daemonResult;
      const preview = htmlPageBuffer.enqueue(input.path, readResult.content);
      return preview
        ? { ...(daemonResult as object), htmlPreview: preview }
        : daemonResult;
    },
  });

  const grep = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.grep),
    description: GREP_DESCRIPTION,
    inputSchema: zodSchema(GrepInputSchema),
    execute: async (input) => {
      const result = await call("/_decopilot_vm/grep", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const glob = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.glob),
    description: GLOB_DESCRIPTION,
    inputSchema: zodSchema(GlobInputSchema),
    execute: async (input) => {
      const result = await call("/_decopilot_vm/glob", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const bash = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.bash),
    description: buildBashDescription(),
    inputSchema: zodSchema(BashInputSchema),
    execute: async (input) => {
      const result = await call("/_decopilot_vm/bash", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const copy_to_sandbox = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.copy_to_sandbox),
    description: COPY_TO_SANDBOX_DESCRIPTION,
    inputSchema: zodSchema(CopyToSandboxInputSchema),
    execute: async (input) => {
      const sourceUrl = await resolveSourceUrl(input.url, ctx);
      const result = await call("/_decopilot_vm/write_from_url", {
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
      await call("/_decopilot_vm/upload_to_url", {
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
    copy_to_sandbox,
    share_with_user,
  };
}
