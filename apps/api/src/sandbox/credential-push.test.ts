import { describe, expect, it } from "bun:test";
import type {
  ListedTenantPool,
  SandboxListing,
} from "@decocms/sandbox/provider/sandbox-api";
import {
  type CredentialRecords,
  credentialExpiresAt,
  mintCredentialPush,
  planCredentialPush,
  poolRepoKey,
  PUSH_CLONE_BUFFER_MS,
  tenantKey,
} from "./credential-push";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60_000;
const A = { orgId: "org_a", userId: "user_1" };
const SITE = { connectionId: "conn_a", repo: "acme/site" };

const records: CredentialRecords = {
  members: new Map([[tenantKey(A), "acme"]]),
  connectionOrgs: new Map([
    ["conn_a", "org_a"],
    ["conn_b", "org_b"],
  ]),
  repositoryOrgs: new Map([
    ["repo_a", "org_a"],
    ["repo_b", "org_b"],
  ]),
  orgRepositories: new Map([
    [poolRepoKey("org_a", "https://github.com/acme/site.git")!, "repo_a"],
    [poolRepoKey("org_b", "https://github.com/acme/docs.git")!, "repo_b"],
  ]),
};

function listing(over: Partial<SandboxListing> = {}): SandboxListing {
  return {
    handle: "h1",
    tenant: A,
    repos: [SITE],
    orgFs: false,
    orgFsConfigExpiresAt: null,
    ...over,
  };
}

const plan = (sandboxes: SandboxListing[], pools: ListedTenantPool[] = []) =>
  planCredentialPush({ sandboxes, pools, records, now: NOW });

describe("planCredentialPush", () => {
  it("mints a member's credentials that belong to its org, once each", () => {
    const result = plan([
      listing({ repos: [SITE, { repositoryId: "repo_a" }] }),
      listing({ handle: "h2", repos: [{ ...SITE, repo: "Acme/Site" }] }),
    ]);
    expect(result).toEqual({
      clones: [
        { tenant: A, repo: SITE },
        { tenant: A, repo: { repositoryId: "repo_a" } },
      ],
      poolClones: [],
      orgFs: [],
      refused: 0,
    });
  });

  it.each([
    [
      "a user who is not a member",
      listing({ tenant: { ...A, userId: "user_2" } }),
    ],
    [
      "an org the user is not in",
      listing({ tenant: { ...A, orgId: "org_b" } }),
    ],
    [
      "another org's connection",
      listing({ repos: [{ connectionId: "conn_b", repo: "b/x" }] }),
    ],
    [
      "another org's repository",
      listing({ repos: [{ repositoryId: "repo_b" }] }),
    ],
    [
      "a connection Studio has no record of",
      listing({ repos: [{ connectionId: "gone", repo: "a/b" }] }),
    ],
  ])("refuses %s", (_label, sandbox) => {
    const result = plan([sandbox]);
    expect(result.clones).toEqual([]);
    expect(result.refused).toBe(1);
  });

  it("does not mint org-fs for a refused tenant", () => {
    const result = plan([
      listing({ tenant: { ...A, userId: "user_2" }, orgFs: true }),
    ]);
    expect(result.orgFs).toEqual([]);
  });

  it("mints org-fs only when the host holds none or it is near expiry", () => {
    expect(plan([listing({ orgFs: true })]).orgFs).toEqual([
      { ...A, orgSlug: "acme" },
    ]);
    expect(
      plan([listing({ orgFs: true, orgFsConfigExpiresAt: NOW + 3 * DAY })])
        .orgFs,
    ).toEqual([]);
    expect(
      plan([listing({ orgFs: true, orgFsConfigExpiresAt: NOW + DAY / 2 })])
        .orgFs,
    ).toHaveLength(1);
    expect(plan([listing({ orgFs: false })]).orgFs).toEqual([]);
  });

  describe("pools from the host's listing", () => {
    const pool = (tenant: string, repoUrl: string): ListedTenantPool => ({
      name: "p",
      tenant,
      image: "default",
      repos: [{ repoUrl, branch: "main" }],
    });

    it("mints a pool repo from the pool org's own record for it", () => {
      expect(plan([], [pool("org_a", "https://github.com/Acme/Site")])).toEqual(
        {
          clones: [],
          poolClones: [
            {
              tenant: "org_a",
              repoUrl: "https://github.com/Acme/Site",
              repositoryId: "repo_a",
            },
          ],
          orgFs: [],
          refused: 0,
        },
      );
    });

    it("refuses a pool repo with no record in the pool's org, even when another org has one", () => {
      expect(
        plan(
          [],
          [
            pool("org_a", "https://github.com/acme/docs"),
            pool("org_a", "https://github.com/acme/unknown"),
            pool("org_a", "git@github.com:acme/site.git"),
          ],
        ),
      ).toEqual({ clones: [], poolClones: [], orgFs: [], refused: 3 });
    });

    it("mints nothing for a pool with no repos", () => {
      expect(
        plan([], [{ name: "p", tenant: "org_a", image: "default", repos: [] }]),
      ).toEqual({ clones: [], poolClones: [], orgFs: [], refused: 0 });
    });
  });

  it("ignores tenant-less listings: pools are listed separately", () => {
    expect(plan([listing({ tenant: null })])).toEqual({
      clones: [],
      poolClones: [],
      orgFs: [],
      refused: 0,
    });
  });
});

describe("mintCredentialPush", () => {
  it("pushes what minted, with the lifetimes it vouches for", async () => {
    const asked: unknown[] = [];
    const { batches, failed } = await mintCredentialPush(
      {
        clones: [
          { tenant: A, repo: SITE },
          { tenant: A, repo: { repositoryId: "repo_a" } },
          { tenant: A, repo: { connectionId: "conn_a", repo: "acme/none" } },
        ],
        poolClones: [
          {
            tenant: "org_a",
            repoUrl: "https://github.com/acme/site",
            repositoryId: "repo_a",
          },
        ],
        orgFs: [{ ...A, orgSlug: "acme" }],
        refused: 0,
      },
      {
        mintCloneUrl: async (repo, opts) => {
          asked.push([repo, opts]);
          if (repo.cloneUrl.includes("none")) return null;
          return "https://x-access-token:t@github.com/acme/site.git";
        },
        mintOrgFsConfig: async () => {
          throw new Error("auth down");
        },
      },
      { now: NOW, orgFsLifetimeMs: DAY },
    );
    expect(failed).toBe(1);
    expect(asked[0]).toEqual([
      { cloneUrl: "https://github.com/acme/site.git", connectionId: "conn_a" },
      { bufferMs: PUSH_CLONE_BUFFER_MS },
    ]);
    expect(asked.at(-1)).toEqual([
      { cloneUrl: "", repositoryId: "repo_a" },
      { bufferMs: PUSH_CLONE_BUFFER_MS },
    ]);
    expect(batches).toEqual([
      {
        cloneUrls: [
          {
            tenant: A,
            repo: SITE,
            cloneUrl: "https://x-access-token:t@github.com/acme/site.git",
            expiresAt: NOW + PUSH_CLONE_BUFFER_MS,
          },
          {
            tenant: A,
            repo: { repositoryId: "repo_a" },
            cloneUrl: "https://x-access-token:t@github.com/acme/site.git",
            expiresAt: NOW + PUSH_CLONE_BUFFER_MS,
          },
        ],
        poolCloneUrls: [
          {
            tenant: "org_a",
            repoUrl: "https://github.com/acme/site",
            cloneUrl: "https://x-access-token:t@github.com/acme/site.git",
            expiresAt: NOW + PUSH_CLONE_BUFFER_MS,
          },
        ],
        orgFsConfigs: [],
      },
    ]);
  });
});

describe("credentialExpiresAt", () => {
  it("passes a mint's own expiry, a day for a never-expiring token, nothing without one", () => {
    expect(credentialExpiresAt(new Date(NOW + 55 * 60_000), NOW)).toBe(
      NOW + 55 * 60_000,
    );
    expect(credentialExpiresAt(null, NOW)).toBe(NOW + DAY);
    expect(credentialExpiresAt(undefined, NOW)).toBeUndefined();
  });
});
