import { describe, expect, test } from "bun:test";
import {
  type BatchCall,
  type BatchOutcome,
  type ContentClient,
  PROTOCOL_NAME,
  PROTOCOL_VERSION,
} from "@decocms/blocks/protocol";
import { selectContentBackend } from "./content-backend";
import { probe } from "./use-content-backend";

const deco1 = {
  manifest: { blocks: {} },
  schema: { definitions: {}, root: {} },
};

/** The GitHub backend answering `describe` + `schema.get` with `schema`. */
function githubServing(schema: unknown): ContentClient {
  return {
    batch: async (calls: BatchCall[]) =>
      calls.map(
        (call): BatchOutcome =>
          call.method === "describe"
            ? {
                ok: true,
                result: { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION },
              }
            : {
                ok: true,
                result: {
                  notModified: false,
                  version: "s1",
                  resolvedRef: "main",
                  schema,
                },
              },
      ),
  } as unknown as ContentClient;
}

/** What `useContentBackend` decides for a flag-on Fast Preview session. */
async function decideWithFlagOn(schema: unknown) {
  const probed = await probe(githubServing(schema));
  return selectContentBackend({
    hasProject: true,
    flagEnabled: true,
    hasServeConnection: false,
    hasLocalTunnel: false,
    runtime: "cms",
    githubSite: probed.v8Schema ? "v8" : "v7",
  });
}

describe("v7/v8 detection over the GitHub backend", () => {
  test('a schema with "blocksMajor": 8 is a v8 site', async () => {
    expect(await decideWithFlagOn({ major: 1, blocksMajor: 8, ...deco1 })).toBe(
      "protocol-github",
    );
  });

  // The server serves `schema.gen.json`, else a v7 `meta.gen.json`, as
  // written: the file name never makes a site v8, only the field does.
  test("a committed schema without blocksMajor stays v7 with the flag on", async () => {
    // A v7 `meta.gen.json`, and a `schema.gen.json` from an older `deco schema`.
    expect(await decideWithFlagOn(deco1)).toBe("legacy");
    expect(await decideWithFlagOn({ major: 1, ...deco1 })).toBe("legacy");
  });

  test("any other blocksMajor stays v7", async () => {
    for (const blocksMajor of [7, "8", null, 9]) {
      expect(await decideWithFlagOn({ major: 1, blocksMajor, ...deco1 })).toBe(
        "legacy",
      );
    }
  });

  test("no committed schema stays v7", async () => {
    expect(await decideWithFlagOn(null)).toBe("legacy");
  });
});
