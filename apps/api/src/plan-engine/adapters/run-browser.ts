/**
 * The browser of one diagnosis run: a sandbox of its own, owned by the member
 * who started the run, in the run's organization. Provisioned on first use in
 * any step and found again by its identity in the next; removed when the run
 * finishes or fails, and reaped by the sandbox's idle TTL otherwise.
 */

import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import {
  composeSandboxRef,
  computeHandle,
  type SandboxId,
} from "@decocms/sandbox/provider";
import type { StudioContext } from "@/core/studio-context";
import { getAgentSandboxProvider } from "@/sandbox/lifecycle";
import { agentSandboxEnabled } from "@/settings";
import {
  ensureOrRephrase,
  waitForSchedulableCapacity,
} from "@/tools/sandbox/start";
import type { BrowserPort, MediaStore } from "../ports.ts";
import type { SourceGap } from "../types.ts";
import { sandboxBrowser } from "./sandbox-browser.ts";
import { browserGap } from "./unavailable.ts";

/** The run's browser and where its captures go, or why it has none. */
export type RunBrowser =
  | { port: BrowserPort; media: MediaStore }
  | { gap: SourceGap };

export interface RunBrowserInput {
  ctx: StudioContext;
  orgId: string;
  userId: string;
  diagnosisId: string;
}

/** Stands where a virtual MCP id goes in the ref: no agent owns this sandbox. */
const PLAN_ENGINE_REF = "plan-engine";

/** One sandbox per diagnosis, keyed by the member and the organization. */
function browserSandboxId(input: {
  orgId: string;
  userId: string;
  diagnosisId: string;
}): SandboxId {
  return {
    userId: input.userId,
    projectRef: composeSandboxRef({
      orgId: input.orgId,
      virtualMcpId: PLAN_ENGINE_REF,
      branch: `plan-browser-${input.diagnosisId}`,
    }),
  };
}

/** The built-in engine on for the org, with hosted sandboxes and object storage here. */
async function browserEnabled(
  ctx: StudioContext,
  orgId: string,
): Promise<boolean> {
  if (!agentSandboxEnabled() || !ctx.objectStorage) return false;
  const settings = await ctx.storage.organizationSettings.get(orgId);
  return orgFlagEnabled(settings?.flags, "plan_engine_native");
}

export async function openRunBrowser(
  input: RunBrowserInput & { media: MediaStore | null },
): Promise<RunBrowser> {
  const { ctx, orgId, userId, media } = input;
  try {
    if (!media || !(await browserEnabled(ctx, orgId))) {
      return { gap: browserGap() };
    }
    const provider = await getAgentSandboxProvider(ctx);
    const id = browserSandboxId(input);
    await waitForSchedulableCapacity(provider);
    const sandbox = await ensureOrRephrase(provider, id, {
      purpose: "harness-run",
      cloneOnly: true,
      branch: `plan-browser-${input.diagnosisId}`,
      tenant: {
        orgId,
        userId,
        ...(ctx.organization?.slug ? { orgSlug: ctx.organization.slug } : {}),
        ...(ctx.organization?.name ? { orgName: ctx.organization.name } : {}),
      },
    });
    return {
      media,
      port: sandboxBrowser((path, body) =>
        provider.proxyDaemonRequest(sandbox.handle, path, {
          method: "POST",
          headers: new Headers({ "content-type": "application/json" }),
          body: JSON.stringify(body),
        }),
      ),
    };
  } catch (err) {
    return {
      gap: {
        source: "browser",
        error: `o navegador do sandbox não abriu: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

/** Best effort: a sandbox left behind is reaped by its idle TTL. */
export async function releaseRunBrowser(input: RunBrowserInput): Promise<void> {
  try {
    if (!(await browserEnabled(input.ctx, input.orgId))) return;
    const provider = await getAgentSandboxProvider(input.ctx);
    await provider.delete(computeHandle(browserSandboxId(input)));
  } catch (err) {
    console.warn(
      `[plan-engine] [${input.diagnosisId}] browser sandbox not released: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
