/**
 * Standalone entry for the GitHub Git Data stub (github-stub.ts).
 *
 * Launched as a Playwright `webServer` so the studio server's decofile routes
 * can read/write/publish against an in-memory git model instead of
 * api.github.com. The studio server is pointed here via `GITHUB_API_BASE_URL`
 * in the Playwright config. Follows the commerce-upgrade-mock.ts pattern.
 */

import { createGithubStubServer } from "./github-stub";

const port = Number(process.env.GITHUB_STUB_PORT ?? "4102");

createGithubStubServer().listen(port, () => {
  console.log(`[github-stub] listening on http://localhost:${port}`);
});
