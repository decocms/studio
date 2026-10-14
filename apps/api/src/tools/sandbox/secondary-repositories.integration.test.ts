import { afterAll, beforeAll, expect, test } from "bun:test";
import { RepositoryStorage } from "../../storage/repositories";
import {
  buildThreadTestContext,
  type ThreadTestEnv,
} from "../thread/test-helpers";
import { buildExtraRepoOpts } from "./start";

let env: ThreadTestEnv;
beforeAll(async () => {
  env = await buildThreadTestContext();
});
afterAll(async () => {
  await env.close();
});

test("sandbox recreation retains a secondary with the same path on another provider", async () => {
  const repositories = new RepositoryStorage(env.database.db);
  const primary = {
    owner: "example",
    name: "site",
    url: "https://github.com/example/site",
  };
  const record = await repositories.upsert({
    organizationId: env.orgId,
    ref: { provider: "gitlab", host: "gitlab.com", path: "example/site" },
  });
  const secondary = {
    ...primary,
    url: "https://gitlab.com/example/site",
    repositoryId: record.id,
  };
  const result = await buildExtraRepoOpts({
    ctx: { ...env.ctx, storage: { ...env.ctx.storage, repositories } },
    orgId: env.orgId,
    primary,
    repos: [primary, secondary],
    gitUserName: "Example User",
    gitUserEmail: "user@example.com",
    submoduleCredentials: [],
  });
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    repositoryId: record.id,
    cloneUrl: "https://gitlab.com/example/site.git",
    directoryName: "site",
  });
});
