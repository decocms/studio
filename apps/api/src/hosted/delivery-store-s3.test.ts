/**
 * The S3 delivery store against a fake S3 endpoint: how R2's answers to a
 * conditional PUT map (contract §2.6), and that conditional PUTs are sent
 * once (SDK retries off), while plain writes keep the SDK's retries.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { getSettings, setGlobalSettings } from "@/settings";
import { resolveConfig } from "@/settings/resolve-config";
import { newRevisionId } from "./revision-id";
import {
  createS3DeliveryStore,
  DeliveryUnavailableError,
  deliveryKeys,
  ObjectChangedError,
} from "./delivery-store";

let answer: { status: number; code: string } = { status: 200, code: "" };
const seen: Array<{
  method: string;
  path: string;
  ifMatch: string | null;
  ifNoneMatch: string | null;
}> = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    seen.push({
      method: req.method,
      path: url.pathname,
      ifMatch: req.headers.get("if-match"),
      ifNoneMatch: req.headers.get("if-none-match"),
    });
    if (answer.status === 200) {
      return new Response("", { status: 200, headers: { ETag: '"e1"' } });
    }
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${answer.code}</Code><Message>x</Message></Error>`,
      { status: answer.status, headers: { "content-type": "application/xml" } },
    );
  },
});
afterAll(() => server.stop(true));

const store = createS3DeliveryStore({
  endpoint: `http://127.0.0.1:${server.port}`,
  bucket: "b",
  accessKeyId: "k",
  secretAccessKey: "s",
});

async function putWith(status: number, code: string, conditional: boolean) {
  answer = { status, code };
  seen.length = 0;
  return store
    .putJson(
      "sites/acme/latest.json",
      {},
      "",
      conditional ? { ifMatch: '"e0"' } : undefined,
    )
    .then(
      () => "ok" as const,
      (error: unknown) => error,
    );
}

describe("createS3DeliveryStore conditional PUTs", () => {
  it("412 and 409 are a lost race", async () => {
    expect(await putWith(412, "PreconditionFailed", true)).toBeInstanceOf(
      ObjectChangedError,
    );
    expect(seen.length).toBe(1);
    expect(seen[0]?.ifMatch).toBe('"e0"');
    expect(
      await putWith(409, "ConditionalRequestConflict", true),
    ).toBeInstanceOf(ObjectChangedError);
  });

  it("429 and 5xx are Unavailable, sent exactly once (no SDK retry)", async () => {
    for (const [status, code] of [
      [429, "SlowDown"],
      [500, "InternalError"],
      [503, "ServiceUnavailable"],
    ] as const) {
      const error = await putWith(status, code, true);
      expect(error).toBeInstanceOf(DeliveryUnavailableError);
      expect(seen.length).toBe(1);
    }
  });

  it("delete and listPage map 429/5xx to Unavailable, like get", async () => {
    for (const [status, code] of [
      [429, "SlowDown"],
      [503, "ServiceUnavailable"],
    ] as const) {
      answer = { status, code };
      const deleted = await store.delete("sites/acme/drafts/x.json").then(
        () => "ok" as const,
        (error: unknown) => error,
      );
      expect(deleted).toBeInstanceOf(DeliveryUnavailableError);
      const listed = await store
        .listPage("sites/acme/revisions/", {
          delimiter: "/",
          maxKeys: 50,
          continuationToken: null,
        })
        .then(
          () => "ok" as const,
          (error: unknown) => error,
        );
      expect(listed).toBeInstanceOf(DeliveryUnavailableError);
    }
    answer = { status: 200, code: "" };
  });

  it("an unconditional write keeps the SDK's retries", async () => {
    const error = await putWith(503, "ServiceUnavailable", false);
    expect(error).not.toBeInstanceOf(ObjectChangedError);
    expect(seen.length).toBeGreaterThan(1);
  });

  it("putText sends the text as is, create-only", async () => {
    answer = { status: 200, code: "" };
    seen.length = 0;
    await store.putText("sites/acme/x.json", '{"a":"\\u00e1"}', "", {
      ifNoneMatch: "*",
    });
    expect(seen[0]?.ifNoneMatch).toBe("*");
  });
});

describe("deliveryKeys for revisions", () => {
  it("keys a revision as a folder with index.json and meta.json", () => {
    const id = newRevisionId();
    expect(deliveryKeys.revisionIndex("acme", id)).toBe(
      `sites/acme/revisions/${id}/index.json`,
    );
    expect(deliveryKeys.revisionMeta("acme", id)).toBe(
      `sites/acme/revisions/${id}/meta.json`,
    );
    expect(() => deliveryKeys.revisionIndex("acme", "a".repeat(40))).toThrow();
  });

  it("prefixes every key with DELIVERY_KEY_PREFIX (test-only)", () => {
    expect(
      resolveConfig({ DELIVERY_KEY_PREFIX: "spikes/e2e/" }).deliveryKeyPrefix,
    ).toBe("spikes/e2e/");
    const before = getSettings();
    setGlobalSettings({ ...before, deliveryKeyPrefix: "spikes/e2e/" });
    try {
      // Another test file may have replaced `@/settings` in this run: the
      // prefix is then whatever its settings say.
      const prefix = getSettings().deliveryKeyPrefix ?? "";
      expect(deliveryKeys.latest("acme")).toBe(
        `${prefix}sites/acme/latest.json`,
      );
    } finally {
      setGlobalSettings(before);
    }
  });
});
