import { generateKeyPairSync } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { RepoRef } from "@decocms/shared/git-providers";
import { GithubAppAuth } from "./app-auth";
import { GithubProviderClient } from "./client";
import {
  githubPermissionParam,
  mapGithubCollaborators,
  mapGithubInvitations,
} from "./collaborators";

describe("collaborator mapping", () => {
  test("reads GitHub's role names and invitation permissions", () => {
    expect(
      mapGithubCollaborators([
        { login: "ana", avatar_url: "https://a/1", role_name: "write" },
        { login: "bia", role_name: "custom-reviewer" },
      ]),
    ).toEqual([
      { login: "ana", avatarUrl: "https://a/1", permission: "write" },
      { login: "bia", avatarUrl: null, permission: null },
    ]);
    expect(
      mapGithubInvitations([
        { id: 1, invitee: { login: "caio" }, permissions: "read" },
        { id: 2, invitee: null, permissions: "write" },
      ]),
    ).toEqual([{ login: "caio", avatarUrl: null, permission: "read" }]);
  });

  test("sends GitHub's write names for read and write", () => {
    expect(githubPermissionParam("read")).toBe("pull");
    expect(githubPermissionParam("write")).toBe("push");
    expect(githubPermissionParam("maintain")).toBe("maintain");
  });
});

describe("GithubProviderClient collaborators", () => {
  interface Invitation {
    id: number;
    login: string;
    permissions: string;
  }
  const state = {
    users: new Set<string>(),
    collaborators: new Map<string, string>(),
    invitations: [] as Invitation[],
    /** Answer every mint asking for administration with this status. */
    adminMintStatus: 201,
    /** Answer every PUT with this status and body instead of the model. */
    putOverride: null as { status: number; body: unknown } | null,
  };
  const mints: { permissions: Record<string, string>; ids: number[] }[] = [];
  const calls: string[] = [];
  let nextInvitation = 1;
  let server: ReturnType<typeof Bun.serve>;
  let auth: GithubAppAuth;
  const previousBase = process.env.GITHUB_API_BASE_URL;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const path = url.pathname;
        if (path.endsWith("/access_tokens")) {
          const body = (await req.json()) as {
            permissions: Record<string, string>;
            repository_ids?: number[];
          };
          mints.push({
            permissions: body.permissions,
            ids: body.repository_ids ?? [],
          });
          if (
            body.permissions.administration &&
            state.adminMintStatus !== 201
          ) {
            return Response.json(
              {
                message:
                  "The permissions requested are not granted to this installation.",
              },
              { status: state.adminMintStatus },
            );
          }
          return Response.json({
            token: `ghs_${mints.length}`,
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: body.permissions,
          });
        }
        calls.push(`${req.method} ${path}${url.search}`);
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const slice = <T>(items: T[]) =>
          items.slice((page - 1) * perPage, page * perPage);

        const collaborator = path.match(/\/collaborators\/([^/]+)$/)?.[1];
        const invitation = path.match(/\/invitations\/(\d+)$/)?.[1];
        if (path.endsWith("/collaborators")) {
          return Response.json(
            slice(
              [...state.collaborators].map(([login, role_name]) => ({
                login,
                avatar_url: null,
                role_name,
              })),
            ),
          );
        }
        if (path.endsWith("/invitations")) {
          return Response.json(
            slice(
              state.invitations.map((i) => ({
                id: i.id,
                invitee: { login: i.login, avatar_url: null },
                permissions: i.permissions,
              })),
            ),
          );
        }
        if (collaborator && req.method === "PUT") {
          if (state.putOverride) {
            return Response.json(state.putOverride.body, {
              status: state.putOverride.status,
            });
          }
          if (!state.users.has(collaborator)) {
            return Response.json({ message: "Not Found" }, { status: 404 });
          }
          const { permission } = (await req.json()) as { permission: string };
          if (state.collaborators.has(collaborator)) {
            state.collaborators.set(collaborator, permission);
            return new Response(null, { status: 204 });
          }
          state.invitations.push({
            id: nextInvitation++,
            login: collaborator,
            permissions: permission,
          });
          return Response.json({}, { status: 201 });
        }
        if (collaborator && req.method === "DELETE") {
          state.collaborators.delete(collaborator);
          return new Response(null, { status: 204 });
        }
        if (invitation && req.method === "DELETE") {
          state.invitations = state.invitations.filter(
            (i) => i.id !== Number(invitation),
          );
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });
    process.env.GITHUB_API_BASE_URL = server.url.origin;
    auth = new GithubAppAuth(
      {
        appId: "1",
        privateKeyPem: generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey,
        clientId: "c",
        clientSecret: "s",
        slug: "studio",
      },
      { apiBaseUrl: server.url.origin },
    );
  });

  afterAll(() => {
    server.stop(true);
    if (previousBase === undefined) delete process.env.GITHUB_API_BASE_URL;
    else process.env.GITHUB_API_BASE_URL = previousBase;
  });

  beforeEach(() => {
    state.users = new Set(["ana", "bia"]);
    state.collaborators = new Map();
    state.invitations = [];
    state.adminMintStatus = 201;
    state.putOverride = null;
    nextInvitation = 1;
    mints.length = 0;
    calls.length = 0;
  });

  const repo: RepoRef = {
    provider: "github",
    host: "github.com",
    path: "acme/site",
  };
  let installation = 1000;
  // A fresh installation per client keeps the token cache out of the assertions.
  const client = () =>
    new GithubProviderClient({
      host: "github.com",
      installationId: ++installation,
      repositoryIds: [77],
      knownRepository: { ref: repo, externalId: "77" },
      appAuth: auth,
    });

  test("invites someone new and lists them as pending", async () => {
    const github = client();
    expect(await github.addCollaborator(repo, "ana", "write")).toBe("invited");
    expect(await github.listCollaborators(repo)).toEqual({
      collaborators: [],
      invitations: [{ login: "ana", avatarUrl: null, permission: "write" }],
    });
    expect(calls).toContain("PUT /repos/acme/site/collaborators/ana");
  });

  test("mints for this repository only, with the Administration permission", async () => {
    await client().addCollaborator(repo, "ana", "read");
    expect(mints).toEqual([
      { permissions: { administration: "write", metadata: "read" }, ids: [77] },
    ]);
    expect(state.invitations[0]?.permissions).toBe("pull");
  });

  test("changes the access of an existing collaborator", async () => {
    state.collaborators.set("bia", "pull");
    expect(await client().addCollaborator(repo, "bia", "maintain")).toBe(
      "updated",
    );
    expect(state.collaborators.get("bia")).toBe("maintain");
  });

  test("names a GitHub user that does not exist", async () => {
    await expect(
      client().addCollaborator(repo, "ghost", "write"),
    ).rejects.toMatchObject({
      status: 404,
      message: "GitHub has no user named ghost.",
    });
  });

  test("passes GitHub's reason through a 422", async () => {
    state.putOverride = {
      status: 422,
      body: {
        message: "Validation Failed",
        errors: [{ message: "Outside collaborators are not allowed" }],
      },
    };
    await expect(
      client().addCollaborator(repo, "ana", "write"),
    ).rejects.toMatchObject({
      status: 422,
      message:
        "GitHub refused the change to acme/site: Validation Failed: Outside collaborators are not allowed",
    });
  });

  test("asks for the Administration permission when the installation lacks it", async () => {
    state.adminMintStatus = 422;
    await expect(client().listCollaborators(repo)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("needs the Administration permission"),
    });
  });

  test("removing withdraws a pending invitation", async () => {
    const github = client();
    await github.addCollaborator(repo, "ana", "write");
    await github.removeCollaborator(repo, "ANA");
    expect(state.invitations).toEqual([]);
    expect(calls).toContain("DELETE /repos/acme/site/invitations/1");
  });

  test("removing drops direct access", async () => {
    state.collaborators.set("bia", "push");
    await client().removeCollaborator(repo, "bia");
    expect(state.collaborators.size).toBe(0);
  });

  test("reads every page of a long listing", async () => {
    for (let i = 0; i < 150; i++) state.collaborators.set(`user${i}`, "read");
    const { collaborators } = await client().listCollaborators(repo);
    expect(collaborators).toHaveLength(150);
    expect(
      calls.filter((c) => c.startsWith("GET /repos/acme/site/collaborators")),
    ).toEqual([
      "GET /repos/acme/site/collaborators?affiliation=direct&per_page=100&page=1",
      "GET /repos/acme/site/collaborators?affiliation=direct&per_page=100&page=2",
    ]);
  });
});
