/**
 * smoke-link — verify that a local link daemon is registered and online.
 *
 * Hits `/api/links/me` on the local cluster with a bearer session and
 * fails fast if the status isn't "online". Useful as a quick check
 * before running an integration test that depends on a live link.
 *
 * Run with: `bun run smoke:link` from `apps/mesh/`.
 *
 * Required env:
 *   MESH_TEST_SESSION  Bearer token for an authenticated session
 *
 * Optional env:
 *   MESH_BASE_URL      Cluster base URL (default http://localhost:3000)
 */

async function main(): Promise<void> {
  const baseUrl = process.env.MESH_BASE_URL ?? "http://localhost:3000";
  const token = process.env.MESH_TEST_SESSION ?? "";
  if (!token) {
    console.error(
      "smoke: MESH_TEST_SESSION is not set — pass a bearer token for an authenticated session.",
    );
    process.exit(2);
  }
  const res = await fetch(`${baseUrl}/api/links/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error(
      `smoke: /api/links/me returned ${res.status} — start the link with \`bun run dev --local-sandbox-provider\` or \`deco link\``,
    );
    process.exit(1);
  }
  const body = (await res.json()) as {
    status?: string;
    capabilities?: string[];
  };
  if (body.status !== "online") {
    console.error(
      "smoke: link is not online; start it with `bun run dev --local-sandbox-provider` or `deco link`",
    );
    process.exit(1);
  }
  console.log("smoke: link online — capabilities", body.capabilities);
}

main().catch((err) => {
  console.error("smoke: unexpected error", err);
  process.exit(1);
});
