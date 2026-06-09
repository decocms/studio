/**
 * Desktop built-in tool adapter.
 *
 * The implementation lives in the shared Decopilot portable built-ins module;
 * this file only preserves the desktop harness import boundary and parameter
 * names.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import {
  buildPortableBuiltInTools,
  type PortableSubtaskModels,
} from "../decopilot/built-in-tools/portable-built-ins";
import type { VirtualClient } from "../decopilot/built-in-tools/sandbox";
import { createVmTools } from "../decopilot/built-in-tools/vm-tools";
import type {
  HtmlPageBuffer,
  PendingImage,
} from "../decopilot/built-in-tools/vm-tools/types";
import type { ToolApprovalLevel } from "../decopilot/mcp-tools";
import type { DesktopToolCtx } from "./types";

export interface DesktopSubtaskModels extends PortableSubtaskModels {}

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
  mcpClient?: Client;
  models?: DesktopSubtaskModels;
  selfAgentId?: string;
  runner?: SandboxProvider;
  htmlPageBuffer?: HtmlPageBuffer;
}

export function createDesktopLocalSandboxProvider(): SandboxProvider {
  const port = Number(
    process.env.DAEMON_PORT ?? process.env.PROXY_PORT ?? 9000,
  );
  const token = process.env.DAEMON_TOKEN ?? "";

  return {
    kind: "user-desktop",
    ensure: async () => ({
      handle: "local",
      workdir: process.cwd(),
      previewUrl: null,
    }),
    delete: async () => {},
    alive: async () => true,
    getPreviewUrl: async () => null,
    watchClaimLifecycle: async function* () {
      yield { kind: "ready" as const };
    },
    proxyDaemonRequest: async (_handle, path, init) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      return fetch(`http://127.0.0.1:${port}${path}`, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal,
      });
    },
  };
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
    subtaskRelay:
      params.mcpClient && params.models && params.selfAgentId
        ? {
            mcpClient: params.mcpClient,
            models: params.models,
            selfAgentId: params.selfAgentId,
          }
        : undefined,
  });

  const vmNeedsApproval =
    params.isPlanMode || params.toolApprovalLevel !== "auto";
  const vmTools = createVmTools({
    runner: params.runner ?? createDesktopLocalSandboxProvider(),
    ensureHandle: async () => "local",
    invalidateHandle: async () => {},
    canAutoRestart: false,
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
  };
}
