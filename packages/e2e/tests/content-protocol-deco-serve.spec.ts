/**
 * The site editor on a developer's machine: a `deco serve` connect link
 * binds a project to the local content-protocol server, and edits land in
 * its working tree through `blocks.apply`.
 *
 * `deco serve` is played by fixtures/deco-serve-stub.ts (the protocol's own
 * handler over an in-memory "working tree", on 127.0.0.1 with a token).
 */

import type { APIRequestContext } from "@playwright/test";
import { publicKeyPemFromDer } from "@decocms/shared/blocks-protocol";
import {
  type DecoServeStub,
  startDecoServeStub,
} from "../fixtures/deco-serve-stub";
import {
  callSelfMcpTool,
  createHttpConnection,
  findOrgId,
} from "../fixtures/mcp-tools";
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
  const text = stub.storage.dump().files[`${HERO}.json`];
  return JSON.parse(text ?? "{}") as Record<string, unknown>;
}

test.describe("site editor over deco serve", () => {
  test.setTimeout(120_000);

  test("connects, edits a field, a Lazy<T> field and a secret", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: await findOrgId(api, orgSlug),
      flags: { site_editor_content_protocol: true },
    });
    const project = await createProject(api, orgSlug);
    const { privateKey, publicKey } = await generateKeyPair();
    const stub = await startDecoServeStub({
      allowOrigin: getE2EAppOrigin(),
      schema,
      secretsPublicKey: publicKey,
      // The dev app; nothing listens, the preview just has nothing to show.
      previewOrigin: "http://127.0.0.1:9",
      files: {
        [`${HERO}.json`]: heroFile({
          __resolveType: "hero",
          title: "Hello",
          teaser: { __resolveType: "lazy", value: "Soon" },
        }),
      },
    });
    try {
      // The link `deco serve` prints.
      await page.goto(
        `/connect#endpoint=${encodeURIComponent(stub.endpoint)}&token=${stub.token}`,
      );
      await expect(page).toHaveURL(`/${orgSlug}/connect`, { timeout: 30_000 });
      // The token left the address bar.
      expect(page.url()).not.toContain(stub.token);
      await page
        .getByRole("main")
        .getByRole("button", { name: project.title })
        .click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname ===
          `/${orgSlug}/projects/${project.id}/site-editor/content`,
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("deco-serve-chip")).toBeVisible({
        timeout: 30_000,
      });

      // The saved section, from blocks.list.
      await page.getByRole("button", { name: "Advanced" }).click();
      await page.getByRole("button", { name: /^Sections/ }).click();
      await page.getByText("Home Hero", { exact: true }).click();

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
      expect(JSON.stringify(stub.storage.dump().files)).not.toContain(secret);
      expect(stub.requestBodies.join("\n")).not.toContain(secret);
    } finally {
      await stub.close();
    }
  });
});
