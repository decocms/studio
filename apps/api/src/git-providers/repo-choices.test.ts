import { describe, expect, test } from "bun:test";
import { mergeRepoChoices } from "./repo-choices";
import {
  type LegacyRepoChoice,
  orgSharedFirst,
} from "./github/legacy-connection";
import type { RepositoryRecord } from "@/storage/repositories";

function repository(
  overrides: Partial<RepositoryRecord> & Pick<RepositoryRecord, "path">,
): RepositoryRecord {
  return {
    id: `repo_${overrides.path}`,
    organizationId: "org_1",
    accountId: "acc_1",
    provider: "github",
    host: "github.com",
    externalId: null,
    defaultBranch: null,
    webUrl: `https://github.com/${overrides.path}`,
    visibility: null,
    legacyConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A legacy connection's repo, as `github/legacy-connection.ts` hands it over. */
const legacy = (owner: string, repo: string): LegacyRepoChoice => ({
  connectionId: `conn_${owner}_${repo}`,
  ref: { provider: "github", host: "github.com", path: `${owner}/${repo}` },
  installationId: 1,
});

describe("mergeRepoChoices", () => {
  test("offers repositories first, then legacy connections", () => {
    const choices = mergeRepoChoices(
      [repository({ path: "acme/site" })],
      [legacy("acme", "other")],
    );
    expect(choices.map((c) => c.label)).toEqual([
      "acme/site (github.com)",
      "acme/other (github.com)",
    ]);
    expect(choices[0]?.repository).not.toBeNull();
    expect(choices[0]?.connectionId).toBeNull();
    expect(choices[1]?.repository).toBeNull();
    expect(choices[1]?.connectionId).toBe("conn_acme_other");
  });

  /** An org mid-migration must see each repository once, through the
   *  credential Studio can mint — not twice, once per model. */
  test("a repository shadows the legacy connection for the same repo", () => {
    const choices = mergeRepoChoices(
      [repository({ path: "Acme/Site" })],
      [legacy("acme", "site")],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]?.id).toBe("repo_Acme/Site");
  });

  test("a GitLab project keeps its whole namespace as the owner", () => {
    const choices = mergeRepoChoices(
      [
        repository({
          path: "group/subgroup/project",
          provider: "gitlab",
          host: "gitlab.acme.com",
          webUrl: "https://gitlab.acme.com/group/subgroup/project",
        }),
      ],
      [],
    );
    expect(choices[0]).toMatchObject({
      owner: "group/subgroup",
      name: "project",
      label: "group/subgroup/project (gitlab.acme.com)",
      webUrl: "https://gitlab.acme.com/group/subgroup/project",
    });
  });

  /** Two providers, one agent: both are offered, each with its own host. */
  test("mixes providers in one listing", () => {
    const choices = mergeRepoChoices(
      [
        repository({ path: "acme/site" }),
        repository({
          path: "group/api",
          provider: "gitlab",
          host: "gitlab.com",
          webUrl: "https://gitlab.com/group/api",
        }),
      ],
      [],
    );
    expect(choices.map((c) => c.repository?.provider)).toEqual([
      "github",
      "gitlab",
    ]);
  });

  /** Two loadable connections for one repository is the normal shape of a
   *  single import (org-shared + per-agent), not two choices — the dispatch-time
   *  "does this org have exactly one repo?" question is asked of this list. */
  test("two legacy connections for the same repo are one choice", () => {
    const choices = mergeRepoChoices(
      [],
      [
        legacy("acme", "web"),
        { ...legacy("Acme", "Web"), connectionId: "conn_2" },
      ],
    );
    expect(choices).toHaveLength(1);
    expect(choices[0]?.connectionId).toBe("conn_acme_web");
  });

  test("the same path on two hosts is two repositories", () => {
    const choices = mergeRepoChoices(
      [
        repository({ path: "acme/site" }),
        repository({
          path: "acme/site",
          provider: "gitlab",
          host: "gitlab.com",
          webUrl: "https://gitlab.com/acme/site",
        }),
      ],
      [],
    );
    expect(choices).toHaveLength(2);
  });
});

describe("orgSharedFirst", () => {
  const conn = (id: string, orgShared?: boolean) => ({
    id,
    status: "active",
    metadata: orgShared ? { orgShared: true } : {},
  });

  /** One import leaves an org-shared connection AND a per-agent one behind.
   *  The per-agent child dies with its agent, so the dedup downstream must be
   *  handed the org-shared one first whatever order storage returned. */
  test("puts the org-shared connection ahead of the per-agent one", () => {
    expect(
      orgSharedFirst([conn("conn_agent"), conn("conn_shared", true)]).map(
        (c) => c.id,
      ),
    ).toEqual(["conn_shared", "conn_agent"]);
  });

  test("keeps the given order otherwise", () => {
    expect(
      orgSharedFirst([conn("conn_a"), conn("conn_b")]).map((c) => c.id),
    ).toEqual(["conn_a", "conn_b"]);
  });
});
