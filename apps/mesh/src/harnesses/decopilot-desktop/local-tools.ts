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
  branch?: string | null;
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
  const controlUrl =
    process.env.DESKTOP_SANDBOX_CONTROL_URL ??
    process.env.SANDBOX_CONTROL_URL ??
    "";
  let sandboxApiUrl = `http://127.0.0.1:${port}`;
  const defaultHandle = process.env.SANDBOX_HANDLE ?? "local";

  return {
    kind: "user-desktop",
    ensure: async () => {
      if (!controlUrl) {
        return {
          handle: defaultHandle,
          workdir: process.cwd(),
          previewUrl: null,
        };
      }
      const res = await fetch(`${controlUrl}/api/sandboxes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: defaultHandle }),
      });
      if (!res.ok) {
        throw new Error(`local sandbox ensure failed (${res.status})`);
      }
      const body = (await res.json()) as {
        sandboxApiUrl?: unknown;
        previewUrl?: unknown;
      };
      if (typeof body.sandboxApiUrl !== "string") {
        throw new Error("local sandbox ensure did not return sandboxApiUrl");
      }
      sandboxApiUrl = body.sandboxApiUrl;
      return {
        handle: defaultHandle,
        workdir: sandboxApiUrl,
        previewUrl:
          typeof body.previewUrl === "string" ? body.previewUrl : sandboxApiUrl,
      };
    },
    delete: async (handle) => {
      if (!controlUrl) return;
      await fetch(`${controlUrl}/api/sandboxes/${encodeURIComponent(handle)}`, {
        method: "DELETE",
      }).catch(() => {});
    },
    alive: async () => true,
    getPreviewUrl: async () => null,
    watchClaimLifecycle: async function* () {
      yield { kind: "ready" as const };
    },
    proxyDaemonRequest: async (handle, path, init) => {
      const headers = new Headers(init.headers);
      if (token) headers.set("authorization", `Bearer ${token}`);
      const target = controlUrl
        ? `${controlUrl}/_sandbox/${encodeURIComponent(handle)}${path.startsWith("/_sandbox/") ? path.slice("/_sandbox".length) : path}`
        : `${sandboxApiUrl}${path}`;
      return fetch(target, {
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
  const runner = params.runner ?? createDesktopLocalSandboxProvider();
  let cachedHandle: Promise<string> | null = null;
  const ensureHandle = () => {
    if (!cachedHandle) {
      cachedHandle = runner
        .ensure(
          {
            userId: params.ctx.auth?.user?.id ?? "desktop",
            projectRef: params.virtualMcpId,
          },
          params.branch ? { branch: params.branch } : undefined,
        )
        .then((sandbox) => sandbox.handle);
      cachedHandle.catch(() => {
        cachedHandle = null;
      });
    }
    return cachedHandle;
  };
  const vmTools = createVmTools({
    runner,
    ensureHandle,
    invalidateHandle: async () => {
      const handlePromise = cachedHandle;
      cachedHandle = null;
      if (!handlePromise) return;
      const handle = await handlePromise.catch(() => null);
      if (handle) await runner.delete(handle);
    },
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
