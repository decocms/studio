/**
 * Serving `sandbox-api` from a process that holds an `AgentSandboxProvider`.
 * Framework-free: the host wraps each tool in its own tool type and its own
 * authorization, and mounts the watch response on its own router.
 */

import type { z } from "zod";
import { ConfigRequestError } from "../daemon-client";
import type { AgentSandboxProvider } from "./agent-sandbox";
import type { PushedCredentials } from "./pushed-credentials";
import type { EnsureOptions } from "./types";
import {
  capacityOutputSchema,
  credentialsPushInputSchema,
  credentialsPushOutputSchema,
  emptySchema,
  ensureInputSchema,
  ensureOutputSchema,
  handleInputSchema,
  lifetimeInputSchema,
  listOutputSchema,
  SANDBOX_LIST_MAX,
  SANDBOX_LIST_POOLS_MAX,
  SANDBOX_LIST_POOL_REPOS_MAX,
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
  | "listSandboxes"
  | "listTenantPools"
>;

export {
  PushedCredentials,
  pushedCredentialOptions,
} from "./pushed-credentials";

/**
 * `provider` is read per call, so a host can build it lazily. `credentials`
 * is the store the provider's mint hooks read (`pushedCredentialOptions`):
 * ensure seeds it, and Studio's pushes refresh it.
 */
export function sandboxTools(
  provider: () => Provider,
  credentials: PushedCredentials,
): SandboxToolDefinition[] {
  return [
    tool({
      id: SANDBOX_TOOLS.ensure,
      description:
        "Provision (or resume) a user's sandbox and wait until its daemon is ready. Returns the handle and the daemon's address and bearer.",
      inputSchema: ensureInputSchema,
      outputSchema: ensureOutputSchema,
      execute: async ({ id, opts, credentialsValidUntil }) => {
        // The wire type drops `image`; nothing else differs.
        const ensureOpts: EnsureOptions = opts;
        credentials.seed(ensureOpts, credentialsValidUntil);
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
      execute: async ({ repoUrl, ref }) => ({
        pools: await provider().markTenantPoolsDirty(repoUrl, ref),
      }),
    }),
    tool({
      id: SANDBOX_TOOLS.credentialsPush,
      description:
        "Store fresh clone credentials and org-fs configs, in memory, for the sandboxes' re-mints.",
      inputSchema: credentialsPushInputSchema,
      outputSchema: credentialsPushOutputSchema,
      execute: async (batch) => credentials.push(batch),
    }),
    tool({
      id: SANDBOX_TOOLS.list,
      description:
        "The live sandboxes' tenants and repos, and the tenant pools, without credentials, for Studio's credential push.",
      inputSchema: emptySchema,
      outputSchema: listOutputSchema,
      execute: async () => ({
        sandboxes: provider()
          .listSandboxes()
          .slice(0, SANDBOX_LIST_MAX)
          .map((sandbox) => ({
            ...sandbox,
            orgFsConfigExpiresAt: sandbox.tenant
              ? credentials.orgFsConfigExpiresAt(sandbox.tenant)
              : null,
          })),
        pools: provider()
          .listTenantPools()
          .slice(0, SANDBOX_LIST_POOLS_MAX)
          .map(({ name, tenant, image, repos }) => ({
            name,
            tenant,
            image,
            repos: repos
              .slice(0, SANDBOX_LIST_POOL_REPOS_MAX)
              .map(({ repoUrl, branch }) => ({ repoUrl, branch })),
          })),
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
