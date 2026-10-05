/**
 * `ORGANIZATION_UPDATE` and `ORGANIZATION_DELETE` merge into the org's stored
 * metadata. Better Auth hands that metadata back as a JSON string, and
 * spreading the string used to write one key per character, so the second
 * update corrupted it. Assertions read the stored row, which is what every
 * later read sees.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

async function storedMetadata(orgId: string): Promise<unknown> {
  const db = await connectDevDb();
  try {
    const { rows } = await db.query<{ metadata: string | null }>(
      `select metadata from organization where id = $1`,
      [orgId],
    );
    return rows[0]?.metadata ? JSON.parse(rows[0].metadata) : null;
  } finally {
    await db.end();
  }
}

test.describe("organization metadata merges", () => {
  test("repeated updates and archiving keep metadata a flat object", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);
    const orgId = await findOrgId(ctx, owner.orgSlug);

    const callTool = (name: string, args: unknown) =>
      ctx.post(`/api/${owner.orgSlug}/tools/${name}`, { data: args });

    for (const description of ["first", "second"]) {
      const res = await callTool("ORGANIZATION_UPDATE", {
        id: orgId,
        description,
      });
      expect(res.status(), await res.text()).toBe(200);
    }
    expect(await storedMetadata(orgId)).toEqual({ description: "second" });

    const archived = await callTool("ORGANIZATION_DELETE", { id: orgId });
    expect(archived.status(), await archived.text()).toBe(200);
    const afterArchive = (await storedMetadata(orgId)) as Record<
      string,
      unknown
    >;
    expect(Object.keys(afterArchive).sort()).toEqual([
      "archived",
      "archivedAt",
      "description",
    ]);
    expect(afterArchive).toMatchObject({
      description: "second",
      archived: true,
    });

    await ctx.dispose();
  });
});
