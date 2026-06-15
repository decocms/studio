/**
 * VM File Tools — runner-agnostic.
 *
 * Registers the six LLM-visible file tools (read/write/edit/grep/glob/bash)
 * on top of the injected `SandboxFsHooks`.
 * The hooks speak the unified `/_sandbox/*` surface with plain JSON bodies and
 * own the handle resolution + auto-restart retry layer, so this module never
 * imports the sandbox-provider package directly (cycle-break, spec §4.3).
 */

import { tool, zodSchema } from "ai";
import { maybeTruncate } from "./common";
import {
  BASH_DESCRIPTION,
  BashInputSchema,
  EDIT_DESCRIPTION,
  EditInputSchema,
  GLOB_DESCRIPTION,
  GREP_DESCRIPTION,
  GlobInputSchema,
  GrepInputSchema,
  READ_DESCRIPTION,
  ReadInputSchema,
  TOOL_APPROVAL,
  WRITE_DESCRIPTION,
  WriteInputSchema,
} from "./schemas";
import type { VmToolsParams } from "./types";

export type { VmToolsParams } from "./types";

export function createVmTools(params: VmToolsParams) {
  const {
    fs,
    htmlPageBuffer,
    deckBuffer,
    toolOutputMap,
    needsApproval,
    pendingImages,
  } = params;
  const approvalFor = (mutating: boolean) => (mutating ? needsApproval : false);

  // Proxy an arbitrary `/_sandbox/*` route through the fs hooks' retry layer.
  // Used by the tools whose daemon surface the typed flat ops don't model
  // (image-read, html-buffer write/edit).
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
    description: WRITE_DESCRIPTION,
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
    description: BASH_DESCRIPTION,
    inputSchema: zodSchema(BashInputSchema),
    execute: async (input) => {
      const result = await call("/_sandbox/bash", input);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  // org-fs is now the universal substrate: chat attachments arrive in
  // `org/upload/` (no copy_to_sandbox) and deliverables go to `org/output/`
  // surfaced via the thread-outputs chips (no share_with_user).
  return { read, write, edit, grep, glob, bash };
}
