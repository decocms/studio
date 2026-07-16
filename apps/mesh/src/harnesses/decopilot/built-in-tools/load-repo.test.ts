import { expect, test } from "bun:test";
import { buildDescription } from "./load-repo";

test("buildDescription lists each repo with its connectionId", () => {
  const desc = buildDescription([
    { connectionId: "conn_a", owner: "acme", repo: "web", installationId: 1 },
    { connectionId: "conn_b", owner: "acme", repo: "api", installationId: 2 },
  ]);
  expect(desc).toContain("acme/web (connectionId: conn_a)");
  expect(desc).toContain("acme/api (connectionId: conn_b)");
  // The model is told to pass a connectionId.
  expect(desc).toContain("connectionId of the repo to load");
});
