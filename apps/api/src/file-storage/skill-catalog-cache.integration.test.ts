/**
 * Skill catalog cache — storage-integration tier (real NATS JetStream, zero
 * mocks). See TESTING.md.
 *
 * The property under test is a concurrency guard, and it is enforced by the
 * KV's own compare-and-swap. A hand-written double would only prove the double
 * behaves as written, so this runs against a real server.
 *
 * Local run:
 *   nats-server -js -p 4222
 *   bun test apps/api/src/file-storage/skill-catalog-cache.integration.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { jetstream } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/nats-core";
import { connect } from "@nats-io/transport-node";
import { JetStreamKVSkillCatalogCache } from "./skill-catalog-cache";
import type { SkillCatalogEntry } from "./skill-catalog";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";

function entry(name: string): SkillCatalogEntry {
  return {
    id: `home/${name}`,
    name,
    description: null,
    source: "home",
    sandboxPath: `org/home/${name}`,
    volume: "home",
    path: name,
  };
}

const PRE_WRITE = [entry("pre-write")];
const POST_WRITE = [entry("pre-write"), entry("just-imported")];

describe("JetStreamKVSkillCatalogCache (integration)", () => {
  let nc: NatsConnection;
  let cache: JetStreamKVSkillCatalogCache;

  beforeAll(async () => {
    nc = await connect({ servers: NATS_URL, timeout: 5_000 });
    cache = new JetStreamKVSkillCatalogCache({
      getJetStream: () => jetstream(nc),
    });
    await cache.init();
  });

  afterAll(async () => {
    cache?.teardown();
    await nc?.drain();
  });

  // The bucket is shared with every other worker; a per-test org keeps the
  // assertions isolated.
  let n = 0;
  const orgId = () => `org-${process.pid}-${Date.now()}-${n++}`;

  it("round-trips a catalog and reports a miss for an unknown org", async () => {
    const org = orgId();
    expect(await cache.get(org)).toEqual({ catalog: null });

    await cache.set(org, POST_WRITE);
    expect((await cache.get(org)).catalog).toEqual(POST_WRITE);
  });

  it("caches an empty catalog as an answer, not as a miss", async () => {
    // An org with no skills is a real result; re-scanning every volume to
    // re-learn it is the expensive case.
    const org = orgId();
    await cache.set(org, []);
    expect((await cache.get(org)).catalog).toEqual([]);
  });

  it("reads as a miss after invalidation", async () => {
    const org = orgId();
    await cache.set(org, POST_WRITE);
    await cache.invalidate(org);
    expect((await cache.get(org)).catalog).toBeNull();
  });

  it("drops a build that an invalidation overtook, on a cold key", async () => {
    const org = orgId();
    // A build starts: it reads a miss and carries the revision forward.
    const inFlight = await cache.get(org);
    // A skill is imported while that build is still scanning storage.
    await cache.invalidate(org);
    // The build finishes and tries to publish its pre-import result.
    await cache.set(org, PRE_WRITE, inFlight.revision);

    expect((await cache.get(org)).catalog).toBeNull();
  });

  it("drops a build that an invalidation overtook, on a warm key", async () => {
    const org = orgId();
    await cache.set(org, PRE_WRITE);

    const inFlight = await cache.get(org);
    await cache.invalidate(org);
    await cache.set(org, PRE_WRITE, inFlight.revision);

    expect((await cache.get(org)).catalog).toBeNull();
  });

  it("lets one of two concurrent builds win instead of clobbering", async () => {
    const org = orgId();
    const a = await cache.get(org);
    const b = await cache.get(org);

    await cache.set(org, POST_WRITE, a.revision);
    await cache.set(org, PRE_WRITE, b.revision);

    expect((await cache.get(org)).catalog).toEqual(POST_WRITE);
  });

  it("still publishes an uncontended refresh", async () => {
    // The guard must not wedge the normal path: a build that nothing raced
    // has to land, or the cache would never warm at all.
    const org = orgId();
    await cache.set(org, PRE_WRITE, (await cache.get(org)).revision);

    const hit = await cache.get(org);
    expect(hit.catalog).toEqual(PRE_WRITE);

    await cache.set(org, POST_WRITE, hit.revision);
    expect((await cache.get(org)).catalog).toEqual(POST_WRITE);
  });

  it("is inert without a JetStream client", async () => {
    // The no-NATS deployment path: every read is a miss and nothing throws.
    const inert = new JetStreamKVSkillCatalogCache({
      getJetStream: () => null,
    });
    await inert.init();

    const org = orgId();
    expect(await inert.get(org)).toEqual({ catalog: null });
    await inert.set(org, POST_WRITE);
    await inert.invalidate(org);
    expect(await inert.get(org)).toEqual({ catalog: null });
  });
});
