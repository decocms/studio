import {
  Algorithms,
  type ConnectionType,
  createUser,
  decode,
  encodeUser,
  fmtCreds,
  fromPublic,
  fromSeed,
  type KeyPair,
} from "@nats-io/jwt";
import type { LinkSessionPermissions } from "./link-session";

export interface IssueNatsCredentialsInput {
  accountJwt: string;
  accountSigningKey: string;
  expiresAt: Date;
  permissions: LinkSessionPermissions;
  userId: string;
  /**
   * Connection types the minted user may use. Defaults to WEBSOCKET only
   * (production: the daemon links over the public WebSocket listener). In local
   * dev the daemon connects over TCP (the Node `nats` transport speaks raw TCP),
   * so it also needs STANDARD — see nats-operator-config.ts spike findings.
   */
  allowedConnectionTypes?: ConnectionType[];
}

function clearKey(key: KeyPair | null): void {
  try {
    key?.clear?.();
  } catch {
    // Best effort cleanup; some key implementations may already be cleared.
  }
}

export async function issueNatsCredentials({
  accountJwt,
  accountSigningKey,
  expiresAt,
  permissions,
  userId,
  allowedConnectionTypes = ["WEBSOCKET"],
}: IssueNatsCredentialsInput): Promise<string> {
  const accountClaims = decode(accountJwt);
  const accountKey = fromPublic(accountClaims.sub);
  const signerKey = fromSeed(new TextEncoder().encode(accountSigningKey));
  const userKey = createUser();

  try {
    const token = await encodeUser(
      userId,
      userKey,
      accountKey,
      {
        pub: {
          allow: permissions.publish.allow,
        },
        sub: {
          allow: permissions.subscribe.allow,
        },
        allowed_connection_types: allowedConnectionTypes,
      },
      {
        algorithm: Algorithms.v2,
        exp: Math.floor(expiresAt.getTime() / 1000),
        signer: signerKey,
      },
    );

    return new TextDecoder().decode(fmtCreds(token, userKey));
  } finally {
    clearKey(userKey);
    clearKey(signerKey);
    clearKey(accountKey);
  }
}
