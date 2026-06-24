import type { NatsConnection } from "@nats-io/nats-core";
import type { WorkItem } from "../links/link-work-item";
import type { DirectNatsPublisher } from "./direct-nats-publisher";
import {
  handleLocalDispatch,
  relayWorkItemFailure,
} from "./handle-local-dispatch";
import type { Outbox } from "./outbox";
import * as runAbortRegistry from "./run-abort-registry";
import type { DesktopSandboxProvider } from "./user-desktop-provider";

export interface LinkWorkItemDispatchInput {
  clusterBaseUrl: string;
  getAccessToken: () => Promise<string>;
  provider: DesktopSandboxProvider;
  fetchImpl?: typeof fetch;
  outbox: Outbox;
  getNatsConnection?: () => NatsConnection | null;
  /** Test seam threaded through to both relay paths. */
  relayPublisher?: DirectNatsPublisher;
}

function deriveHandle(item: WorkItem): string {
  if (item.sandbox?.handle) return item.sandbox.handle;
  const input = item.harnessInput as Record<string, unknown>;
  const agent = input.agent as Record<string, unknown> | undefined;
  const agentId =
    typeof agent?.id === "string" && agent.id.length > 0 ? agent.id : "unknown";
  const branch =
    typeof input.branch === "string" && input.branch.length > 0
      ? input.branch
      : null;
  return branch ? `agent-${agentId}-${branch}` : `agent-${agentId}`;
}

async function relayClaimedWorkItemFailure(
  input: LinkWorkItemDispatchInput,
  item: WorkItem,
  code: string,
  message: string,
): Promise<void> {
  await relayWorkItemFailure(
    item,
    {
      getNatsConnection: input.getNatsConnection!,
      relayPublisher: input.relayPublisher,
    },
    code,
    message,
  );
}

export async function dispatchLinkWorkItem(
  input: LinkWorkItemDispatchInput,
  signal: AbortSignal,
  item: WorkItem,
): Promise<void> {
  const handle = deriveHandle(item);
  console.log(
    `[link-work] work item runId=${item.runId} threadId=${item.threadId} handle=${handle}`,
  );

  // Early guard: a live NATS connection must exist at dispatch time. The relay
  // paths re-source the connection PER publish attempt via the GETTER (not this
  // captured value), so an in-flight run survives a tunnel-session renewal that
  // recycles the connection.
  if (!(input.getNatsConnection?.() ?? null)) {
    throw new Error(
      "[link-work] NATS connection unavailable for direct relay publish",
    );
  }

  const mcp = (item.harnessInput as { mcp?: { expiresAt?: number } }).mcp;
  if (typeof mcp?.expiresAt === "number" && mcp.expiresAt <= Date.now()) {
    console.warn(
      `[link-work] work item expired at claim time — relaying failure runId=${item.runId}`,
    );
    await relayWorkItemFailure(
      item,
      {
        getNatsConnection: input.getNatsConnection!,
        relayPublisher: input.relayPublisher,
      },
      "work_item_expired",
      "work item credentials expired before the daemon claimed it — send the message again",
    );
    return;
  }

  const ensureInput = item.sandbox
    ? {
        handle,
        ...(item.sandbox.repo ? { repo: item.sandbox.repo } : {}),
        ...(item.sandbox.workload ? { workload: item.sandbox.workload } : {}),
        ...(item.sandbox.operator ? { operator: item.sandbox.operator } : {}),
        ...(item.sandbox.offloadAllowedHosts !== undefined
          ? { offloadAllowedHosts: item.sandbox.offloadAllowedHosts }
          : {}),
        ...(item.sandbox.offloadAllowSameHostDev !== undefined
          ? {
              offloadAllowSameHostDev: item.sandbox.offloadAllowSameHostDev,
            }
          : {}),
        ...(item.sandbox.orgFsConfigJson !== undefined
          ? { orgFsConfigJson: item.sandbox.orgFsConfigJson }
          : {}),
      }
    : { handle };
  let sandboxApiUrl: string;
  let sandboxDaemonToken: string;
  try {
    const sandbox = await input.provider.ensureSandbox(ensureInput);
    sandboxApiUrl = sandbox.sandboxApiUrl;
    sandboxDaemonToken =
      input.provider.getDaemonToken(handle) ??
      (() => {
        throw new Error(`[link-work] no daemon token for handle=${handle}`);
      })();
  } catch (err) {
    console.error(
      `[link-work] ensureSandbox failed handle=${handle} runId=${item.runId}:`,
      err,
    );
    await relayClaimedWorkItemFailure(
      input,
      item,
      "sandbox_start_failed",
      "desktop sandbox failed to start for this run; send the message again",
    );
    return;
  }

  const releaseDispatch = input.provider.acquireDispatch(handle);
  const runAc = runAbortRegistry.register(item.runId);
  try {
    await handleLocalDispatch(item, {
      sandboxDispatchUrl: sandboxApiUrl,
      sandboxDaemonToken,
      fetchImpl: input.fetchImpl,
      signal: AbortSignal.any([signal, runAc.signal]),
      outbox: input.outbox,
      getNatsConnection: input.getNatsConnection!,
      relayPublisher: input.relayPublisher,
    });
  } catch (err) {
    console.error(
      `[link-work] local dispatch failed handle=${handle} runId=${item.runId}:`,
      err,
    );
    await relayClaimedWorkItemFailure(
      input,
      item,
      "local_dispatch_failed",
      "desktop harness dispatch failed before producing a terminal result; send the message again",
    );
    return;
  } finally {
    runAbortRegistry.unregister(item.runId);
    releaseDispatch();
  }

  console.log(`[link-work] dispatch complete runId=${item.runId}`);
}
