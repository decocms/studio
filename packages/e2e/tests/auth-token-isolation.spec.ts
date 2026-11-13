import { randomUUID } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import type { Client } from "pg";
import { signUpViaApi, type SignUpResult } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { expect, newApiContext, test as baseTest } from "../fixtures/test";

const test = baseTest.extend<{ tokenUser: SignUpResult }>({
  tokenUser: async ({ playwright }, use) => {
    const ctx = await newApiContext(playwright);
    try {
      await use(await signUpViaApi(ctx));
    } finally {
      await ctx.dispose();
    }
  },
});

async function expectAnonymous(ctx: APIRequestContext) {
  const session = await ctx.get("/api/auth/get-session");
  expect(session.ok()).toBe(true);
  expect(await session.json()).toBeNull();
}

async function verifyToken(ctx: APIRequestContext, token: string) {
  return ctx.get("/api/auth/magic-link/verify", {
    params: { token },
    maxRedirects: 0,
  });
}

async function expectInvalidToken(ctx: APIRequestContext, token: string) {
  const response = await verifyToken(ctx, token);
  expect(response.status()).toBe(302);
  expect(new URL(response.headers().location).searchParams.get("error")).toBe(
    "INVALID_TOKEN",
  );
  await expectAnonymous(ctx);
}

async function seedVerification(
  db: Client,
  identifier: string,
  value: string,
  expiresAt = new Date(Date.now() + 300_000),
) {
  // No setup endpoint exposes a magic-link token without sending real email.
  // Seed only the token fixture; verification still uses the public HTTP API.
  await db.query(
    `INSERT INTO verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [randomUUID(), identifier, value, expiresAt],
  );
}

for (const existingUser of [true, false]) {
  test(`OAuth state cannot ${existingUser ? "take over an existing account" : "create an account"} through magic-link verification`, async ({
    tokenUser,
    playwright,
  }) => {
    const attacker = await newApiContext(playwright);
    const db = await connectDevDb();
    const email = existingUser
      ? tokenUser.email
      : `unregistered-${randomUUID()}@example.test`;
    try {
      const sessionsBefore = await db.query<{ id: string }>(
        `SELECT id FROM session WHERE "userId" = $1 ORDER BY id`,
        [tokenUser.userId],
      );
      const start = await attacker.post("/api/auth/sign-in/social", {
        data: {
          provider: "github",
          disableRedirect: true,
          callbackURL: "/",
          additionalData: { email, name: "Untrusted OAuth state" },
        },
      });
      expect(start.ok(), await start.text()).toBe(true);
      const body: { url: string } = await start.json();
      const providerURL = new URL(body.url);
      expect(providerURL.hostname).toBe("github.com");
      const state = providerURL.searchParams.get("state");
      expect(state).toBeTruthy();
      if (!state) throw new Error("OAuth start did not return state");

      const stateBefore = await db.query<{
        id: string;
        identifier: string;
        value: string;
      }>(
        "SELECT id, identifier, value FROM verification WHERE identifier = ANY($1::text[])",
        [[state, `auth-state:${state}`]],
      );
      expect(stateBefore.rowCount).toBe(1);
      expect(JSON.parse(stateBefore.rows[0].value).email).toBe(email);

      await expectInvalidToken(attacker, state);
      await expectInvalidToken(attacker, `auth-state:${state}`);

      const stateAfter = await db.query<{
        id: string;
        identifier: string;
        value: string;
      }>(
        "SELECT id, identifier, value FROM verification WHERE identifier = ANY($1::text[])",
        [[state, `auth-state:${state}`]],
      );
      expect(stateAfter.rows).toEqual(stateBefore.rows);
      expect(stateAfter.rows[0].identifier).toBe(`auth-state:${state}`);
      const sessionsAfter = await db.query<{ id: string }>(
        `SELECT id FROM session WHERE "userId" = $1 ORDER BY id`,
        [tokenUser.userId],
      );
      expect(sessionsAfter.rows).toEqual(sessionsBefore.rows);
      if (!existingUser) {
        const users = await db.query(
          "SELECT id FROM public.user WHERE email = $1",
          [email],
        );
        expect(users.rowCount).toBe(0);
      }
    } finally {
      await db.end();
      await attacker.dispose();
    }
  });
}

test("a namespaced magic link signs in its owner once", async ({
  tokenUser,
  playwright,
}) => {
  const recipient = await newApiContext(playwright);
  const replay = await newApiContext(playwright);
  const db = await connectDevDb();
  const token = randomUUID();
  try {
    await seedVerification(
      db,
      `magic-link:${token}`,
      JSON.stringify({
        type: "magic-link",
        email: tokenUser.email,
        name: tokenUser.name,
      }),
    );
    const response = await verifyToken(recipient, token);
    expect(response.status()).toBe(200);
    const session = await recipient.get("/api/auth/get-session");
    expect((await session.json()).user.id).toBe(tokenUser.userId);
    const stored = await db.query(
      "SELECT id FROM verification WHERE identifier = $1",
      [`magic-link:${token}`],
    );
    expect(stored.rowCount).toBe(0);
    await expectInvalidToken(replay, token);
  } finally {
    await db.end();
    await recipient.dispose();
    await replay.dispose();
  }
});

test("unprefixed magic links issued before the security patch are rejected", async ({
  tokenUser,
  playwright,
}) => {
  const ctx = await newApiContext(playwright);
  const db = await connectDevDb();
  const token = randomUUID();
  try {
    await seedVerification(
      db,
      token,
      JSON.stringify({
        email: tokenUser.email,
        name: tokenUser.name,
      }),
    );
    await expectInvalidToken(ctx, token);
  } finally {
    await db.end();
    await ctx.dispose();
  }
});

const invalidPayloads = [
  { label: "invalid JSON", value: "{not-json" },
  {
    label: "missing discriminator",
    value: JSON.stringify({ email: "user@example.test" }),
  },
  {
    label: "wrong discriminator",
    value: JSON.stringify({ type: "oauth-state", email: "user@example.test" }),
  },
  {
    label: "invalid email",
    value: JSON.stringify({ type: "magic-link", email: "invalid" }),
  },
  {
    label: "non-string name",
    value: JSON.stringify({
      type: "magic-link",
      email: "user@example.test",
      name: 42,
    }),
  },
];

for (const { label, value } of invalidPayloads) {
  test(`magic-link verification rejects ${label}`, async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const db = await connectDevDb();
    const token = randomUUID();
    try {
      await seedVerification(
        db,
        `magic-link:${token}`,
        value.replace("user@example.test", `invalid-${token}@example.test`),
      );
      await expectInvalidToken(ctx, token);
    } finally {
      await db.end();
      await ctx.dispose();
    }
  });
}

test("an expired namespaced magic link cannot create a session", async ({
  tokenUser,
  playwright,
}) => {
  const ctx = await newApiContext(playwright);
  const db = await connectDevDb();
  const token = randomUUID();
  try {
    await seedVerification(
      db,
      `magic-link:${token}`,
      JSON.stringify({ type: "magic-link", email: tokenUser.email }),
      new Date(Date.now() - 60_000),
    );
    const response = await verifyToken(ctx, token);
    expect(response.status()).toBe(302);
    // Other concurrent requests may already have cleaned up expired rows.
    expect(["EXPIRED_TOKEN", "INVALID_TOKEN"]).toContain(
      new URL(response.headers().location).searchParams.get("error"),
    );
    await expectAnonymous(ctx);
  } finally {
    await db.end();
    await ctx.dispose();
  }
});
