import { describe, expect, it } from "bun:test";
import { type Account, decode, fromSeed, type Operator } from "@nats-io/jwt";
import {
  buildNatsOperatorArtifacts,
  buildNatsServerConf,
  generateNatsOperatorKeys,
  isNatsOperatorKeys,
} from "./nats-operator-config";

function publicKeyOfSeed(seed: string): string {
  const kp = fromSeed(new TextEncoder().encode(seed));
  try {
    return kp.getPublicKey();
  } finally {
    kp.clear();
  }
}

describe("generateNatsOperatorKeys", () => {
  it("generates the five distinct seeds with the right nkey prefixes", () => {
    const keys = generateNatsOperatorKeys();

    // nkey seed prefixes: SO=operator, SA=account, SU=user.
    expect(keys.operatorSeed.startsWith("SO")).toBe(true);
    expect(keys.systemAccountSeed.startsWith("SA")).toBe(true);
    expect(keys.tunnelAccountSeed.startsWith("SA")).toBe(true);
    expect(keys.tunnelSigningSeed.startsWith("SA")).toBe(true);
    expect(keys.clusterUserSeed.startsWith("SU")).toBe(true);

    // The tunnel account and its signing key must be different identities.
    expect(keys.tunnelAccountSeed).not.toBe(keys.tunnelSigningSeed);
  });

  it("generates fresh keys on each call", () => {
    const a = generateNatsOperatorKeys();
    const b = generateNatsOperatorKeys();
    expect(a.operatorSeed).not.toBe(b.operatorSeed);
    expect(a.tunnelAccountSeed).not.toBe(b.tunnelAccountSeed);
  });
});

describe("isNatsOperatorKeys", () => {
  it("accepts a complete key set", () => {
    expect(isNatsOperatorKeys(generateNatsOperatorKeys())).toBe(true);
  });

  it("rejects partial / malformed values", () => {
    expect(isNatsOperatorKeys(null)).toBe(false);
    expect(isNatsOperatorKeys({})).toBe(false);
    expect(isNatsOperatorKeys({ operatorSeed: "SO..." })).toBe(false);
    const { clusterUserSeed: _omit, ...partial } = generateNatsOperatorKeys();
    expect(isNatsOperatorKeys(partial)).toBe(false);
  });
});

describe("buildNatsOperatorArtifacts", () => {
  it("produces JWTs that decode and reference the expected identities", async () => {
    const keys = generateNatsOperatorKeys();
    const artifacts = await buildNatsOperatorArtifacts(keys);

    // Operator JWT decodes and lists the system account.
    const op = decode<Operator>(artifacts.operatorJwt);
    expect(op.sub).toBe(publicKeyOfSeed(keys.operatorSeed));
    expect(op.nats.system_account).toBe(
      publicKeyOfSeed(keys.systemAccountSeed),
    );

    // Public keys match their seeds.
    expect(artifacts.systemAccountPublicKey).toBe(
      publicKeyOfSeed(keys.systemAccountSeed),
    );
    expect(artifacts.tunnelAccountPublicKey).toBe(
      publicKeyOfSeed(keys.tunnelAccountSeed),
    );
    expect(artifacts.tunnelSigningPublicKey).toBe(
      publicKeyOfSeed(keys.tunnelSigningSeed),
    );
    expect(artifacts.clusterUserPublicKey).toBe(
      publicKeyOfSeed(keys.clusterUserSeed),
    );

    // The signing seed is passed through verbatim (what NATS_ACCOUNT_SIGNING_KEY carries).
    expect(artifacts.tunnelSigningSeed).toBe(keys.tunnelSigningSeed);
  });

  it("lists the signing key on the tunnel account JWT", async () => {
    const keys = generateNatsOperatorKeys();
    const artifacts = await buildNatsOperatorArtifacts(keys);

    const acc = decode<Account>(artifacts.tunnelAccountJwt);
    expect(acc.sub).toBe(publicKeyOfSeed(keys.tunnelAccountSeed));
    expect(acc.nats.signing_keys).toContain(
      publicKeyOfSeed(keys.tunnelSigningSeed),
    );
  });

  it("emits a cluster creds file containing both the JWT and the seed", async () => {
    const keys = generateNatsOperatorKeys();
    const artifacts = await buildNatsOperatorArtifacts(keys);

    expect(artifacts.clusterCreds).toContain("-----BEGIN NATS USER JWT-----");
    expect(artifacts.clusterCreds).toContain("-----BEGIN USER NKEY SEED-----");
    // The embedded seed is the cluster user's seed.
    expect(artifacts.clusterCreds).toContain(keys.clusterUserSeed);
  });

  it("is deterministic for a fixed key set (idempotent reuse across boots)", async () => {
    const keys = generateNatsOperatorKeys();
    const a = await buildNatsOperatorArtifacts(keys);
    const b = await buildNatsOperatorArtifacts(keys);

    // The public keys / signing seed are stable; the JWT bodies decode to the
    // same subjects (the raw JWT may differ by iat, but identities are stable).
    expect(a.tunnelAccountPublicKey).toBe(b.tunnelAccountPublicKey);
    expect(decode<Account>(a.tunnelAccountJwt).sub).toBe(
      decode<Account>(b.tunnelAccountJwt).sub,
    );
  });
});

describe("buildNatsServerConf", () => {
  it("includes operator, resolver, websocket, jetstream — and NO no_auth_user", async () => {
    const keys = generateNatsOperatorKeys();
    const artifacts = await buildNatsOperatorArtifacts(keys);
    const conf = buildNatsServerConf({
      tcpPort: 14222,
      wsPort: 14223,
      storeDir: "/tmp/dev-nats/js",
      artifacts,
    });

    expect(conf).toContain("listen: 127.0.0.1:14222");
    expect(conf).toContain(`operator: ${artifacts.operatorJwt}`);
    expect(conf).toContain(
      `system_account: ${artifacts.systemAccountPublicKey}`,
    );
    expect(conf).toContain("resolver: MEMORY");
    expect(conf).toContain(
      `${artifacts.systemAccountPublicKey}: ${artifacts.systemAccountJwt}`,
    );
    expect(conf).toContain(
      `${artifacts.tunnelAccountPublicKey}: ${artifacts.tunnelAccountJwt}`,
    );
    expect(conf).toContain('store_dir: "/tmp/dev-nats/js"');
    expect(conf).toContain("websocket {");
    expect(conf).toContain("port: 14223");
    expect(conf).toContain("no_tls: true");

    // no_auth_user is incompatible with Trusted Operator mode — must be absent.
    expect(conf).not.toContain("no_auth_user");
  });
});
