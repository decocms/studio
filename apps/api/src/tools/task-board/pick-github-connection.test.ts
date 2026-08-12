/**
 * The fallback ladder behind every PR read and every merge.
 *
 * The case that matters is the last one: an org whose connection for the PR's
 * repo was deleted, leaving only a connection scoped to a DIFFERENT repo. That
 * connection's installation token cannot reach this PR, so handing it back
 * turns "we can't reach GitHub" into an indistinguishable all-null live state —
 * which is exactly how 40+ approved cards silently parked In Review. Null is
 * the honest answer, and the caller logs it.
 */
import { describe, expect, it } from "bun:test";
import { pickGithubConnection } from "./prs-get";

const scoped = (id: string, owner: string, repo: string) => ({
  id,
  metadata: {
    repoScope: {
      installationId: 1,
      repositoryId: 1,
      owner,
      repo,
      permissions: {},
      grantProvider: "github-mcp",
    },
  },
});
const broad = (id: string) => ({ id, metadata: { source: "store" } });
const TARGET = { owner: "deco-sites", name: "demo-storefront" };

describe("pickGithubConnection", () => {
  it("prefers the connection scoped to the requested repo", () => {
    const match = scoped("scoped-match", "deco-sites", "demo-storefront");
    const picked = pickGithubConnection(
      [broad("broad"), scoped("other", "deco-sites", "other-repo"), match],
      TARGET,
    );
    expect(picked?.id).toBe("scoped-match");
  });

  it("falls back to the broad org-level connection when no scope matches", () => {
    const picked = pickGithubConnection(
      [scoped("other", "deco-sites", "other-repo"), broad("broad")],
      TARGET,
    );
    expect(picked?.id).toBe("broad");
  });

  it("returns null rather than a connection scoped to a different repo", () => {
    expect(
      pickGithubConnection(
        [scoped("other", "deco-sites", "decocms-tanstack")],
        TARGET,
      ),
    ).toBeNull();
  });

  it("returns null when the org has no GitHub connection at all", () => {
    expect(pickGithubConnection([], TARGET)).toBeNull();
  });

  it("with no repo named, still takes any active connection as a last resort", () => {
    const only = scoped("other", "deco-sites", "other-repo");
    expect(pickGithubConnection([only])?.id).toBe("other");
  });
});
