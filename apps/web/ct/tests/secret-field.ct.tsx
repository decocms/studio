import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { FieldHarness } from "../harness/field-harness";
import { SchemaFormHarness } from "../harness/schema-form-harness";
import { sectionWithProps, TEST_RESOLVE_TYPE } from "../harness/fixtures";
import { readFormValue } from "../harness/ct-utils";
import { CT_SITE_URL } from "../harness/stubs/use-virtual-mcp";
import type { SchemaProperty } from "@/components/sections-editor/resolve-schema";

const RAW = "SG.synthetic-raw-api-key_0123456789";
const STORED_HEX = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const SECRET = "website/loaders/secret.ts";

// A `Secret` prop as the CMS resolves it: a block-ref whose only branch is the
// secret loader, with `encrypted` marked `@format secret`.
const secretProp: SchemaProperty = {
  type: "block-ref",
  anyOfRefs: [
    {
      resolveType: SECRET,
      title: "Secret",
      schema: {
        type: "object",
        properties: {
          encrypted: {
            type: "string",
            format: "secret",
            title: "Secret Value",
          },
          name: { type: "string", title: "Secret Name" },
        },
      },
    },
  ],
};

const storedBlock = {
  __resolveType: SECRET,
  name: "SENDGRID_API_KEY",
  encrypted: STORED_HEX,
};

/** Stands in for the site's `secrets/encrypt.ts`: AES-CBC with the site's own key. */
async function serveSite(page: Page, mode: "ok" | "fail" = "ok") {
  const key = randomBytes(32);
  const requests: { url: string; method: string; body: string }[] = [];
  await page.route(`${CT_SITE_URL}live/invoke/**`, async (route) => {
    const req = route.request();
    requests.push({
      url: req.url(),
      method: req.method(),
      body: req.postData() ?? "",
    });
    const cors = { "access-control-allow-origin": "*" };
    if (mode === "fail") return route.fulfill({ status: 500, headers: cors });
    const { value } = req.postDataJSON() as { value: string };
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const hex = Buffer.concat([iv, cipher.update(value), cipher.final()]);
    return route.fulfill({
      headers: cors,
      json: { value: hex.toString("hex") },
    });
  });
  const decrypt = (hex: string) => {
    const bytes = Buffer.from(hex, "hex");
    const decipher = createDecipheriv(
      "aes-256-cbc",
      key,
      bytes.subarray(0, 16),
    );
    return Buffer.concat([
      decipher.update(bytes.subarray(16)),
      decipher.final(),
    ]).toString();
  };
  return { requests, decrypt };
}

test("a Secret prop never shows the stored value in a text input", async ({
  mount,
  page,
}) => {
  await serveSite(page);
  const component = await mount(
    <FieldHarness
      schema={secretProp}
      label="SendGrid key"
      initialValue={storedBlock}
    />,
  );
  const secretInput = component.getByLabel("Secret Value");
  await expect(secretInput).toHaveAttribute("type", "password");
  await expect(secretInput).toHaveValue("");
  await expect(component.getByLabel("Secret Name")).toHaveValue(
    "SENDGRID_API_KEY",
  );
  await expect(component.locator(`input[value="${STORED_HEX}"]`)).toHaveCount(
    0,
  );
});

test("entering a secret stores only the site's hex in `encrypted`", async ({
  mount,
  page,
}) => {
  const site = await serveSite(page);
  const component = await mount(
    <FieldHarness
      schema={secretProp}
      label="SendGrid key"
      initialValue={storedBlock}
    />,
  );
  const secretInput = component.getByLabel("Secret Value");
  await secretInput.fill(RAW);
  await secretInput.press("Enter");

  await expect
    .poll(async () => {
      const v = (await readFormValue(component)) as Record<string, unknown>;
      return v.encrypted !== STORED_HEX;
    })
    .toBe(true);
  const saved = (await readFormValue(component)) as Record<string, unknown>;
  expect(Object.keys(saved).sort()).toEqual([
    "__resolveType",
    "encrypted",
    "name",
  ]);
  expect(saved.__resolveType).toBe(SECRET);
  expect(saved.name).toBe("SENDGRID_API_KEY");
  expect(saved.encrypted).toMatch(/^[0-9a-f]+$/);
  expect(site.decrypt(saved.encrypted as string)).toBe(RAW);
  expect(JSON.stringify(saved)).not.toContain(RAW);
  await expect(secretInput).toHaveValue("");

  expect(site.requests).toHaveLength(1);
  expect(site.requests[0]!.method).toBe("POST");
  expect(site.requests[0]!.url).toBe(
    `${CT_SITE_URL}live/invoke/website/actions/secrets/encrypt.ts`,
  );
  expect(JSON.parse(site.requests[0]!.body)).toEqual({ value: RAW });
});

test("a failed encryption keeps the stored secret and shows an error", async ({
  mount,
  page,
}) => {
  await serveSite(page, "fail");
  const component = await mount(
    <FieldHarness
      schema={secretProp}
      label="SendGrid key"
      initialValue={storedBlock}
    />,
  );
  const secretInput = component.getByLabel("Secret Value");
  await secretInput.fill(RAW);
  await secretInput.press("Enter");

  await expect(component.getByRole("alert")).toContainText(
    "Couldn't encrypt this secret",
  );
  expect(await readFormValue(component)).toEqual(storedBlock);
  expect(JSON.stringify(await readFormValue(component))).not.toContain(RAW);
});

test("leaving the secret empty keeps `encrypted` and still edits `name`", async ({
  mount,
  page,
}) => {
  const site = await serveSite(page);
  const component = await mount(
    <FieldHarness
      schema={secretProp}
      label="SendGrid key"
      initialValue={storedBlock}
    />,
  );
  await component.getByLabel("Secret Value").press("Enter");
  await component.getByLabel("Secret Name").fill("SENDGRID_KEY");

  await expect
    .poll(() => readFormValue(component))
    .toEqual({ ...storedBlock, name: "SENDGRID_KEY" });
  expect(site.requests).toHaveLength(0);
});

test("a stored plaintext secret is flagged, not displayed", async ({
  mount,
  page,
}) => {
  await serveSite(page);
  const component = await mount(
    <FieldHarness
      schema={secretProp}
      label="SendGrid key"
      initialValue={{ ...storedBlock, encrypted: RAW }}
    />,
  );
  await expect(component.getByRole("alert")).toContainText("not encrypted");
  await expect(component.getByLabel("Secret Value")).toHaveValue("");
});

test("a raw `@format secret` schema resolves to the secret input", async ({
  mount,
  page,
}) => {
  await serveSite(page);
  // The secret loader's own props, as `/live/_meta` serves them.
  const meta = sectionWithProps({
    encrypted: { type: "string", format: "secret", title: "Secret Value" },
    name: { type: "string", title: "Secret Name" },
  });
  const component = await mount(
    <SchemaFormHarness
      meta={meta}
      resolveType={TEST_RESOLVE_TYPE}
      initialValue={{ name: "SENDGRID_API_KEY", encrypted: STORED_HEX }}
    />,
  );
  const secretInput = component.getByLabel("Secret Value");
  await expect(secretInput).toHaveAttribute("type", "password");
  await expect(secretInput).toHaveValue("");
});
