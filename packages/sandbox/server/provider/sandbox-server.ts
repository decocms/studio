/**
 * Serving `sandbox-api` from a process that holds an `AgentSandboxProvider`.
 * Framework-free: the host wraps each tool in its own tool type and its own
 * authorization, and mounts the watch response on its own router.
 */

import type { z } from "zod";
import { ConfigRequestError } from "../daemon-client";
import type { AgentSandboxProvider } from "./agent-sandbox";
import type { MintScope } from "./agent-sandbox/runner";
import type { EnsureOptions } from "./types";
import {
  capacityOutputSchema,
  cloneUrlResponseSchema,
  emptySchema,
  ensureInputSchema,
  ensureOutputSchema,
  handleInputSchema,
  lifetimeInputSchema,
  orgFsConfigResponseSchema,
  SANDBOX_CALLBACK_PATHS,
  SANDBOX_TOOLS,
  SANDBOX_WATCH_KEEPALIVE_MS,
  statusInputSchema,
  statusOutputSchema,
  tenantPoolsPushInputSchema,
  tenantPoolsPushOutputSchema,
  type ToolError,
} from "./sandbox-api";

export interface SandboxToolDefinition<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  id: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  execute(input: z.infer<I>): Promise<z.infer<O>>;
}

/** The error and its causes: a remote caller sees nothing else. */
function messageChain(err: unknown): string {
  const parts: string[] = [];
  for (let e = err, depth = 0; e && depth < 5; depth++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return parts.join(": ");
}

function tool<I extends z.ZodType, O extends z.ZodType>(
  def: SandboxToolDefinition<I, O>,
): SandboxToolDefinition<I, O> {
  return {
    ...def,
    // A thrown message is all an MCP error carries, so it carries JSON.
    execute: (input) =>
      def.execute(input).catch((err: unknown) => {
        const body: ToolError =
          err instanceof ConfigRequestError
            ? {
                code: "bootstrap-rejected",
                error: err.message,
                status: err.status,
              }
            : { code: "internal", error: messageChain(err) };
        throw new Error(JSON.stringify(body));
      }),
  };
}

type Provider = Pick<
  AgentSandboxProvider,
  | "ensure"
  | "delete"
  | "alive"
  | "getPreviewUrl"
  | "lastTermination"
  | "daemonEndpoint"
  | "renewTtl"
  | "releaseAfter"
  | "hasSchedulableCapacity"
  | "markTenantPoolsDirty"
>;

/** `provider` is read per call, so a host can build it lazily. */
export function sandboxTools(
  provider: () => Provider,
): SandboxToolDefinition[] {
  return [
    tool({
      id: SANDBOX_TOOLS.ensure,
      description:
        "Provision (or resume) a user's sandbox and wait until its daemon is ready. Returns the handle and the daemon's address and bearer.",
      inputSchema: ensureInputSchema,
      outputSchema: ensureOutputSchema,
      execute: async ({ id, opts }) => {
        // The wire type drops `image`; nothing else differs.
        const ensureOpts: EnsureOptions = opts;
        const sandbox = await provider().ensure(id, ensureOpts);
        const daemon = await provider().daemonEndpoint(sandbox.handle);
        if (!daemon) {
          throw new Error(`sandbox ${sandbox.handle} vanished after ensure`);
        }
        return { ...sandbox, daemon };
      },
    }),
    tool({
      id: SANDBOX_TOOLS.status,
      description:
        "A sandbox's liveness, preview URL, daemon address and last pod termination.",
      inputSchema: statusInputSchema,
      outputSchema: statusOutputSchema,
      execute: async ({ handle, resurrect }) => {
        const alive = await provider().alive(handle);
        const daemon =
          alive || resurrect ? await provider().daemonEndpoint(handle) : null;
        const [previewUrl, lastTermination] = await Promise.all([
          daemon ? provider().getPreviewUrl(handle) : null,
          provider().lastTermination(handle),
        ]);
        return {
          alive: daemon !== null,
          previewUrl,
          daemon,
          lastTermination,
        };
      },
    }),
    tool({
      id: SANDBOX_TOOLS.delete,
      description: "Delete a sandbox's claim and state.",
      inputSchema: handleInputSchema,
      outputSchema: emptySchema,
      execute: async ({ handle }) => {
        await provider().delete(handle);
        return {};
      },
    }),
    tool({
      id: SANDBOX_TOOLS.lifetime,
      description: "Renew a sandbox's idle TTL, or release it after `graceMs`.",
      inputSchema: lifetimeInputSchema,
      outputSchema: emptySchema,
      execute: async (input) => {
        if (input.graceMs === undefined)
          await provider().renewTtl(input.handle);
        else await provider().releaseAfter(input.handle, input.graceMs);
        return {};
      },
    }),
    tool({
      id: SANDBOX_TOOLS.capacity,
      description: "Whether the cluster can place another sandbox now.",
      inputSchema: emptySchema,
      outputSchema: capacityOutputSchema,
      execute: async () => ({
        schedulable: await provider().hasSchedulableCapacity(),
      }),
    }),
    tool({
      id: SANDBOX_TOOLS.tenantPoolsPush,
      description:
        "Refresh the tenant warm pools serving a repo and branch after a push.",
      inputSchema: tenantPoolsPushInputSchema,
      outputSchema: tenantPoolsPushOutputSchema,
      execute: async ({ repo, ref }) => ({
        pools: await provider().markTenantPoolsDirty(repo, ref),
      }),
    }),
  ];
}

/**
 * The watch route's body: one `data:` line per phase, closed after the
 * terminal one, with keepalive comments in between.
 */
export function sandboxWatchResponse(
  provider: Pick<AgentSandboxProvider, "watchClaimLifecycle">,
  handle: string,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          /* the client went away; the abort ends the loop */
        }
      };
      // Also flushes the headers before the first phase.
      send(": connected\n\n");
      keepalive = setInterval(
        () => send(": keepalive\n\n"),
        SANDBOX_WATCH_KEEPALIVE_MS,
      );
      try {
        for await (const phase of provider.watchClaimLifecycle(
          handle,
          signal,
        )) {
          send(`data: ${JSON.stringify(phase)}\n\n`);
        }
      } catch (err) {
        if (!signal.aborted) {
          const message = err instanceof Error ? err.message : String(err);
          send(
            `data: ${JSON.stringify({ kind: "failed", reason: "unknown", message })}\n\n`,
          );
        }
      } finally {
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already cancelled */
        }
      }
    },
    cancel() {
      clearInterval(keepalive);
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}

const CALLBACK_TIMEOUT_MS = 30_000;

/**
 * `mintCloneUrl` / `mintOrgFsConfig` for a host outside Studio: both ask the
 * Studio at `studioUrl`. Best-effort like the in-process minters: a failure
 * logs and answers null, so the runner keeps the credential it has.
 */
export function studioCredentialMinters(opts: {
  studioUrl: string;
  token: string;
}) {
  const post = async <T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T | null> => {
    try {
      const res = await fetch(new URL(path, opts.studioUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      return schema.parse(await res.json());
    } catch (err) {
      console.warn(
        `[sandbox] Studio callback ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
  return {
    mintCloneUrl: async (
      repo: NonNullable<EnsureOptions["repo"]>,
      mintOpts?: MintScope & { bufferMs?: number },
    ) =>
      (
        await post(
          SANDBOX_CALLBACK_PATHS.cloneUrl,
          {
            cloneUrl: repo.cloneUrl,
            connectionId: repo.connectionId,
            repositoryId: repo.repositoryId,
            tenant: mintOpts?.tenant,
            bufferMs: mintOpts?.bufferMs,
            grant: mintOpts?.callbackGrant,
          },
          cloneUrlResponseSchema,
        )
      )?.cloneUrl ?? null,
    mintOrgFsConfig: async (
      tenant: NonNullable<EnsureOptions["tenant"]>,
      mintOpts?: Pick<MintScope, "callbackGrant">,
    ) =>
      (
        await post(
          SANDBOX_CALLBACK_PATHS.orgFsConfig,
          { tenant, grant: mintOpts?.callbackGrant },
          orgFsConfigResponseSchema,
        )
      )?.orgFsConfigJson ?? null,
  };
}
