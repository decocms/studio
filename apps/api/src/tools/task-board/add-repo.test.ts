import { describe, expect, test } from "bun:test";
import {
  cliAuthCommand,
  MAX_SECONDARY_REPOS,
  mergeRepoChoices,
  parseRepoProbe,
  secondaryRepoCapExceeded,
} from "./add-repo";
import type { RepositoryRecord } from "@/storage/repositories";

// The probe is what decides "you can start reading files now", and the marker is
// the only part of it that can. The checkout directory is never empty: the pod
// stages `.deco` and mounts `org` into it before any clone starts.
test("the pod's own scaffolding is not a checkout", () => {
  // The exact probe output that shipped a 20-second "completed" task: no
  // marker, but two entries the old rule counted as a working tree.
  expect(parseRepoProbe(".deco\norg\n")).toEqual({
    cloned: false,
    listing: ".deco\norg",
  });
  expect(parseRepoProbe(".deco\n.git\norg\n")).toEqual({
    cloned: false,
    listing: ".deco\norg",
  });
});

test("the marker is the checkout, whatever else is in the directory", () => {
  expect(parseRepoProbe("__CLONED__\n.git\npackage.json\nsrc\n")).toEqual({
    cloned: true,
    listing: "package.json\nsrc",
  });
  // Scaffolding stays in the listing the model reads — it just no longer
  // decides anything.
  expect(
    parseRepoProbe("__CLONED__\n.deco\n.git\norg\npackage.json\n"),
  ).toEqual({
    cloned: true,
    listing: ".deco\norg\npackage.json",
  });
});

test("an empty directory is not cloned", () => {
  expect(parseRepoProbe("")).toEqual({ cloned: false, listing: "" });
});

test("a new repo is refused once the thread is at the secondary cap", () => {
  const existing = Array.from({ length: MAX_SECONDARY_REPOS }, (_, i) => ({
    owner: "acme",
    name: `repo-${i}`,
  }));
  expect(
    secondaryRepoCapExceeded(existing, { owner: "acme", name: "one-more" }),
  ).toBe(true);
});

test("a repo below the cap is allowed", () => {
  const existing = Array.from({ length: MAX_SECONDARY_REPOS - 1 }, (_, i) => ({
    owner: "acme",
    name: `repo-${i}`,
  }));
  expect(
    secondaryRepoCapExceeded(existing, { owner: "acme", name: "one-more" }),
  ).toBe(false);
});

// Re-adding an existing repo is a storage no-op, so it must never be blocked.
test("a repo already checked out is let through at the cap, case-insensitively", () => {
  const existing = Array.from({ length: MAX_SECONDARY_REPOS }, (_, i) => ({
    owner: "acme",
    name: `repo-${i}`,
  }));
  expect(
    secondaryRepoCapExceeded(existing, { owner: "ACME", name: "Repo-0" }),
  ).toBe(false);
});

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

const legacy = (owner: string, repo: string) => ({
  connectionId: `conn_${owner}_${repo}`,
  owner,
  repo,
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

describe("cliAuthCommand", () => {
  /** The primary is the daemon's cwd; a secondary must be entered first, or
   *  the command reads the primary's remote and configures the wrong CLI. */
  test("enters the checkout for a secondary and not for the primary", () => {
    expect(cliAuthCommand(null).startsWith("origin=")).toBe(true);
    expect(cliAuthCommand("../repos/api").split("\n")[0]).toBe(
      'cd "../repos/api" || exit 0',
    );
  });

  test("writes glab's config for oauth2 and gh's for x-access-token", () => {
    const script = cliAuthCommand(null);
    expect(script).toContain('if [ "$user" = "oauth2" ]');
    expect(script).toContain("glab-cli/config.yml");
    expect(script).toContain("is_oauth2: true");
    expect(script).toContain('elif [ "$user" = "x-access-token" ]');
    expect(script).toContain("gh/hosts.yml");
    // The host comes from the remote, so a self-hosted instance works too.
    expect(script).toContain('host=$(printf %s "$origin"');
  });
});
