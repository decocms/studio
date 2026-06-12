/**
 * Desktop built-in tool adapter.
 *
 * The implementation lives in the shared Decopilot portable built-ins module;
 * this file only preserves the desktop harness import boundary and parameter
 * names.
 */

import type { Tool, ToolSet, UIMessageStreamWriter } from "ai";
import { buildPortableBuiltInTools } from "./built-in-tools/portable-built-ins";
import type {
  PortableImageModelInfo,
  PortableImageProvider,
} from "./built-in-tools/portable-media-tools";
import type { VirtualClient } from "./built-in-tools/sandbox";
import { createVmTools } from "./built-in-tools/vm-tools/index";
import type { PendingImage } from "./built-in-tools/vm-tools/types";
import type { SandboxFsHooks } from "./built-in-tools/vm-tools/sandbox-fs-hooks-types";
import type { HtmlPageBuffer } from "./built-in-tools/vm-tools/html-page-buffer-core";
import type { ToolApprovalLevel } from "./mcp-tools";
import type { DesktopToolCtx } from "./desktop-tool-ctx";

export interface BuildLocalToolsParams {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  toolApprovalLevel: ToolApprovalLevel;
  isPlanMode: boolean;
  ctx: DesktopToolCtx;
  pendingImages: PendingImage[];
  threadId: string;
  virtualMcpId: string;
  /**
   * Flat sandbox filesystem hooks the VM tools run over. Built by the desktop
   * glue (`buildDesktopSandboxFs`, which owns the `@decocms/sandbox` provider)
   * and injected here so this assembler stays sandbox-free (spec §4.3).
   */
  fs: SandboxFsHooks;
  imageProvider?: PortableImageProvider;
  imageModelInfo?: PortableImageModelInfo;
  htmlPageBuffer?: HtmlPageBuffer;
  /** The real desktop-local `subtask` tool (built by the harness factory from
   *  `createLocalSubtaskTool` + the daemon `runSubtask`). Injected here so it
   *  joins the desktop toolset alongside the VM + portable built-ins. Absent on
   *  delegated subtask runs (depth-1 — the core strips it anyway). */
  subtask?: Tool;
}

function createNoopHtmlPageBuffer(): HtmlPageBuffer {
  return {
    enqueue: () => null,
    flush: async () => {},
  };
}

export function buildLocalTools(params: BuildLocalToolsParams): ToolSet {
  const portableTools = buildPortableBuiltInTools({
    writer: params.writer,
    toolOutputMap: params.toolOutputMap,
    passthroughClient: params.passthroughClient,
    toolApprovalLevel: params.toolApprovalLevel,
    isPlanMode: params.isPlanMode,
    objectStorage: params.ctx.objectStorage,
    includeUnavailableClusterOnlyTools: true,
    pendingImages: params.pendingImages,
    imageTool:
      params.imageProvider && params.imageModelInfo
        ? {
            provider: params.imageProvider,
            imageModelInfo: params.imageModelInfo,
          }
        : undefined,
  });

  const vmNeedsApproval =
    params.isPlanMode || params.toolApprovalLevel !== "auto";
  const vmTools = createVmTools({
    fs: params.fs,
    htmlPageBuffer: params.htmlPageBuffer ?? createNoopHtmlPageBuffer(),
    toolOutputMap: params.toolOutputMap,
    needsApproval: vmNeedsApproval,
    pendingImages: params.pendingImages,
    ctx: params.ctx as never,
    threadId: params.threadId,
    virtualMcpId: params.virtualMcpId,
  });

  return {
    ...portableTools,
    ...vmTools,
    // Real desktop-local subtask (self + cross-agent) — runs the shared core
    // in-process via spawnSubtask. Absent on delegated subtask runs (depth-1).
    ...(params.subtask ? { subtask: params.subtask } : {}),
  };
}
