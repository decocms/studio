/**
 * The site editor on a developer's machine, over the local content-protocol
 * server: at `/site-editor` (the link `deco serve` prints, ungated and always
 * in the New Layout), account-less or signed in, and signed in through the
 * draft selector's "Local" option. Edits land in its
 * working tree through `blocks.apply`.
 *
 * `deco serve` is played by fixtures/deco-serve-stub.ts (the protocol's own
 * handler over its filesystem storage in a temporary working tree, on
 * 127.0.0.1 with no token).
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { publicKeyPemFromDer } from "@decocms/shared/secret-ciphertext";
import {
  type DecoServeStub,
  startDecoServeStub,
} from "../fixtures/deco-serve-stub";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { expect, getE2EAppOrigin, test } from "../fixtures/test";

/** A deco-meta@1 schema, as `deco schema` writes it, for one section type. */
const schema = {
  manifest: {
    blocks: {
      sections: { hero: { $ref: "#/definitions/aGVybw==" } },
      loaders: { lazy: { $ref: "#/definitions/bGF6eQ==" } },
    },
  },
  schema: {
    definitions: {
      "aGVybw==": {
        title: "hero",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: { type: "string", enum: ["hero"], default: "hero" },
          title: { type: "string", title: "Title" },
          teaser: {
            title: "Teaser",
            type: "object",
            required: ["__resolveType", "value"],
            properties: {
              __resolveType: {
                type: "string",
                enum: ["lazy"],
                default: "lazy",
              },
              value: { type: "string" },
            },
          },
          apiKey: {
            title: "API key",
            type: "object",
            format: "secret",
            writeOnly: true,
            required: ["__resolveType", "ciphertext"],
            properties: {
              __resolveType: {
                type: "string",
                enum: ["secret"],
                default: "secret",
              },
              ciphertext: { type: "string" },
            },
          },
        },
      },
      "bGF6eQ==": {
        title: "lazy",
        type: "object",
        properties: {
          __resolveType: { type: "string", enum: ["lazy"] },
          value: {},
        },
      },
    },
  },
};

/** The same schema from a framework with the CMS settings block type. */
const schemaWithSettings = {
  ...schema,
  manifest: {
    blocks: {
      ...schema.manifest.blocks,
      content: {
        "cms-settings": {
          $ref: "#/definitions/Y21zLXNldHRpbmdz",
          namespace: "deco",
        },
      },
    },
  },
  schema: {
    definitions: {
      ...schema.schema.definitions,
      Y21zLXNldHRpbmdz: {
        title: "cms-settings",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: {
            type: "string",
            enum: ["cms-settings"],
            default: "cms-settings",
          },
          preview: {
            type: "object",
            title: "Preview",
            properties: {
              hosts: {
                type: "array",
                title: "Hosts",
                items: { type: "string" },
              },
            },
          },
          telemetry: {
            type: "object",
            title: "Telemetry",
            properties: {
              enabled: { type: "boolean", title: "Enabled", default: true },
              metrics: { type: "boolean", title: "Metrics", default: true },
            },
          },
          analytics: {
            type: "object",
            title: "Analytics",
            properties: {
              collector: { type: "string", title: "Collector" },
              enabled: { type: "boolean", title: "Enabled", default: true },
            },
          },
        },
      },
    },
  },
};

const HERO = "home-hero";
const heroFile = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

async function generateKeyPair() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  return { privateKey: pair.privateKey, publicKey: publicKeyPemFromDer(spki) };
}

async function decryptSecret(privateKey: CryptoKey, ciphertext: string) {
  const [, key, iv, body] = ciphertext.split(".");
  const bytes = (part: string) =>
    new Uint8Array(Buffer.from(part, "base64url"));
  const raw = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    bytes(key!),
  );
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "decrypt",
  ]);
  return new TextDecoder().decode(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes(iv!) },
      aes,
      bytes(body!),
    ),
  );
}

/** A site project: a repository, with the CMS layout on. */
async function createProject(api: APIRequestContext, orgSlug: string) {
  const title = `deco serve e2e ${Date.now()}`;
  const connection = await createHttpConnection(api, orgSlug, {
    title: "deco-serve-e2e-placeholder",
    url: "http://127.0.0.1:1/unused",
  });
  const project = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        status: "active",
        connections: [{ connection_id: connection.id }],
        metadata: {
          repository: {
            url: "https://github.com/example/site",
            owner: "example",
            name: "site",
            connectionId: connection.id,
          },
          ui: { layout: { cms: "on" } },
        },
      },
    },
  );
  return { id: project.item.id, title };
}

async function heroOf(stub: DecoServeStub): Promise<Record<string, unknown>> {
  const text = (await stub.readFiles())[`${HERO}.json`];
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

/** Edits a field, a Lazy<T> field and a secret of the hero section. */
async function editHero(
  page: Page,
  stub: DecoServeStub,
  privateKey: CryptoKey,
): Promise<void> {
  const title = page.getByLabel("Title", { exact: true });
  await title.fill("Hello from Studio");
  await expect
    .poll(async () => (await heroOf(stub)).title, { timeout: 15_000 })
    .toBe("Hello from Studio");

  // Lazy<T>: the editor fills in the T; the file keeps the lazy block.
  const teaser = page.getByLabel("Teaser", { exact: true });
  await expect(teaser).toHaveValue("Soon");
  await teaser.fill("Next week");
  await expect
    .poll(async () => (await heroOf(stub)).teaser, { timeout: 15_000 })
    .toEqual({ __resolveType: "lazy", value: "Next week" });

  // Secret: encrypted in the browser; the plaintext never leaves it.
  const secret = "sk_live_e2e_do_not_leak";
  const apiKey = page.getByLabel("API key", { exact: true });
  await apiKey.fill(secret);
  await apiKey.press("Enter");
  await expect
    .poll(async () => (await heroOf(stub)).apiKey, { timeout: 15_000 })
    .toMatchObject({ __resolveType: "secret" });
  const stored = (await heroOf(stub)).apiKey as { ciphertext: string };
  expect(await decryptSecret(privateKey, stored.ciphertext)).toBe(secret);
  expect(JSON.stringify(await stub.readFiles())).not.toContain(secret);
  expect(stub.requestBodies.join("\n")).not.toContain(secret);
}

async function startStub(
  publicKey: string,
  port?: number,
  siteSchema: object = schema,
) {
  return startDecoServeStub({
    port,
    allowOrigin: getE2EAppOrigin(),
    schema: siteSchema,
    secretsPublicKey: publicKey,
    // The dev app; nothing listens, the preview just has nothing to show.
    previewUrl: "http://127.0.0.1:9",
    files: {
      [`${HERO}.json`]: heroFile({
        __resolveType: "hero",
        title: "Hello",
        teaser: { __resolveType: "lazy", value: "Soon" },
      }),
    },
  });
}

const linkOf = (stub: DecoServeStub, path = "/site-editor") =>
  `${path}#endpoint=${encodeURIComponent(stub.endpoint)}`;

test.describe("site editor over deco serve", () => {
  test.setTimeout(120_000);

  test("account-less /site-editor edits a field, a Lazy<T> field and a secret", async ({
    page,
  }) => {
    const { privateKey, publicKey } = await generateKeyPair();
    const stub = await startStub(publicKey);
    try {
      await page.goto(linkOf(stub));
      await expect(page).toHaveURL("/site-editor", { timeout: 30_000 });
      await expect(page.getByTestId("deco-serve-chip")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8");
      // Preview loads the app `deco serve --preview` names.
      await expect(
        page.locator('iframe[src^="http://127.0.0.1:9/"]'),
      ).toBeAttached({ timeout: 30_000 });

      // The saved section, from blocks.list, on the Content tab.
      await page.getByRole("link", { name: "Content" }).click();
      await expect(page).toHaveURL("/site-editor/content");
      const content = page.getByTestId("main-panel");
      // A schema without the CMS settings type (published 8.1.0-next.3):
      // no Settings entry.
      await expect(
        content.getByRole("button", { name: "Pages" }),
      ).toBeVisible();
      await expect(
        content.getByRole("button", { name: "Settings", exact: true }),
      ).toHaveCount(0);
      await content.getByRole("button", { name: "Advanced" }).click();
      await content.getByRole("button", { name: /^Sections/ }).click();
      await page.getByText("Home Hero", { exact: true }).click();
      await editHero(page, stub, privateKey);

      // The browser remembers the endpoint: `/site-editor` with no link
      // reconnects to it.
      await page.goto("/site-editor");
      await expect(page.getByTestId("deco-serve-chip")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await stub.close();
    }
  });

  test("signed in, the Local draft option connects a project to deco serve", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    // No org flag: the local path works for every org.
    const project = await createProject(api, orgSlug);
    const { privateKey, publicKey } = await generateKeyPair();
    const stub = await startStub(publicKey);
    try {
      await page.goto(`/${orgSlug}/projects/${project.id}/site-editor/content`);
      await expect(page.getByTestId("content-version-badge")).toHaveText("v7", {
        timeout: 30_000,
      });

      await page.locator('[data-tour="tour-layout-branch-picker"]').click();
      await page.getByRole("button", { name: "Advanced" }).click();
      await page.getByRole("tab", { name: "Local" }).click();
      await page
        .getByLabel("deco serve link or tunnel URL")
        .fill(`${getE2EAppOrigin()}${linkOf(stub)}`);
      await page.getByRole("button", { name: "Save" }).click();

      await expect(page.getByTestId("deco-serve-chip")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8");

      const content = page.getByTestId("main-panel");
      await content.getByRole("button", { name: "Advanced" }).click();
      await content.getByRole("button", { name: /^Sections/ }).click();
      await page.getByText("Home Hero", { exact: true }).click();
      await editHero(page, stub, privateKey);
    } finally {
      await stub.close();
    }
  });

  test("Settings opens the CMS block's form with its defaults and creates CMS.json on the first save", async ({
    page,
  }) => {
    const stub = await startStub(
      (await generateKeyPair()).publicKey,
      undefined,
      schemaWithSettings,
    );
    const cmsOf = async () => {
      const text = (await stub.readFiles())["CMS.json"];
      return text ? (JSON.parse(text) as Record<string, unknown>) : null;
    };
    try {
      await page.goto(linkOf(stub, "/site-editor/content"));
      const content = page.getByTestId("main-panel");
      await content
        .getByRole("button", { name: "Settings", exact: true })
        .click({ timeout: 30_000 });

      // No CMS block yet: the form shows the defaults.
      await expect(
        page.getByTestId("cms-settings-defaults-notice"),
      ).toBeVisible();
      expect(await cmsOf()).toBeNull();
      await content.getByRole("button", { name: "Telemetry" }).click();
      const enabled = content.getByRole("switch", { name: "Enabled" });
      await expect(enabled).toBeChecked();

      // The first change creates CMS.json through blocks.apply.
      await enabled.click();
      await expect.poll(cmsOf, { timeout: 15_000 }).toMatchObject({
        __resolveType: "cms-settings",
        telemetry: { enabled: false },
      });
      // Create-only: the first save guards CMS with ifMatch null.
      type Call = { method?: string; params?: { ifMatch?: unknown } };
      const applies = () =>
        stub.requestBodies
          .filter((body) => body.includes("blocks.apply"))
          .flatMap((body) => [JSON.parse(body) as Call | Call[]].flat())
          .filter((call) => call.method === "blocks.apply");
      expect(applies()).toHaveLength(1);
      expect(applies()[0]?.params?.ifMatch).toEqual({ CMS: null });
      await expect(
        page.getByTestId("cms-settings-defaults-notice"),
      ).toHaveCount(0);
      await expect(enabled).not.toBeChecked();

      // Once it exists, a save replaces it like any other block: no guard.
      await enabled.click();
      await expect.poll(cmsOf, { timeout: 15_000 }).toMatchObject({
        telemetry: { enabled: true },
      });
      expect(applies()).toHaveLength(2);
      expect(applies()[1]?.params?.ifMatch).toBeUndefined();
    } finally {
      await stub.close();
    }
  });

  test("Settings' first save never replaces a CMS block created meanwhile", async ({
    page,
  }) => {
    const stub = await startStub(
      (await generateKeyPair()).publicKey,
      undefined,
      schemaWithSettings,
    );
    try {
      await page.goto(linkOf(stub, "/site-editor/content"));
      const content = page.getByTestId("main-panel");
      await content
        .getByRole("button", { name: "Settings", exact: true })
        .click({ timeout: 30_000 });
      await expect(
        page.getByTestId("cms-settings-defaults-notice"),
      ).toBeVisible();
      // Another writer saves a block named CMS, of another type, first.
      const theirs = `${JSON.stringify({ __resolveType: "site/sections/Cms.tsx" }, null, 2)}\n`;
      await stub.writeFile("CMS.json", theirs);
      await content.getByRole("button", { name: "Telemetry" }).click();
      await content.getByRole("switch", { name: "Enabled" }).click();
      // The guard fails; the content is read again and explained, not replaced.
      await expect(page.getByText("CMS settings unavailable")).toBeVisible({
        timeout: 15_000,
      });
      expect((await stub.readFiles())["CMS.json"]).toBe(theirs);
    } finally {
      await stub.close();
    }
  });

  test("waits for a stopped deco serve and reconnects when it starts", async ({
    page,
  }) => {
    const { publicKey } = await generateKeyPair();
    // A port nothing listens on yet.
    const probe = await startStub(publicKey);
    const port = Number(new URL(probe.endpoint).port);
    await probe.close();
    await page.goto(
      `/site-editor#endpoint=${encodeURIComponent(`http://127.0.0.1:${port}/rpc`)}`,
    );
    // Nothing answers: the guide, which keeps looking for the link's server.
    await expect(
      page.getByText(`Looking for deco serve on 127.0.0.1:${port}…`),
    ).toBeVisible({ timeout: 30_000 });
    const stub = await startStub(publicKey, port);
    try {
      await expect(page.getByTestId("deco-serve-chip")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 30_000,
      });
    } finally {
      await stub.close();
    }
  });

  test("refuses a link to a server off this machine", async ({ page }) => {
    await page.goto(
      `/site-editor#endpoint=${encodeURIComponent("https://attacker.example/rpc")}`,
    );
    await expect(
      page.getByRole("heading", {
        name: "This site editor link is incomplete",
      }),
    ).toBeVisible();
  });

  test("signed in, /site-editor shows the org rail with the Site Editor active", async ({
    authedPage,
  }) => {
    // The New Layout preference is off (the default): this route uses the
    // New Layout anyway.
    const { page, orgSlug } = authedPage;
    const stub = await startStub((await generateKeyPair()).publicKey);
    try {
      await page.goto(linkOf(stub));
      await expect(page).toHaveURL("/site-editor", { timeout: 30_000 });
      await expect(page.getByTestId("deco-serve-chip")).toBeVisible({
        timeout: 30_000,
      });
      const rail = page.getByLabel("Organizations", { exact: true });
      await expect(rail).toBeVisible();
      await expect(rail.getByRole("button").first()).toBeVisible();
      const siteEditor = rail.getByTestId("org-rail-local-app");
      await expect(siteEditor).toHaveAttribute("aria-current", "page");
      await expect(siteEditor).toHaveAttribute("href", "/site-editor");

      // Still the Site Editor on its Content tab.
      await page.getByRole("link", { name: "Content" }).click();
      await expect(page).toHaveURL("/site-editor/content");
      await expect(siteEditor).toHaveAttribute("aria-current", "page");

      // Nothing was recorded for an org: there is none here.
      const recorded = await page.evaluate(
        (slug) => localStorage.getItem(`studio:recent-apps:${slug}`),
        orgSlug,
      );
      expect(recorded ?? "[]").not.toContain("deco-serve");
    } finally {
      await stub.close();
    }
  });
});
