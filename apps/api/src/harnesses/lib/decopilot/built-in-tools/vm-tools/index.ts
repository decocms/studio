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
  SKILL_DESCRIPTION,
  SkillInputSchema,
  TOOL_APPROVAL,
  WRITE_DESCRIPTION,
  WriteInputSchema,
} from "./schemas";
import { resolveSkillPath } from "./skill-resolve";
import type { VmToolsParams } from "./types";

export type { VmToolsParams } from "./types";

export function createVmTools(params: VmToolsParams) {
  const {
    fs,
    htmlArtifactBuffer,
    toolOutputMap,
    needsApproval,
    pendingImages,
  } = params;
  const approvalFor = (mutating: boolean) => (mutating ? needsApproval : false);

  // Proxy an arbitrary `/_sandbox/*` route through the fs hooks' retry layer.
  // Used by the tools whose daemon surface the typed flat ops don't model
  // (image-read, html-buffer write/edit). `signal` is the run's abort signal
  // (ToolCallOptions.abortSignal) so cancelling the run aborts the daemon call.
  const call = (
    daemonPath: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> => fs.onProxy(daemonPath, input, method, signal);

  const read = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.read),
    description: READ_DESCRIPTION,
    inputSchema: zodSchema(ReadInputSchema),
    execute: async (input, options) => {
      const result = (await call(
        "/_sandbox/read",
        input,
        options.abortSignal,
      )) as
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
    execute: async (input, options) => {
      const daemonResult = await call(
        "/_sandbox/write",
        input,
        options.abortSignal,
      );
      // Fast path: mirror `org/home/{decks,pages}/*.html` content into
      // org-fs server-side at step end (skips the mount's slow vfs write-back)
      // so the live-preview watcher sees the bytes in the same step.
      htmlArtifactBuffer?.enqueue(input.path, input.content);
      return daemonResult;
    },
  });

  const edit = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.edit),
    description: EDIT_DESCRIPTION,
    inputSchema: zodSchema(EditInputSchema),
    execute: async (input, options) => {
      const daemonResult = (await call(
        "/_sandbox/edit",
        input,
        options.abortSignal,
      )) as {
        ok: boolean;
        replacements: number;
        content?: string;
      };
      const postEditContent = daemonResult.content;
      const { content: _omit, ...resultForClient } = daemonResult;
      if (typeof postEditContent !== "string") return resultForClient;
      htmlArtifactBuffer?.enqueue(input.path, postEditContent);
      return resultForClient;
    },
  });

  const grep = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.grep),
    description: GREP_DESCRIPTION,
    inputSchema: zodSchema(GrepInputSchema),
    execute: async (input, options) => {
      const result = await call("/_sandbox/grep", input, options.abortSignal);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const glob = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.glob),
    description: GLOB_DESCRIPTION,
    inputSchema: zodSchema(GlobInputSchema),
    execute: async (input, options) => {
      const result = await call("/_sandbox/glob", input, options.abortSignal);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  const bash = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.bash),
    description: BASH_DESCRIPTION,
    inputSchema: zodSchema(BashInputSchema),
    execute: async (input, options) => {
      const result = await call("/_sandbox/bash", input, options.abortSignal);
      return maybeTruncate(result, toolOutputMap);
    },
  });

  // Progressive skill discovery: <available-skills> lists each skill's id +
  // description; this loads one skill's full SKILL.md on demand (read-only),
  // resolving the catalog id to its mounted path.
  const skill = tool({
    needsApproval: approvalFor(TOOL_APPROVAL.skill),
    description: SKILL_DESCRIPTION,
    inputSchema: zodSchema(SkillInputSchema),
    execute: async ({ id }, options) => {
      const path = resolveSkillPath(id);
      if (!path) {
        return {
          error: `Invalid skill id "${id}". Use an id from <available-skills>.`,
        };
      }
      try {
        const result = await call(
          "/_sandbox/read",
          { path },
          options.abortSignal,
        );
        return maybeTruncate(result, toolOutputMap);
      } catch {
        return {
          error: `Skill "${id}" not found. Use an id from <available-skills>.`,
        };
      }
    },
  });

  // org-fs is now the universal substrate: chat attachments arrive in
  // `org/upload/` (no copy_to_sandbox) and deliverables go to `org/output/`
  // surfaced via the thread-outputs chips (no share_with_user).
  return { read, write, edit, grep, glob, bash, skill };
}
