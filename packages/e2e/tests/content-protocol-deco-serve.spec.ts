/**
 * The site editor on a developer's machine, over the local content-protocol
 * server: at `/site-editor` (the link `deco serve` prints, ungated and always
 * in the New Layout), account-less or signed in, and signed in through the
 * draft selector's "Localhost" (Blocks v8 projects). Edits land in its
 * working tree through `blocks.apply`.
 *
 * `deco serve` is played by fixtures/deco-serve-stub.ts (the protocol's own
 * handler over its filesystem storage in a temporary working tree, on
 * localhost with no token).
 */

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { APIRequestContext, Page } from "@playwright/test";
import { isV8Schema } from "@decocms/shared/blocks-major";
import { publicKeyPemFromDer } from "@decocms/shared/secret-ciphertext";
import {
  type DecoServeStub,
  startDecoServeStub,
} from "../fixtures/deco-serve-stub";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { expect, test } from "../fixtures/test";

/**
 * A deco-meta@1 schema, as `deco schema` writes it (with `"blocksMajor": 8`,
 * which is what makes a site v8), for one section type.
 */
const schema = {
  blocksMajor: 8,
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

/** The same schema with the built-in page type, so a page lists its sections. */
const schemaWithPages = {
  ...schema,
  manifest: {
    blocks: {
      ...schema.manifest.blocks,
      pages: { page: { $ref: "#/definitions/cGFnZQ==" } },
    },
  },
  schema: {
    definitions: {
      ...schema.schema.definitions,
      "cGFnZQ==": {
        title: "page",
        type: "object",
        required: ["__resolveType"],
        properties: {
          __resolveType: { type: "string", enum: ["page"], default: "page" },
          name: { type: "string", title: "Name" },
          path: { type: "string", title: "Path" },
          sections: { type: "array", title: "Sections", items: {} },
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

/**
 * A Blocks v8 site project: its repository's main has a `"blocksMajor": 8`
 * schema (any org; there is no flag). The page decides from main's schema,
 * which it asks the server for on open; reading it here first also writes
 * the server's cached answer (the marker), so new threads default to the
 * hosted CMS runtime.
 */
async function createV8Project(api: APIRequestContext, orgSlug: string) {
  const owner = uniqueOwner();
  const project = await createFastPreviewProject(api, orgSlug, {
    owner,
    repo: "site",
    // The header's PR lookup dials this; a closed port fails fast.
    connectionUrl: "http://127.0.0.1:1/unused",
    siteSlug: owner,
  });
  await seedStubRepo(api, {
    owner,
    repo: "site",
    defaultBranch: "main",
    branches: {
      main: {
        files: {
          ".deco/schema.gen.json": JSON.stringify(schema),
        },
      },
    },
  });
  // What opening it does: main's schema over the content protocol, which
  // the server's read turns into the project's v8 marker on the way.
  const opened = await api.post(
    `/api/${orgSlug}/decofile/${project.vmcpId}/main/rpc`,
    { data: { jsonrpc: "2.0", id: 1, method: "schema.get" } },
  );
  expect(opened.status()).toBe(200);
  const body = (await opened.json()) as { result: { schema: unknown } };
  expect(isV8Schema(body.result.schema)).toBe(true);
  return { id: project.vmcpId };
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
  // A v8 site always gets the new blocks editor: with no org, and in an org
  // that never turned on `new_blocks_editor`.
  await expect(page.locator("[data-blocks-editor]").first()).toHaveAttribute(
    "data-blocks-editor",
    "new",
    { timeout: 30_000 },
  );
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

/**
 * The dev app `deco serve --preview` names: any page. The preview waits until
 * it answers, so it must listen.
 */
async function startPreviewApp(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>app</title><p>app</p>");
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function startStub(
  publicKey: string,
  port?: number,
  siteSchema: object = schema,
  /** More saved block files, by file name. */
  files: Record<string, string> = {},
): Promise<DecoServeStub & { previewUrl: string }> {
  const app = await startPreviewApp();
  const stub = await startDecoServeStub({
    port,
    schema: siteSchema,
    secretsPublicKey: publicKey,
    previewUrl: app.url,
    files: {
      [`${HERO}.json`]: heroFile({
        __resolveType: "hero",
        title: "Hello",
        teaser: { __resolveType: "lazy", value: "Soon" },
      }),
      ...files,
    },
  });
  return {
    ...stub,
    previewUrl: app.url,
    close: async () => {
      await stub.close();
      await app.close();
    },
  };
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
      await expect(page.getByTestId("content-version-badge")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8");
      // Preview loads the app `deco serve --preview` names.
      await expect(
        page.locator(`iframe[src^="${stub.previewUrl}/"]`),
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
      await expect(page.getByTestId("content-version-badge")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await stub.close();
    }
  });

  test("signed in, Localhost in the drafts list connects a project to deco serve", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    // Only a Blocks v8 site (main's schema) connects to deco serve: a v7 one
    // keeps main's Local tunnel.
    const project = await createV8Project(api, orgSlug);
    const { privateKey, publicKey } = await generateKeyPair();
    const stub = await startStub(publicKey);
    const session = await api.get("/api/auth/get-session");
    const { user } = (await session.json()) as { user: { id: string } };
    await page.addInitScript(
      ({ key, endpoint }) =>
        localStorage.setItem(key, JSON.stringify(endpoint)),
      {
        key: `studio:deco-serve-endpoint:${user.id}:${project.id}`,
        endpoint: stub.endpoint,
      },
    );
    try {
      await page.goto(`/${orgSlug}/projects/${project.id}/site-editor/content`);
      const branchPicker = page.locator(
        '[data-tour="tour-layout-branch-picker"]',
      );
      await expect(branchPicker).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 30_000,
      });

      // Localhost, in the drafts list, connects to where this user last
      // connected the project (the default port otherwise). Picking it
      // closes the menu, like a draft row; the row says "Connected" once it is.
      const localhostRow = page.locator("button[aria-pressed]", {
        hasText: "Localhost",
      });
      await branchPicker.click();
      await localhostRow.click();
      await expect(localhostRow).toHaveCount(0);
      await branchPicker.click();
      await expect(
        localhostRow.getByText("Connected", { exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press("Escape");

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
    // Holds the editor's polls once armed, until its save goes out, so the
    // editor can't read the other writer's block first: only the guard
    // (`ifMatch: { CMS: null }`) can tell. Under load a poll used to land
    // between the write and the click and show the conflict before any save.
    let holdPolls = false;
    let releasePolls = () => {};
    const polls = new Promise<void>((resolve) => {
      releasePolls = resolve;
    });
    await page.route(stub.endpoint, async (route) => {
      const body = route.request().postData() ?? "";
      if (body.includes('"blocks.apply"')) releasePolls();
      else if (holdPolls && body.includes('"blocks.list"')) await polls;
      await route.continue();
    });
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
      holdPolls = true;
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
      releasePolls();
      await stub.close();
    }
  });

  test("a section form saved over another writer's change keeps that change", async ({
    page,
  }) => {
    const stub = await startStub(
      (await generateKeyPair()).publicKey,
      undefined,
      schemaWithPages,
      {
        "pages-home.json": heroFile({
          __resolveType: "page",
          name: "Home",
          path: "/",
          sections: [{ __resolveType: HERO }],
        }),
      },
    );
    // Holds the editor's polls once armed, until its next save goes out, so
    // that save is made from the copy the form loaded: only the version
    // guard (`ifMatch`) can tell it is outdated.
    let holdPolls = false;
    let releasePolls = () => {};
    const polls = new Promise<void>((resolve) => {
      releasePolls = resolve;
    });
    await page.route(stub.endpoint, async (route) => {
      const body = route.request().postData() ?? "";
      if (body.includes('"blocks.apply"')) releasePolls();
      else if (holdPolls && body.includes('"blocks.list"')) await polls;
      await route.continue();
    });
    try {
      await page.goto(linkOf(stub));
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 30_000,
      });
      const blocks = page.getByTestId("blocks-panel");
      await blocks
        .getByRole("button", { name: /home.?hero/i })
        .first()
        .click({ timeout: 60_000 });
      const title = blocks.getByLabel("Title", { exact: true });
      await expect(title).toHaveValue("Hello", { timeout: 30_000 });

      // Another writer (a code editor, an agent) changes the teaser.
      holdPolls = true;
      const theirs = { __resolveType: "lazy", value: "Changed on disk" };
      await stub.writeFile(
        `${HERO}.json`,
        heroFile({ __resolveType: "hero", title: "Hello", teaser: theirs }),
      );
      // The form, still on its loaded copy, changes the title.
      await title.fill("Hello from Studio");

      // The outdated save is refused; the form's edit lands on top of the
      // stored block, and the other writer's change survives.
      await expect(
        page.getByText("This block was updated while you were editing"),
      ).toBeVisible({ timeout: 30_000 });
      await expect
        .poll(async () => (await heroOf(stub)).title, { timeout: 15_000 })
        .toBe("Hello from Studio");
      expect((await heroOf(stub)).teaser).toEqual(theirs);
      await expect(blocks.getByLabel("Teaser", { exact: true })).toHaveValue(
        "Changed on disk",
      );

      const applies = stub.requestBodies.flatMap((body) => {
        try {
          const parsed = JSON.parse(body) as unknown;
          return (Array.isArray(parsed) ? parsed : [parsed]).filter(
            (call) => (call as { method?: string }).method === "blocks.apply",
          ) as Array<{ params: { ifMatch?: Record<string, unknown> } }>;
        } catch {
          return [];
        }
      });
      // Every form save names the version it was made from.
      expect(applies.length).toBeGreaterThanOrEqual(2);
      for (const apply of applies) {
        expect(Object.keys(apply.params.ifMatch ?? {})).toEqual([HERO]);
      }
      expect(applies[0]!.params.ifMatch![HERO]).not.toBe(
        applies.at(-1)!.params.ifMatch![HERO],
      );
    } finally {
      releasePolls();
      await stub.close();
    }
  });

  test("a field another writer also changed asks whose version to keep, and saves the choice with the version guard", async ({
    page,
  }) => {
    const stub = await startStub(
      (await generateKeyPair()).publicKey,
      undefined,
      schemaWithPages,
      {
        "pages-home.json": heroFile({
          __resolveType: "page",
          name: "Home",
          path: "/",
          sections: [{ __resolveType: HERO }],
        }),
      },
    );
    // As above: the editor's polls wait for its next save, so only the
    // version guard (`ifMatch`) can tell the form's copy is outdated.
    let holdPolls = false;
    let releasePolls = () => {};
    const polls = new Promise<void>((resolve) => {
      releasePolls = resolve;
    });
    await page.route(stub.endpoint, async (route) => {
      const body = route.request().postData() ?? "";
      if (body.includes('"blocks.apply"')) releasePolls();
      else if (holdPolls && body.includes('"blocks.list"')) await polls;
      await route.continue();
    });
    try {
      await page.goto(linkOf(stub));
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 30_000,
      });
      const blocks = page.getByTestId("blocks-panel");
      await blocks
        .getByRole("button", { name: /home.?hero/i })
        .first()
        .click({ timeout: 60_000 });
      const title = blocks.getByLabel("Title", { exact: true });
      await expect(title).toHaveValue("Hello", { timeout: 30_000 });

      // Another writer changes the title the user is about to change.
      holdPolls = true;
      const theirs = { ...(await heroOf(stub)), title: "Changed on disk" };
      await stub.writeFile(`${HERO}.json`, heroFile(theirs));
      await title.fill("Hello from Studio");

      const dialog = page.getByRole("dialog", {
        name: "Someone else changed this while you were editing",
      });
      await expect(dialog).toBeVisible({ timeout: 30_000 });
      const field = dialog.getByRole("radiogroup", { name: "Title" });
      await expect(field.getByTestId("conflict-mine")).toHaveText(
        "Hello from Studio",
      );
      await expect(field.getByTestId("conflict-theirs")).toHaveText(
        "Changed on disk",
      );
      // Nothing written over theirs while the user decides.
      expect((await heroOf(stub)).title).toBe("Changed on disk");

      await field.getByRole("radio", { name: "Keep mine" }).click();
      await dialog.getByRole("button", { name: "Apply" }).click();
      await expect(dialog).toBeHidden();
      await expect
        .poll(async () => (await heroOf(stub)).title, { timeout: 15_000 })
        .toBe("Hello from Studio");
      await expect(title).toHaveValue("Hello from Studio");

      const applies = stub.requestBodies.flatMap((body) => {
        try {
          const parsed = JSON.parse(body) as unknown;
          return (Array.isArray(parsed) ? parsed : [parsed]).filter(
            (call) => (call as { method?: string }).method === "blocks.apply",
          ) as Array<{ params: { ifMatch?: Record<string, unknown> } }>;
        } catch {
          return [];
        }
      });
      // The choice is saved against the version the dialog showed.
      expect(applies.length).toBeGreaterThanOrEqual(2);
      expect(Object.keys(applies.at(-1)!.params.ifMatch ?? {})).toEqual([HERO]);
      expect(applies[0]!.params.ifMatch![HERO]).not.toBe(
        applies.at(-1)!.params.ifMatch![HERO],
      );
    } finally {
      releasePolls();
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
    // An older link, on 127.0.0.1: it opens, shown as localhost.
    await page.goto(
      `/site-editor#endpoint=${encodeURIComponent(`http://127.0.0.1:${port}/rpc`)}`,
    );
    // Nothing answers: the guide, which keeps looking for the link's server.
    await expect(
      page.getByText(`Looking for deco serve on localhost:${port}…`),
    ).toBeVisible({ timeout: 30_000 });
    const stub = await startStub(publicKey, port);
    try {
      await expect(page.getByTestId("content-version-badge")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 30_000,
      });
    } finally {
      await stub.close();
    }
  });

  test("Changes lists what changed since the last commit, shows both sides, and discards it", async ({
    page,
  }) => {
    const { publicKey } = await generateKeyPair();
    const stub = await startStub(publicKey);
    try {
      const committed = (await stub.readFiles())[`${HERO}.json`]!;
      await page.goto(linkOf(stub));
      await expect(page.getByTestId("content-version-badge")).toHaveText("v8", {
        timeout: 30_000,
      });
      const button = page.getByTestId("local-changes-button");
      await expect(button).toHaveText("Changes", { timeout: 30_000 });

      // An edit to the working tree (the site editor's, or a code editor's).
      await stub.writeFile(
        `${HERO}.json`,
        heroFile({ __resolveType: "hero", title: "Edited on disk" }),
      );
      await expect(button).toHaveText("Changes (1)", { timeout: 30_000 });
      await button.click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByText("1 change since your last commit"),
      ).toBeVisible({ timeout: 30_000 });
      // No Publish here: the developer commits with git.
      await expect(dialog.getByRole("button", { name: /Publish/ })).toHaveCount(
        0,
      );
      // One card for the entry, edited against the last commit: the card
      // names its status in the icon's title (the icon's color carries it).
      await expect(dialog.getByTitle("Edited", { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      await dialog.getByRole("button", { name: "Discard" }).first().click();
      await dialog
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await expect(
        dialog.getByText("No changes since your last commit."),
      ).toBeVisible({ timeout: 30_000 });
      // The committed bytes are back, through changes.discard.
      expect((await stub.readFiles())[`${HERO}.json`]).toBe(committed);
      expect(await stub.git("status", "--porcelain")).toBe("");
      const methods = stub.requestBodies.flatMap((body) => {
        try {
          const parsed = JSON.parse(body) as unknown;
          return (Array.isArray(parsed) ? parsed : [parsed]).map(
            (call) => (call as { method?: string }).method,
          );
        } catch {
          return [];
        }
      });
      expect(methods).toContain("changes.list");
      expect(methods).toContain("changes.get");
      expect(methods.filter((m) => m === "changes.discard")).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  test("an older deco serve (8.1.x) says it's out of date and how to update", async ({
    page,
  }) => {
    const { publicKey } = await generateKeyPair();
    const app = await startPreviewApp();
    const stub = await startDecoServeStub({
      schema,
      secretsPublicKey: publicKey,
      previewUrl: app.url,
      outdated: true,
    });
    try {
      await page.goto(linkOf(stub));
      await expect(
        page.getByText("This deco serve is out of date"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText(
          /Update @decocms\/blocks in your site to 8\.2\.1 or newer/,
        ),
      ).toBeVisible();
      // Never the editor over a server it can't list changes on.
      await expect(page.getByTestId("local-changes-button")).toHaveCount(0);
    } finally {
      await stub.close();
      await app.close();
    }
  });

  test("refuses a link to a server off this machine", async ({ page }) => {
    await page.goto(
      `/site-editor#endpoint=${encodeURIComponent("https://attacker.example/rpc")}`,
    );
    await expect(
      page.getByText("This link doesn't point to deco serve on your computer"),
    ).toBeVisible({ timeout: 30_000 });
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
      await expect(page.getByTestId("content-version-badge")).toBeVisible({
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
