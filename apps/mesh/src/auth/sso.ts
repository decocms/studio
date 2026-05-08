import { decodeJwt } from "jose";
import { sql } from "kysely";
import { getDb } from "../database";

export interface MicrosoftSSOConfig {
  domain: string;
  providerId: "microsoft";
  MS_TENANT_ID: string;
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  scopes: string[];
}

export interface GoogleSSOConfig {
  domain: string;
  providerId: "google";
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  scopes: string[];
}

const createMicrosoftSSO = (config: MicrosoftSSOConfig) => {
  return {
    trustEmailVerified: true,
    provisionUser: mergeDuplicateSSOUser,
    defaultSSO: [
      {
        domain: config.domain,
        providerId: config.providerId,
        oidcConfig: {
          issuer: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/v2.0`,
          pkce: true,
          clientId: config.MS_CLIENT_ID,
          clientSecret: config.MS_CLIENT_SECRET,
          discoveryEndpoint: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/v2.0/.well-known/openid-configuration`,
          authorizationEndpoint: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/oauth2/v2.0/authorize`,
          tokenEndpoint: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/oauth2/v2.0/token`,
          jwksEndpoint: `https://login.microsoftonline.com/${config.MS_TENANT_ID}/discovery/v2.0/keys`,
          userInfoEndpoint: "https://graph.microsoft.com/oidc/userinfo",
          tokenEndpointAuthentication: "client_secret_post" as const,
          scopes: config.scopes,
          mapping: {
            id: "sub",
            email: "email",
            emailVerified: "email_verified",
            name: "name",
            image: "picture",
            extraFields: {
              emailVerified: "email_verified",
              oid: "oid",
            },
          },
        },
      },
    ],
  };
};

const createGoogleSSO = (config: GoogleSSOConfig) => {
  return {
    trustEmailVerified: true,
    defaultSSO: [
      {
        domain: config.domain,
        providerId: config.providerId,
        oidcConfig: {
          issuer: "https://accounts.google.com",
          pkce: true,
          clientId: config.GOOGLE_CLIENT_ID,
          clientSecret: config.GOOGLE_CLIENT_SECRET,
          discoveryEndpoint:
            "https://accounts.google.com/.well-known/openid-configuration",
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          jwksEndpoint: "https://www.googleapis.com/oauth2/v3/certs",
          userInfoEndpoint: "https://openidconnect.googleapis.com/v1/userinfo",
          tokenEndpointAuthentication: "client_secret_post" as const,
          scopes: config.scopes,
          mapping: {
            id: "sub",
            email: "email",
            emailVerified: "email_verified",
            name: "name",
            image: "picture",
            extraFields: {
              emailVerified: "email_verified",
              hd: "hd",
            },
          },
        },
      },
    ],
  };
};

/**
 * After SSO login, detect and merge duplicate users caused by email aliases.
 *
 * When a Microsoft user has multiple email aliases (e.g., john@company.com
 * and j.doe@company.com), the initial SSO login might create a duplicate user
 * if the email claim doesn't match the existing user's email. This function
 * detects that scenario by checking the `preferred_username` / `upn` claims
 * from the ID token and merges the duplicate into the original user.
 */
async function mergeDuplicateSSOUser(data: {
  user: { id: string; email: string } & Record<string, unknown>;
  userInfo: Record<string, unknown>;
  token?: { idToken?: string; accessToken?: string; refreshToken?: string };
  provider: Record<string, unknown>;
}) {
  const { user, token } = data;
  if (!token?.idToken) return;

  let decoded: Record<string, unknown>;
  try {
    decoded = decodeJwt(token.idToken);
  } catch {
    return;
  }

  const preferredUsername = decoded.preferred_username as string | undefined;
  const upn = decoded.upn as string | undefined;

  // Collect alternate emails from the token that differ from the SSO user's email
  const alternateEmails = [preferredUsername, upn]
    .filter(
      (e): e is string =>
        typeof e === "string" &&
        e.length > 0 &&
        e.toLowerCase() !== user.email.toLowerCase(),
    )
    .map((e) => e.toLowerCase());

  if (alternateEmails.length === 0) return;

  const { db } = getDb();

  // Check if there's an existing user with one of the alternate emails
  const originalUser = await db
    .selectFrom("user")
    .selectAll()
    .where("email", "in", alternateEmails)
    .where("id", "!=", user.id)
    .executeTakeFirst();

  if (!originalUser) return;

  try {
    await db.transaction().execute(async (tx) => {
      // Move all accounts from the duplicate to the original user
      await sql`UPDATE "account" SET "userId" = ${originalUser.id} WHERE "userId" = ${user.id}`.execute(
        tx,
      );

      // Move sessions so the current login session works with the original user
      await sql`UPDATE "session" SET "userId" = ${originalUser.id} WHERE "userId" = ${user.id}`.execute(
        tx,
      );

      // Move memberships that don't conflict (skip orgs where original is already a member)
      await sql`
        UPDATE "member" SET "userId" = ${originalUser.id}
        WHERE "userId" = ${user.id}
          AND "organizationId" NOT IN (
            SELECT "organizationId" FROM "member" WHERE "userId" = ${originalUser.id}
          )
      `.execute(tx);

      // Delete remaining memberships for the duplicate (conflicts).
      // This may leave orphaned auto-created orgs, which is harmless —
      // deleting them here risks cascading into seeded data (connections, settings).
      await sql`DELETE FROM "member" WHERE "userId" = ${user.id}`.execute(tx);

      // Delete the duplicate user
      await sql`DELETE FROM "user" WHERE "id" = ${user.id}`.execute(tx);
    });
  } catch (error) {
    console.error("[SSO] Failed to merge duplicate user:", error);
  }
}

export const createSSOConfig = (config: SSOConfig) => {
  if (config.providerId === "microsoft") {
    return createMicrosoftSSO(config);
  }
  if (config.providerId === "google") {
    return createGoogleSSO(config);
  }
  throw new Error(
    `Unsupported provider: ${(config as { providerId: string }).providerId}`,
  );
};

export type SSOConfig = MicrosoftSSOConfig | GoogleSSOConfig;
