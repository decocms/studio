import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { getGithubAppAuth } from "./app-auth";
import {
  buildGithubAppManifest,
  convertGithubManifestCode,
  defaultGithubAppName,
  githubManifestFormAction,
  isValidGithubLogin,
  signManifestState,
  verifyManifestState,
} from "./app-manifest";
import {
  githubAppConfigSource,
  readGithubAppConfig,
  readGithubWebhookSecret,
} from "./env";
import { setStoredGithubAppConfigForTest } from "./stored-app-config";

const SECRET = "test-encryption-key";

function pem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

describe("buildGithubAppManifest", () => {
  const manifest = buildGithubAppManifest({
    publicUrl: "https://studio.example.com/",
    public: false,
  });

  test("points every URL at this deployment's existing GitHub routes", () => {
    expect(manifest.url).toBe("https://studio.example.com");
    expect(manifest.redirect_url).toBe(
      "https://studio.example.com/api/_git/github/manifest-callback",
    );
    expect(manifest.callback_urls).toEqual([
      "https://studio.example.com/api/_git/github/callback",
    ]);
    expect(manifest.setup_url).toBe(
      "https://studio.example.com/api/_git/github/setup",
    );
  });

  test("subscribes the webhook route to the events it consumes", () => {
    expect(manifest.hook_attributes).toEqual({
      url: "https://studio.example.com/api/_github/webhook",
      active: true,
    });
    expect(manifest.default_events).toEqual([
      "push",
      "check_suite",
      "issue_comment",
    ]);
  });

  test("grants the permissions the self-host docs list", () => {
    expect(manifest.default_permissions).toEqual({
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      deployments: "read",
      metadata: "read",
    });
    expect(manifest.public).toBe(false);
  });

  test("names the App after the host, within GitHub's 34-char cap", () => {
    expect(defaultGithubAppName("https://www.studio.example.com")).toBe(
      "Studio studio.example.com",
    );
    const long = defaultGithubAppName(
      "https://a-very-long-subdomain.of-a-long-company.example.com",
    );
    expect(long.length).toBeLessThanOrEqual(34);
    expect(
      (
        buildGithubAppManifest({
          publicUrl: "https://x.com",
          name: "n".repeat(50),
          public: true,
        }).name as string
      ).length,
    ).toBe(34);
  });
});

describe("githubManifestFormAction", () => {
  test("personal account vs organization", () => {
    expect(githubManifestFormAction("s t")).toBe(
      "https://github.com/settings/apps/new?state=s%20t",
    );
    expect(githubManifestFormAction("s", "acme")).toBe(
      "https://github.com/organizations/acme/settings/apps/new?state=s",
    );
  });

  test("organization logins are validated", () => {
    expect(isValidGithubLogin("acme-corp")).toBe(true);
    expect(isValidGithubLogin("../evil")).toBe(false);
    expect(isValidGithubLogin("-acme")).toBe(false);
    expect(isValidGithubLogin("")).toBe(false);
  });
});

describe("manifest state", () => {
  test("round-trips the user id", () => {
    const state = signManifestState("user_1", SECRET);
    expect(verifyManifestState(state, SECRET)).toBe("user_1");
  });

  test("rejects a state signed with another key", () => {
    const state = signManifestState("user_1", "other-key");
    expect(verifyManifestState(state, SECRET)).toBeNull();
  });

  test("rejects a tampered user id", () => {
    const [, ...rest] = signManifestState("user_1", SECRET).split(".");
    const forged = [Buffer.from("admin").toString("base64url"), ...rest].join(
      ".",
    );
    expect(verifyManifestState(forged, SECRET)).toBeNull();
  });

  test("expires", () => {
    const state = signManifestState("user_1", SECRET, 0);
    expect(verifyManifestState(state, SECRET, 31 * 60_000)).toBeNull();
  });

  test("rejects junk", () => {
    expect(verifyManifestState(undefined, SECRET)).toBeNull();
    expect(verifyManifestState("a.b.c", SECRET)).toBeNull();
  });
});

describe("convertGithubManifestCode", () => {
  const ok = (body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status: 201,
      })) as unknown as typeof fetch;

  test("maps GitHub's conversion response", async () => {
    const app = await convertGithubManifestCode(
      "abc123",
      ok({
        id: 42,
        slug: "studio-example",
        client_id: "Iv1.x",
        client_secret: "shh",
        pem: "PEM",
        webhook_secret: "hook",
        html_url: "https://github.com/apps/studio-example",
        owner: { login: "acme" },
      }),
    );
    expect(app).toEqual({
      appId: "42",
      slug: "studio-example",
      clientId: "Iv1.x",
      clientSecret: "shh",
      privateKeyPem: "PEM",
      webhookSecret: "hook",
      htmlUrl: "https://github.com/apps/studio-example",
      ownerLogin: "acme",
    });
  });

  test("refuses an incomplete App", async () => {
    await expect(
      convertGithubManifestCode("abc", ok({ id: 1, slug: "s" })),
    ).rejects.toThrow(/incomplete/);
  });

  test("refuses a code that isn't a plain token", async () => {
    await expect(
      convertGithubManifestCode("../../user", ok({})),
    ).rejects.toThrow(/invalid manifest code/);
  });

  test("surfaces GitHub's status on failure", async () => {
    const failing = (async () =>
      new Response("{}", { status: 404 })) as unknown as typeof fetch;
    await expect(convertGithubManifestCode("abc", failing)).rejects.toThrow(
      /404/,
    );
  });
});

describe("stored App fallback", () => {
  afterEach(() => setStoredGithubAppConfigForTest(null));

  const stored = {
    appId: "7",
    slug: "stored",
    clientId: "c",
    clientSecret: "s",
    privateKeyPem: "PEM",
  };
  const envVars = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY: "ENVPEM",
    GITHUB_APP_CLIENT_ID: "ec",
    GITHUB_APP_CLIENT_SECRET: "es",
    GITHUB_APP_SLUG: "env",
  };

  test("the environment wins over a stored App", () => {
    expect(readGithubAppConfig(envVars, stored)?.slug).toBe("env");
    expect(githubAppConfigSource(envVars, stored)).toBe("env");
  });

  test("a stored App is used when the environment is empty", () => {
    expect(readGithubAppConfig({}, stored)).toEqual(stored);
    expect(githubAppConfigSource({}, stored)).toBe("stored");
    expect(githubAppConfigSource({}, null)).toBeNull();
  });

  test("the signer follows a registration made after boot", () => {
    const saved = { ...process.env };
    for (const k of Object.keys(envVars)) delete process.env[k];
    try {
      setStoredGithubAppConfigForTest(null);
      expect(getGithubAppAuth()).toBeNull();
      setStoredGithubAppConfigForTest({ ...stored, privateKeyPem: pem() });
      expect(getGithubAppAuth()).not.toBeNull();
      setStoredGithubAppConfigForTest(null);
      expect(getGithubAppAuth()).toBeNull();
    } finally {
      Object.assign(process.env, saved);
    }
  });

  test("webhook secret: env wins, stored only while the stored App is in use", () => {
    expect(
      readGithubWebhookSecret({ GITHUB_WEBHOOK_SECRET: "e" }, stored, "s"),
    ).toBe("e");
    expect(readGithubWebhookSecret({}, stored, "s")).toBe("s");
    expect(readGithubWebhookSecret(envVars, stored, "s")).toBeNull();
    expect(readGithubWebhookSecret({}, null, "s")).toBeNull();
  });
});
