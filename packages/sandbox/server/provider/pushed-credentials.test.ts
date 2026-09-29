import { describe, expect, it } from "bun:test";
import {
  PushedCredentials,
  pushedCredentialOptions,
  repoIdentityOf,
} from "./pushed-credentials";

const MIN = 60_000;
const A = { orgId: "org_a", userId: "user_1" };
const B = { orgId: "org_b", userId: "user_1" };
const SITE = { connectionId: "c1", repo: "acme/site" };
const url = (token: string) =>
  `https://x-access-token:${token}@github.com/acme/site.git`;

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

function clone(
  tenant: typeof A,
  cloneUrl: string,
  expiresAt: number,
  repo: typeof SITE | { repositoryId: string } = SITE,
) {
  return {
    cloneUrls: [{ tenant, repo, cloneUrl, expiresAt }],
    poolCloneUrls: [],
    orgFsConfigs: [],
  };
}

function poolClone(
  tenant: string,
  repoUrl: string,
  cloneUrl: string,
  expiresAt: number,
) {
  return {
    cloneUrls: [],
    poolCloneUrls: [{ tenant, repoUrl, cloneUrl, expiresAt }],
    orgFsConfigs: [],
  };
}

describe("PushedCredentials", () => {
  it("never replaces a longer-lived entry with a shorter one", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now });
    expect(store.push(clone(A, url("new"), t.now() + 50 * MIN))).toEqual({
      stored: 1,
      kept: 0,
    });
    expect(store.push(clone(A, url("old"), t.now() + 20 * MIN))).toEqual({
      stored: 0,
      kept: 1,
    });
    expect(store.cloneUrl(A, SITE)).toBe(url("new"));
    store.push(clone(A, url("newer"), t.now() + 55 * MIN));
    expect(store.cloneUrl(A, SITE)).toBe(url("newer"));
  });

  it("refuses an entry that is already dead", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now });
    expect(store.push(clone(A, url("x"), t.now())).stored).toBe(0);
    expect(store.cloneUrl(A, SITE)).toBeNull();
  });

  it("answers null once less than bufferMs is left, and nothing once expired", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now });
    store.push(clone(A, url("t"), t.now() + 45 * MIN));
    expect(store.cloneUrl(A, SITE, 30 * MIN)).toBe(url("t"));
    t.advance(16 * MIN);
    expect(store.cloneUrl(A, SITE, 30 * MIN)).toBeNull();
    expect(store.cloneUrl(A, SITE)).toBe(url("t"));
    t.advance(30 * MIN);
    expect(store.cloneUrl(A, SITE)).toBeNull();
  });

  it("keeps each tenant's credentials, and the pools', apart", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now });
    store.push(clone(A, url("a"), t.now() + 50 * MIN));
    store.push(
      poolClone(
        "org_a",
        "https://github.com/Acme/Site",
        url("pool"),
        t.now() + 50 * MIN,
      ),
    );
    expect(store.cloneUrl(B, SITE)).toBeNull();
    expect(
      store.cloneUrl({ orgId: "org_a", userId: "user_2" }, SITE),
    ).toBeNull();
    expect(store.cloneUrl(null, SITE)).toBeNull();
    expect(store.cloneUrl(undefined, SITE)).toBeNull();
    expect(store.cloneUrl(A, SITE)).toBe(url("a"));
    expect(
      store.poolCloneUrl("org_a", "https://x:y@github.com/acme/site.git"),
    ).toBe(url("pool"));
    expect(
      store.poolCloneUrl("org_b", "https://github.com/acme/site"),
    ).toBeNull();
    expect(
      store.poolCloneUrl("org_a", "https://github.com/acme/other"),
    ).toBeNull();
    expect(
      store.cloneUrl(A, { connectionId: "c2", repo: "acme/site" }),
    ).toBeNull();
    expect(
      store.cloneUrl(A, { connectionId: "c1", repo: "acme/other" }),
    ).toBeNull();
    store.push({
      cloneUrls: [],
      poolCloneUrls: [],
      orgFsConfigs: [
        { tenant: A, orgFsConfigJson: "{a}", expiresAt: t.now() + MIN },
      ],
    });
    expect(store.orgFsConfig(A)).toBe("{a}");
    expect(store.orgFsConfig(B)).toBeNull();
  });

  it("keys a repository record by its id alone", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now });
    store.push(clone(A, url("r"), t.now() + MIN, { repositoryId: "r1" }));
    expect(store.cloneUrl(A, { repositoryId: "r1" })).toBe(url("r"));
    expect(store.cloneUrl(A, SITE)).toBeNull();
  });

  it("stays within its size cap, dropping the oldest writes", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now, maxEntries: 2 });
    for (const n of ["1", "2", "3"]) {
      store.push(
        clone(A, url(n), t.now() + MIN, {
          connectionId: "c1",
          repo: `acme/r${n}`,
        }),
      );
    }
    expect(
      store.cloneUrl(A, { connectionId: "c1", repo: "acme/r1" }),
    ).toBeNull();
    expect(store.cloneUrl(A, { connectionId: "c1", repo: "acme/r3" })).toBe(
      url("3"),
    );
  });

  it("seeds each credentialed clone URL until its own expiry, less a margin", () => {
    const t = clock();
    const store = new PushedCredentials({ now: t.now });
    const repo = (
      cloneUrl: string,
      connectionId = "c1",
      credentialExpiresAt = t.now() + 55 * MIN,
    ) => ({
      cloneUrl,
      connectionId,
      userName: "u",
      userEmail: "e",
      credentialExpiresAt,
    });
    store.seed(
      {
        tenant: { ...A, orgSlug: "a" },
        repo: repo(url("seed")),
        extraRepos: [
          repo("https://github.com/acme/public.git", "c9"),
          repo(url("short"), "c2", t.now() + 10 * MIN),
        ],
        orgFsConfigJson: "{k}",
      },
      { orgFsConfig: t.now() + 60 * MIN },
    );
    // A spot eviction eight minutes in still finds the token.
    t.advance(8 * MIN);
    expect(store.cloneUrl(A, SITE)).toBe(url("seed"));
    expect(store.cloneUrl(A, SITE, 30 * MIN)).toBe(url("seed"));
    expect(
      store.cloneUrl(A, { connectionId: "c9", repo: "acme/public" }),
    ).toBeNull();
    // Ten minutes of life, two of them margin: gone at eight.
    expect(
      store.cloneUrl(A, { connectionId: "c2", repo: "acme/short" }),
    ).toBeNull();
    t.advance(46 * MIN);
    expect(store.cloneUrl(A, SITE)).toBeNull();
    expect(store.orgFsConfigExpiresAt(A)).toBe(t.now() + 6 * MIN);
    const { credentialExpiresAt: _unknown, ...noExpiry } = repo(url("b"));
    store.seed({ tenant: B, repo: noExpiry }, undefined);
    expect(store.cloneUrl(B, SITE)).toBeNull();
  });
});

describe("pushedCredentialOptions", () => {
  it("mints from the store the way the runner asks", async () => {
    const t = clock(Date.now());
    const store = new PushedCredentials({ now: t.now });
    store.push(clone(A, url("fresh"), t.now() + 45 * MIN));
    const opts = pushedCredentialOptions(store);
    const persisted = {
      cloneUrl: "https://github.com/Acme/Site.git",
      connectionId: "c1",
      userName: "u",
      userEmail: "e",
    };
    expect(opts.persistCredentials).toBe(false);
    expect(await opts.mintCloneUrl(persisted, { tenant: A })).toBe(
      url("fresh"),
    );
    expect(
      await opts.mintCloneUrl(persisted, { tenant: A, bufferMs: 50 * MIN }),
    ).toBeNull();
    expect(await opts.mintCloneUrl(persisted, { tenant: B })).toBeNull();
    expect(await opts.mintOrgFsConfig(A)).toBeNull();

    store.push(
      poolClone(
        "org_a",
        "https://github.com/acme/site",
        url("pool"),
        t.now() + 45 * MIN,
      ),
    );
    expect(
      await opts.mintPoolCloneUrl({
        tenant: "org_a",
        repoUrl: "https://github.com/Acme/Site",
      }),
    ).toBe(url("pool"));
    expect(
      await opts.mintPoolCloneUrl({
        tenant: "org_b",
        repoUrl: "https://github.com/acme/site",
      }),
    ).toBeNull();
  });
});

describe("repoIdentityOf", () => {
  it("prefers the repository record, and needs a GitHub URL otherwise", () => {
    expect(
      repoIdentityOf({
        cloneUrl: url("x"),
        connectionId: "c1",
        repositoryId: "r1",
      }),
    ).toEqual({ repositoryId: "r1" });
    expect(repoIdentityOf({ cloneUrl: url("x"), connectionId: "c1" })).toEqual(
      SITE,
    );
    expect(
      repoIdentityOf({
        cloneUrl: "https://gitlab.com/a/b.git",
        connectionId: "c1",
      }),
    ).toBeNull();
    expect(repoIdentityOf({ cloneUrl: url("x") })).toBeNull();
    expect(
      repoIdentityOf({
        cloneUrl: "https://x-access-token:tok@github.com/Acme/Site.git",
        connectionId: "c1",
      }),
    ).toEqual(SITE);
    expect(
      repoIdentityOf({
        cloneUrl: "git@github.com:acme/site.git",
        connectionId: "c1",
      }),
    ).toBeNull();
  });
});
