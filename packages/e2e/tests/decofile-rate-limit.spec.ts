import { signUpViaApi } from "../fixtures/auth-api";
import {
  createFastPreviewProject,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { expect, newApiContext, test } from "../fixtures/test";

for (const rateLimit of [
  { status: 403, resetAfterSeconds: 90 },
  { status: 429, retryAfterSeconds: 90 },
  { status: 429 },
] as const) {
  test(`decofile content and schema preserve rate-limit delay ${JSON.stringify(rateLimit)}`, async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const owner = uniqueOwner();
      const project = await createFastPreviewProject(ctx, user.orgSlug, {
        owner,
        repo: "site",
        connectionUrl: "http://127.0.0.1:1/mcp",
      });
      await seedStubRepo(ctx, {
        owner,
        repo: "site",
        rateLimit,
        branches: {
          main: {
            files: {
              ".deco/blocks/Hero.json": '{"n":1}',
              ".deco/meta.gen.json": '{"schema":{}}',
            },
          },
        },
      });
      for (const suffix of ["", "/meta"]) {
        const response = await ctx.get(
          `/api/${project.org}/decofile/${project.vmcpId}/main${suffix}`,
        );
        expect(response.status()).toBe(429);
        expect(response.headers()["cache-control"]).toBe("no-store");
        const wait = Number(response.headers()["retry-after"]);
        const expectedWait =
          "retryAfterSeconds" in rateLimit || "resetAfterSeconds" in rateLimit
            ? 90
            : 60;
        expect(wait).toBeGreaterThanOrEqual(expectedWait - 1);
        expect(wait).toBeLessThanOrEqual(expectedWait);
        expect((await response.json()).error).toContain("rate limit");
      }
    } finally {
      await ctx.dispose();
    }
  });
}
