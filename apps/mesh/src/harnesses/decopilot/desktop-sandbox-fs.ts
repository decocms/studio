/**
 * DESKTOP sandbox-fs glue (option-b sandbox decoupling).
 *
 * Isolates the `@decocms/sandbox` imports (the `SandboxProvider` + the
 * `createSandboxFsHooks` builder) that the portable desktop tool assembler
 * (`desktop-local-tools.ts`) must NOT carry. Owns the local control-URL
 * `SandboxProvider` and the desktop fs-hook lifecycle (ensure / invalidate), and
 * returns the flat `SandboxFsHooks` the harness VM tools consume.
 *
 * ASSEMBLER-GLUE: stays `@decocms/sandbox`-coupled; slated to relocate into the
 * daemon assembler (`createDesktopContext`) in the package-move phase (spec
 * Phase 5).
 */

import {
  createSandboxFsHooks,
  type SandboxProvider,
} from "@decocms/sandbox/provider";
import type { SandboxFsHooks } from "./built-in-tools/vm-tools/sandbox-fs-hooks-types";

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

/**
 * Build the desktop flat fs hooks. `runner` defaults to the local control-URL
 * provider; tests inject a fake. The lazy `ensureHandle` memoises the first
 * `ensure` so later ops reuse the handle; `invalidateHandle` reaps it on
 * sandbox death. `userId` falls back to `"desktop"` (preserving the prior
 * inline `ctx.auth?.user?.id ?? "desktop"` behavior).
 */
export function buildDesktopSandboxFs(params: {
  runner?: SandboxProvider;
  virtualMcpId: string;
  branch?: string | null;
  userId?: string;
}): SandboxFsHooks {
  const runner = params.runner ?? createDesktopLocalSandboxProvider();
  let cachedHandle: Promise<string> | null = null;
  const ensureHandle = () => {
    if (!cachedHandle) {
      cachedHandle = runner
        .ensure(
          {
            userId: params.userId ?? "desktop",
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
  return createSandboxFsHooks(runner, {
    ensureHandle,
    invalidateHandle: async () => {
      const handlePromise = cachedHandle;
      cachedHandle = null;
      if (!handlePromise) return;
      const handle = await handlePromise.catch(() => null);
      if (handle) await runner.delete(handle);
    },
    canAutoRestart: false,
  });
}
