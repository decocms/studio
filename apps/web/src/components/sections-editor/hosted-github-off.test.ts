/**
 * A v8 project on the hosted CMS with GitHub off: opening the editor, its
 * probe, a read, a save and Publish only call `/api/cms/:site/...`, never
 * the git-backed `/decofile/` routes nor a sandbox's `/git/*`. `fetch` is
 * the global one, mocked: everything the editor sends goes through it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "@decocms/blocks/protocol";
import { QueryClient } from "@tanstack/react-query";
import { publishHostedDraft } from "@/components/thread/repository/hosted-publish-api";
import { cmsDraftRpcEndpoint, ensureCmsDraft } from "@/cms/cms-api";
import type { ProtocolBackend } from "./content-backend";
import {
  applyProtocolPatch,
  pollProtocolContent,
} from "@/cms/content-protocol-api";
import { probeHosted } from "@/cms/use-content-backend";

const ORIGIN = "http://studio.test";
const SITE = "acme";
const BRANCH = "threads/t-1";
const seen: string[] = [];
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

type Call = { id: number; method: string };

/** The hosted CMS as Studio serves it: one draft, JSON-RPC on its rpc route. */
function cms(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), ORIGIN), init);
  const path = new URL(request.url).pathname;
  seen.push(`${request.method} ${path}`);
  const base = `/api/cms/${SITE}/drafts`;
  if (request.method === "POST" && path === base) {
    return Promise.resolve(
      Response.json({
        name: BRANCH,
        slug: "d1",
        createdBy: "usr_ana",
        via: "studio",
        createdAt: "2026-11-04T00:00:00.000Z",
        etag: "e1",
        pointer: `delivery.test/sites/${SITE}/drafts/d1/index.json@e1`,
        previewUrl: null,
      }),
    );
  }
  if (path === `${base}/${encodeURIComponent(BRANCH)}/publish`) {
    return Promise.resolve(
      Response.json({ result: "published", revision: "r2", previous: "r1" }),
    );
  }
  if (path === `${base}/${encodeURIComponent(BRANCH)}/rpc`) {
    return request.json().then((body: Call | Call[]) => {
      const answer = (call: Call) => ({
        jsonrpc: "2.0",
        id: call.id,
        result:
          call.method === "describe"
            ? {
                protocol: PROTOCOL_NAME,
                version: PROTOCOL_VERSION,
                pollIntervalMs: 0,
              }
            : call.method === "schema.get"
              ? {
                  notModified: false,
                  version: "s1",
                  resolvedRef: null,
                  schema: { blocksMajor: 8, definitions: {}, root: {} },
                }
              : call.method === "blocks.list"
                ? {
                    notModified: false,
                    revision: "e1",
                    resolvedRef: null,
                    blocks: { home: { title: "Hi" } },
                    versions: { home: "v1" },
                    diagnostics: [],
                  }
                : call.method === "blocks.apply"
                  ? { revision: "e2", versions: { home: "v2" } }
                  : { changes: [] },
      });
      return Response.json(
        Array.isArray(body) ? body.map(answer) : answer(body),
      );
    });
  }
  return Promise.resolve(new Response("not the CMS", { status: 599 }));
}

beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {
    location: { origin: ORIGIN },
  };
  globalThis.fetch = Object.assign(cms, {
    preconnect: () => {},
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

describe("a v8 project on the hosted CMS, GitHub off", () => {
  it("opens, probes, reads, saves and publishes through /api/cms/:site only", async () => {
    const queryClient = new QueryClient();
    const params = {
      orgSlug: "acme-org",
      virtualMcpId: "vmcp_1",
      branch: BRANCH,
    };

    const probed = await probeHosted(cmsDraftRpcEndpoint(SITE, BRANCH), () =>
      ensureCmsDraft(SITE, BRANCH),
    );
    if (!probed || typeof probed !== "object") throw new Error("not v8");
    const backend: ProtocolBackend = {
      kind: "protocol",
      source: "github",
      client: probed.client,
      describe: probed.describe,
      cacheKeySuffix: "",
      hasSchema: probed.hasSchema,
      site: SITE,
    };
    const read = await pollProtocolContent(queryClient, backend, params, "k");
    expect(read.blocks).toEqual({ home: { title: "Hi" } });
    await applyProtocolPatch(
      queryClient,
      backend,
      params,
      "k",
      { set: { home: { title: "Hello" } } },
      { home: "v1" },
    );
    expect(
      await publishHostedDraft(
        { orgSlug: params.orgSlug, site: SITE, branch: BRANCH },
        "",
      ),
    ).toBeDefined();

    expect(seen).toContain(`POST /api/cms/${SITE}/drafts`);
    expect(seen).toContain(
      `POST /api/cms/${SITE}/drafts/${encodeURIComponent(BRANCH)}/publish`,
    );
    for (const call of seen) {
      expect(call).toMatch(
        new RegExp(`^(GET|POST|PUT|DELETE) /api/cms/${SITE}/`),
      );
      expect(call).not.toContain("/decofile/");
      expect(call).not.toMatch(/\/sandbox\/.*\/git\//);
    }
  });
});
