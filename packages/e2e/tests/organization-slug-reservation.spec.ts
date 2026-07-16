import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

const RESERVED_SLUGS = [
  ".well-known",
  "_admin",
  "api",
  "auth",
  "cli",
  "commerce-onboarding",
  "dbos-queue-depth",
  "health",
  "hosted-run-pending",
  "login",
  "mcp",
  "metrics",
  "oauth",
  "oauth-proxy",
  "onboarding",
  "org",
  "report",
  "reset-password",
] as const;

test("public route namespaces cannot become organization slugs", async ({
  playwright,
}) => {
  const ctx = await newApiContext(playwright);
  await signUpViaApi(ctx);

  for (const slug of RESERVED_SLUGS) {
    const create = await ctx.post("/api/auth/organization/create", {
      data: { name: `Reserved ${slug}`, slug },
    });
    expect(create.status()).toBe(400);
    expect((await create.text()).toLowerCase()).toContain("reserved");
  }

  const list = await ctx.get("/api/auth/organization/list");
  expect(list.ok()).toBe(true);
  const listBody = (await list.json()) as
    | Array<{ id: string }>
    | { data?: Array<{ id: string }> };
  const organizations = Array.isArray(listBody)
    ? listBody
    : (listBody.data ?? []);
  const organizationId = organizations[0]?.id;
  if (!organizationId) throw new Error("Expected a default organization");

  const rename = await ctx.post("/api/auth/organization/update", {
    data: {
      organizationId,
      data: { slug: "api" },
    },
  });
  expect(rename.status()).toBe(400);
  expect((await rename.text()).toLowerCase()).toContain("reserved");

  await ctx.dispose();
});
