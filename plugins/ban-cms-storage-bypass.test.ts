import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const directory = `${root}/.cms-storage-boundary.tmp`;
beforeAll(() => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    `${directory}/.oxlintrc.json`,
    JSON.stringify({
      jsPlugins: ["../plugins/ban-cms-storage-bypass.js"],
      rules: { "ban-cms-storage-bypass/ban-cms-storage-bypass": "error" },
    }),
  );
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function diagnostics(path: string, code: string) {
  const file = `${directory}/${path}`;
  mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  writeFileSync(file, code);
  const process = Bun.spawn(
    [
      "node_modules/.bin/oxlint",
      "-c",
      `${directory}/.oxlintrc.json`,
      "-f",
      "json",
      file,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const result = JSON.parse(await new Response(process.stdout).text());
  await process.exited;
  return result.diagnostics.filter((item: { code: string }) =>
    item.code.includes("ban-cms-storage-bypass"),
  );
}

for (const [name, code] of [
  [
    "client",
    'import { createContentClient as client } from "@decocms/blocks/protocol"; export { client };',
  ],
  ["raw-url", "export const write = () => fetch(`/api/cms/${site}/drafts`);"],
  [
    "endpoint",
    'import { cmsDraftRpcEndpoint } from "@/cms/cms-api"; export { cmsDraftRpcEndpoint };',
  ],
  [
    "writer",
    "export const save = () => backend.client.blocksApply({ set: {} });",
  ],
  ["reader", 'export const read = () => backend.client["blocksList"]({});'],
  [
    "discard",
    "export const discard = () => client.changesDiscard({ names: [] });",
  ],
  [
    "namespace-client",
    'import * as protocol from "@decocms/blocks/protocol"; export const client = protocol.createContentClient({ endpoint: "https://example.test/rpc" });',
  ],
  [
    "namespace-helper",
    'import * as cms from "@/cms/cms-api"; export const endpoint = cms.cmsDraftRpcEndpoint("site", "draft");',
  ],
  [
    "factory-reexport",
    'export { createContentClient as factory } from "@decocms/blocks/protocol";',
  ],
  ["helper-reexport", 'export { cmsUrl as endpoint } from "@/cms/cms-api";'],
  ["protocol-reexport", 'export * from "@decocms/blocks/protocol";'],
  ["helpers-reexport", 'export * from "@/cms/cms-api";'],
  [
    "destructured-write",
    "const { blocksApply: apply } = backend.client; export const write = () => apply({ set: {} });",
  ],
  [
    "extracted-write",
    "const apply = backend.client.blocksApply; export const write = () => apply({ set: {} });",
  ],
  [
    "destructured-factory",
    'import * as protocol from "@decocms/blocks/protocol"; const { createContentClient: factory } = protocol; export const client = factory({ endpoint: "https://example.test/rpc" });',
  ],
  [
    "hosted-batch",
    'export const read = () => backend.hosted.batch([{ method: "cms.blocks", params: { names: ["CMS"] } }]);',
  ],
  [
    "protocol-batch",
    'export const write = () => backend.client.batch([{ method: "blocks.apply", params: { set: {} } }]);',
  ],
  [
    "dynamic-namespace",
    'const protocol = await import("@decocms/blocks/protocol"); export const client = protocol.createContentClient({ endpoint: "https://example.test/rpc" });',
  ],
  [
    "dynamic-member",
    'export const client = (await import("@decocms/blocks/protocol")).createContentClient({ endpoint: "https://example.test/rpc" });',
  ],
  [
    "namespace-alias",
    'import * as cms from "@/cms/cms-api"; const transport = cms; export const endpoint = transport.cmsUrl("site", "drafts");',
  ],
  [
    "mapped-batch",
    'export const read = () => rpc.batch(chunks.map(names => ({ method: "cms.blocks", params: { names } })));',
  ],
]) {
  test(`rejects a CMS ${name} bypass`, async () => {
    expect(
      await diagnostics(`apps/web/src/components/${name}.ts`, code),
    ).toHaveLength(1);
  });
}

test("allows CMS implementation, tests and legacy file writes", async () => {
  expect(
    await diagnostics(
      "apps/web/src/cms/storage.ts",
      "export const save = () => backend.client.blocksApply({});",
    ),
  ).toHaveLength(0);
  expect(
    await diagnostics(
      "apps/web/src/components/storage.test.ts",
      "export const save = () => backend.client.blocksApply({});",
    ),
  ).toHaveLength(0);
  expect(
    await diagnostics(
      "apps/web/src/components/legacy.ts",
      'export const save = () => fetch("/sandbox/write", { method: "POST" });',
    ),
  ).toHaveLength(0);
});

test("allows unrelated batch clients and public CMS helpers", async () => {
  expect(
    await diagnostics(
      "apps/web/src/components/unrelated.ts",
      'export const result = client.batch([{ method: "tools/list" }]);',
    ),
  ).toHaveLength(0);
  expect(
    await diagnostics(
      "apps/web/src/components/protocol-enums.ts",
      'import * as protocol from "@decocms/blocks/protocol"; export const code = protocol.ErrorCode;',
    ),
  ).toHaveLength(0);
  expect(
    await diagnostics(
      "apps/web/src/components/public-cms.ts",
      'import { cmsRequest, cmsSiteOf } from "@/cms/cms-api"; export { cmsRequest, cmsSiteOf };',
    ),
  ).toHaveLength(0);
});
