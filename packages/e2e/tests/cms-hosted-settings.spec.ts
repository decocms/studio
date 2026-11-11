import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  setBlocksV8Site,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

const schema = {
  blocksMajor: 8,
  manifest: {
    blocks: {
      content: {
        "cms-settings": {
          $ref: "#/definitions/Y21zLXNldHRpbmdz",
          namespace: "deco",
        },
      },
      pages: { page: { $ref: "#/definitions/cGFnZQ==" } },
    },
  },
  schema: {
    definitions: {
      Y21zLXNldHRpbmdz: {
        type: "object",
        properties: {
          __resolveType: {
            type: "string",
            enum: ["cms-settings"],
            default: "cms-settings",
          },
          telemetry: {
            type: "object",
            properties: { enabled: { type: "boolean", default: true } },
          },
        },
      },
      "cGFnZQ==": {
        type: "object",
        properties: {
          __resolveType: { type: "string", enum: ["page"] },
          path: { type: "string" },
          name: { type: "string" },
          sections: { type: "array", items: {} },
        },
      },
    },
  },
};

async function rpc(
  api: APIRequestContext,
  site: string,
  method: string,
  params: object,
) {
  const response = await api.post(`/api/cms/${site}/drafts/draft/rpc`, {
    data: { jsonrpc: "2.0", id: 1, method, params },
  });
  expect(response.ok()).toBe(true);
  const answer = await response.json();
  expect(answer.error).toBeUndefined();
  return answer.result;
}

for (const saved of [true, false]) {
  test(`hosted Settings ${saved ? "loads the existing body" : "creates an absent block"} before saving`, async ({
    authedPage: { page, orgSlug },
  }) => {
    test.slow();
    const api = page.request;
    const site = uniqueOwner();
    const project = await createFastPreviewProject(api, orgSlug, {
      owner: site,
      repo: "site",
      siteSlug: site,
      connectionUrl: "http://127.0.0.1:1/unused",
    });
    await setBlocksV8Site(api, orgSlug, project.vmcpId, true);
    expect(
      (await api.put(`/api/cms/${site}/schema`, { data: schema })).ok(),
    ).toBe(true);
    expect(
      (
        await api.post(`/api/cms/${site}/drafts`, { data: { name: "draft" } })
      ).ok(),
    ).toBe(true);
    const original = {
      __resolveType: "cms-settings",
      telemetry: { enabled: true, metrics: false, errorSampleRate: 0.17 },
      analytics: {
        enabled: false,
        collector: "https://collector.example.test",
      },
      preview: { hosts: ["preview.example.test"] },
    };
    await rpc(api, site, "blocks.apply", {
      set: {
        home: { __resolveType: "page", path: "/", name: "Home", sections: [] },
        ...(saved ? { CMS: original } : {}),
      },
      ifMatch: { home: null, ...(saved ? { CMS: null } : {}) },
    });
    const { item: thread } = await callSelfMcpTool<{
      item: { id: string; branch: string };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: project.vmcpId, branch: "draft" },
    });
    expect(thread.branch).toBe("draft");
    const requestedBodies: string[] = [];
    page.on("request", (request) => {
      if (
        !request.url().includes(`/api/cms/${site}/`) ||
        !request.url().endsWith("/rpc")
      )
        return;
      const data = request.postDataJSON();
      for (const call of Array.isArray(data) ? data : [data]) {
        if (call.method === "cms.blocks")
          requestedBodies.push(...call.params.names);
      }
    });
    await page.goto(
      `/${orgSlug}/projects/${project.vmcpId}/site-editor/content?thread=${thread.id}&sidepanel=false`,
    );
    await page
      .getByTestId("main-panel")
      .getByRole("button", { name: "Settings", exact: true })
      .click({ timeout: 60_000 });
    const settings = page.getByTestId("cms-settings-page");
    const enabled = settings.getByRole("switch", {
      name: "Send telemetry",
      exact: true,
    });
    await expect(enabled).toBeChecked();
    if (saved) {
      expect(requestedBodies).toContain("CMS");
      await expect(
        settings.getByRole("switch", { name: "Metrics", exact: true }),
      ).not.toBeChecked();
    }
    await enabled.click();
    const expected = saved
      ? { ...original, telemetry: { ...original.telemetry, enabled: false } }
      : { __resolveType: "cms-settings", telemetry: { enabled: false } };
    await expect
      .poll(
        async () => {
          const result = await rpc(api, site, "cms.blocks", { names: ["CMS"] });
          return result.blocks.CMS;
        },
        { timeout: 15_000 },
      )
      .toEqual(expected);
    await page.reload();
    await page
      .getByTestId("main-panel")
      .getByRole("button", { name: "Settings", exact: true })
      .click({ timeout: 60_000 });
    await expect(
      page
        .getByTestId("cms-settings-page")
        .getByRole("switch", { name: "Send telemetry", exact: true }),
    ).not.toBeChecked();
  });
}
