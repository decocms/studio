import { describe, expect, test } from "bun:test";
import { apiKeyIdsToRevoke } from "./member-removal";

const ORG = "org_example";

describe("apiKeyIdsToRevoke", () => {
  test("revokes keys bound to the org, stored as JSON text or objects", () => {
    expect(
      apiKeyIdsToRevoke(
        [
          {
            id: "text",
            metadata: JSON.stringify({ organization: { id: ORG } }),
          },
          { id: "object", metadata: { organization: { id: ORG, slug: "x" } } },
        ],
        ORG,
      ),
    ).toEqual(["text", "object"]);
  });

  test("keeps keys bound to other orgs or to no org", () => {
    expect(
      apiKeyIdsToRevoke(
        [
          { id: "other", metadata: { organization: { id: "org_other" } } },
          { id: "webhook", metadata: { kind: "webhook_trigger" } },
          { id: "none" },
          { id: "null", metadata: null },
          { id: "empty", metadata: "" },
          { id: "garbage", metadata: "{not json" },
          { id: "bad-shape", metadata: { organization: ORG } },
        ],
        ORG,
      ),
    ).toEqual([]);
  });

  test("keeps the org's own default-connection keys", () => {
    expect(
      apiKeyIdsToRevoke(
        [
          {
            id: "self",
            metadata: {
              organization: { id: ORG },
              purpose: "default-org-connections",
            },
          },
          {
            id: "custom-purpose",
            metadata: { organization: { id: ORG }, purpose: "integration" },
          },
        ],
        ORG,
      ),
    ).toEqual(["custom-purpose"]);
  });
});
