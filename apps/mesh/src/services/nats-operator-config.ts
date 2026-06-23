/**
 * Dev NATS operator/JWT provisioning — pure, unit-testable helpers.
 *
 * Production NATS runs in decentralized-JWT ("operator") mode: an operator, a
 * "tunnel" account (+ signing key), a system account, a MEMORY resolver, an
 * internal TCP listener and a public WEBSOCKET listener. The cluster connects
 * to the internal listener and the daemon links over the public listener with
 * a short-lived per-user JWT minted from the tunnel account's signing key.
 *
 * To make LOCAL dev exercise the SAME auth path, `ensureNats` generates (and
 * persists, idempotently) the operator / system account / tunnel account
 * (+ signing key) / cluster service user, writes a `nats-server.conf`, and
 * starts the server with `-c <conf>`. The session route then mints real
 * per-user scoped creds exactly like prod.
 *
 * SPIKE FINDINGS (nats-server v2.10.24) that shape this module:
 *  - `no_auth_user` is NOT compatible with Trusted Operator mode — the server
 *    refuses to start ("no_auth_user not compatible with Trusted Operator").
 *    So the cluster authenticates with an explicit CREDS FILE over TCP instead
 *    of connecting anonymously.
 *  - The `nats` npm package (Node transport) connects over raw TCP even for a
 *    `ws://` URL (it strips the scheme). The local daemon therefore connects to
 *    the TCP listener, so its minted creds must allow the STANDARD connection
 *    type. The WEBSOCKET listener is still configured (faithful to prod; a
 *    101-upgrade probe confirms it works) and `allowed_connection_types`
 *    includes WEBSOCKET too.
 *  - Per-user subject scoping is enforced by the server: a daemon subscribing
 *    to another user's `tunnel.v1.host.<other>.*` subjects gets a
 *    "Permissions Violation".
 *
 * All functions here are pure (no IO, no process.env) so they can be unit
 * tested. The IO (key persistence, conf write, server spawn) lives in
 * ensure-services.ts.
 */

import {
  Algorithms,
  createAccount,
  createOperator,
  createUser,
  encodeAccount,
  encodeOperator,
  encodeUser,
  fmtCreds,
  fromSeed,
  type KeyPair,
} from "@nats-io/jwt";

/**
 * The persisted seed/JWT material for a dev NATS operator setup. Seeds are
 * SECRETS — persisted under the dev home services dir (outside the repo),
 * never committed. JSON-serializable so it can be written to disk and reloaded
 * on subsequent boots (idempotent: restarts reuse the same identities so the
 * cluster and previously-minted daemon creds stay consistent).
 */
export interface NatsOperatorKeys {
  /** Operator nkey seed (SO...). */
  operatorSeed: string;
  /** System account nkey seed (SA...). */
  systemAccountSeed: string;
  /** Tunnel account nkey seed (SA...). The account daemons are minted into. */
  tunnelAccountSeed: string;
  /** Tunnel account signing-key seed (SA...). Used to sign per-user daemon JWTs. */
  tunnelSigningSeed: string;
  /** Cluster service-user nkey seed (SU...). The cluster connects with this. */
  clusterUserSeed: string;
}

/**
 * The encoded artifacts derived from {@link NatsOperatorKeys}: the JWTs the
 * server config embeds, the public keys, and the cluster creds file body.
 */
export interface NatsOperatorArtifacts {
  operatorJwt: string;
  systemAccountPublicKey: string;
  systemAccountJwt: string;
  tunnelAccountPublicKey: string;
  tunnelAccountJwt: string;
  tunnelSigningPublicKey: string;
  /** Seed of the tunnel signing key (what `NATS_ACCOUNT_SIGNING_KEY` carries). */
  tunnelSigningSeed: string;
  clusterUserPublicKey: string;
  /** Full creds file body (JWT + seed) the cluster's TCP connection presents. */
  clusterCreds: string;
}

function seedString(kp: KeyPair): string {
  return new TextDecoder().decode(kp.getSeed());
}

function keyPairFromSeed(seed: string): KeyPair {
  return fromSeed(new TextEncoder().encode(seed));
}

/** Generate a fresh set of operator/account/user seeds. */
export function generateNatsOperatorKeys(): NatsOperatorKeys {
  const operatorKey = createOperator();
  const systemAccountKey = createAccount();
  const tunnelAccountKey = createAccount();
  const tunnelSigningKey = createAccount();
  const clusterUserKey = createUser();

  try {
    return {
      operatorSeed: seedString(operatorKey),
      systemAccountSeed: seedString(systemAccountKey),
      tunnelAccountSeed: seedString(tunnelAccountKey),
      tunnelSigningSeed: seedString(tunnelSigningKey),
      clusterUserSeed: seedString(clusterUserKey),
    };
  } finally {
    operatorKey.clear();
    systemAccountKey.clear();
    tunnelAccountKey.clear();
    tunnelSigningKey.clear();
    clusterUserKey.clear();
  }
}

/** Type guard: a value parsed from disk is a complete {@link NatsOperatorKeys}. */
export function isNatsOperatorKeys(value: unknown): value is NatsOperatorKeys {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.operatorSeed === "string" &&
    typeof v.systemAccountSeed === "string" &&
    typeof v.tunnelAccountSeed === "string" &&
    typeof v.tunnelSigningSeed === "string" &&
    typeof v.clusterUserSeed === "string"
  );
}

/**
 * Encode the JWTs / public keys / cluster creds from a set of seeds. Async
 * because `@nats-io/jwt` signing is async. Pure (no IO, no env).
 */
export async function buildNatsOperatorArtifacts(
  keys: NatsOperatorKeys,
): Promise<NatsOperatorArtifacts> {
  const operatorKey = keyPairFromSeed(keys.operatorSeed);
  const systemAccountKey = keyPairFromSeed(keys.systemAccountSeed);
  const tunnelAccountKey = keyPairFromSeed(keys.tunnelAccountSeed);
  const tunnelSigningKey = keyPairFromSeed(keys.tunnelSigningSeed);
  const clusterUserKey = keyPairFromSeed(keys.clusterUserSeed);

  try {
    const systemAccountJwt = await encodeAccount(
      "SYS",
      systemAccountKey,
      {},
      { algorithm: Algorithms.v2, signer: operatorKey },
    );

    const operatorJwt = await encodeOperator(
      "decocms-dev-operator",
      operatorKey,
      { system_account: systemAccountKey.getPublicKey() },
      { algorithm: Algorithms.v2 },
    );

    // Tunnel account: enable JetStream (the cluster's stream buffer needs it)
    // and list the signing key so per-user daemon JWTs signed with it verify.
    const tunnelAccountJwt = await encodeAccount(
      "tunnel",
      tunnelAccountKey,
      {
        signing_keys: [tunnelSigningKey.getPublicKey()],
        limits: {
          // -1 = unlimited (dev only).
          subs: -1,
          conn: -1,
          data: -1,
          payload: -1,
          imports: -1,
          exports: -1,
          wildcards: true,
          mem_storage: -1,
          disk_storage: -1,
          streams: -1,
          consumer: -1,
        },
      },
      { algorithm: Algorithms.v2, signer: operatorKey },
    );

    // Cluster service user: broad pub/sub, STANDARD (TCP) connection. Signed by
    // the tunnel account key itself (the account is the issuer).
    const clusterUserJwt = await encodeUser(
      "cluster-service",
      clusterUserKey,
      tunnelAccountKey,
      {
        pub: { allow: [">"] },
        sub: { allow: [">"] },
      },
      { algorithm: Algorithms.v2, signer: tunnelAccountKey },
    );

    const clusterCreds = new TextDecoder().decode(
      fmtCreds(clusterUserJwt, clusterUserKey),
    );

    return {
      operatorJwt,
      systemAccountPublicKey: systemAccountKey.getPublicKey(),
      systemAccountJwt,
      tunnelAccountPublicKey: tunnelAccountKey.getPublicKey(),
      tunnelAccountJwt,
      tunnelSigningPublicKey: tunnelSigningKey.getPublicKey(),
      tunnelSigningSeed: keys.tunnelSigningSeed,
      clusterUserPublicKey: clusterUserKey.getPublicKey(),
      clusterCreds,
    };
  } finally {
    operatorKey.clear();
    systemAccountKey.clear();
    tunnelAccountKey.clear();
    tunnelSigningKey.clear();
    clusterUserKey.clear();
  }
}

export interface NatsServerConfInput {
  tcpPort: number;
  wsPort: number;
  /** JetStream store directory (absolute path). */
  storeDir: string;
  /**
   * TCP listen interface. Defaults to loopback ("127.0.0.1"). The dev NATS
   * chaos harness (DECO_DEV_NATS_TOXIPROXY) sets "0.0.0.0" so the Toxiproxy
   * container can reach the server via host.docker.internal.
   */
  bindHost?: string;
  artifacts: Pick<
    NatsOperatorArtifacts,
    | "operatorJwt"
    | "systemAccountPublicKey"
    | "systemAccountJwt"
    | "tunnelAccountPublicKey"
    | "tunnelAccountJwt"
  >;
}

/**
 * Build the `nats-server.conf` body for operator mode with a MEMORY resolver,
 * JetStream, and a no-TLS WebSocket listener. Pure (no IO).
 *
 * NOTE: no `no_auth_user` — it is incompatible with Trusted Operator mode (the
 * server refuses to boot). The cluster authenticates with a creds file instead.
 */
export function buildNatsServerConf(input: NatsServerConfInput): string {
  const { tcpPort, wsPort, storeDir, artifacts } = input;
  const bindHost = input.bindHost ?? "127.0.0.1";
  return `# Generated by decocms dev — operator-mode NATS for the link tunnel.
# DO NOT edit by hand; regenerated from persisted seeds on each boot.

listen: ${bindHost}:${tcpPort}

operator: ${artifacts.operatorJwt}
system_account: ${artifacts.systemAccountPublicKey}

resolver: MEMORY
resolver_preload: {
  ${artifacts.systemAccountPublicKey}: ${artifacts.systemAccountJwt}
  ${artifacts.tunnelAccountPublicKey}: ${artifacts.tunnelAccountJwt}
}

jetstream {
  store_dir: "${storeDir}"
}

websocket {
  port: ${wsPort}
  no_tls: true
}
`;
}
