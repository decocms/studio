/**
 * Standalone entry for the Jira stub (jira-stub.ts).
 *
 * Launched as a Playwright `webServer` so the Jira run trigger resolves a real
 * board, issue and attachment over HTTP without reaching a customer's site.
 * The integration's `siteUrl` points here; the API is run with
 * `JIRA_ALLOW_LOCAL_SITE_URL=1`. Follows the github-stub-server.ts pattern.
 */

import { createJiraStubServer } from "./jira-stub";

const port = Number(process.env.JIRA_STUB_PORT ?? "4103");

createJiraStubServer().listen(port, () => {
  console.log(`[jira-stub] listening on http://localhost:${port}`);
});
