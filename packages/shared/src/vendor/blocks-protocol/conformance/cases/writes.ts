/**
 * `blocks.apply`: atomic set and delete, set precedence, validation, the
 * file-name rule and preconditions.
 */
import { ErrorCode, type InvalidBlockData } from "../../errors";
import type { BlocksListResult } from "../../types";
import {
  assert,
  assertEqual,
  type ConformanceContext,
  expectError,
} from "../context";
import type { ConformanceCase } from "./types";

type FullList = Extract<BlocksListResult, { notModified: false }>;

async function list(ctx: ConformanceContext): Promise<FullList> {
  const result = await ctx.client.blocksList();
  assert(!result.notModified, "an unconditional list returns the map");
  return result;
}

async function writable(ctx: ConformanceContext) {
  const d = await ctx.describe();
  if (d.readOnly) return ctx.skip("read-only endpoint");
  return d;
}

function violations(error: { data: unknown }): InvalidBlockData["violations"] {
  const data = error.data as InvalidBlockData | undefined;
  assert(
    Array.isArray(data?.violations),
    "InvalidBlock carries data.violations",
  );
  return data!.violations;
}

export const writeCases: ConformanceCase[] = [
  {
    id: "apply/create-and-read",
    title:
      "a write returns versions and a revision that blocks.list then reports",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("create");
      const value = {
        __resolveType: "hero",
        title: "Olá — 世界",
        items: [1, { a: null }],
      };
      const result = await ctx.client.blocksApply({ set: { [name]: value } });
      assert(typeof result.revision === "string", "a revision");
      assert(
        typeof result.versions[name] === "string",
        "a version for the entry",
      );
      const after = await list(ctx);
      assertEqual(after.blocks[name], value, "the stored entry");
      assertEqual(
        after.versions[name],
        result.versions[name],
        "the listed version",
      );
      assertEqual(after.revision, result.revision, "the listed revision");
      const poll = await ctx.client.blocksList({
        ifNoneMatch: result.revision,
      });
      assert(
        poll.notModified,
        "polling with the returned revision is 'not modified'",
      );
    },
  },
  {
    id: "apply/atomic-set-delete",
    title: "set and delete land together",
    async run(ctx) {
      await writable(ctx);
      const [a, b, c] = [ctx.name("a"), ctx.name("b"), ctx.name("c")];
      await ctx.client.blocksApply({ set: { [a]: { v: 1 }, [b]: { v: 2 } } });
      const result = await ctx.client.blocksApply({
        set: { [c]: { v: 3 } },
        delete: [a],
      });
      assertEqual(
        result.versions[a],
        null,
        "a deleted entry's version is null",
      );
      const after = await list(ctx);
      assert(!(a in after.blocks), "the deleted entry is gone");
      assertEqual(after.blocks[b], { v: 2 }, "the untouched entry stays");
      assertEqual(after.blocks[c], { v: 3 }, "the new entry exists");
    },
  },
  {
    id: "apply/set-wins",
    title: "set wins when a name is in both set and delete",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("both");
      const result = await ctx.client.blocksApply({
        set: { [name]: { kept: true } },
        delete: [name],
      });
      assert(
        typeof result.versions[name] === "string",
        "the entry has a version",
      );
      assertEqual(
        (await list(ctx)).blocks[name],
        { kept: true },
        "the entry exists",
      );
    },
  },
  {
    id: "apply/delete-missing",
    title: "deleting a missing name counts as deleted",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("missing");
      const result = await ctx.client.blocksApply({ delete: [name] });
      assertEqual(result.versions, { [name]: null }, "versions");
    },
  },
  {
    id: "apply/whole-entry-replace",
    title: "set replaces the whole entry (no merge)",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("replace");
      await ctx.client.blocksApply({ set: { [name]: { a: 1, b: 2 } } });
      await ctx.client.blocksApply({ set: { [name]: { b: 3 } } });
      assertEqual((await list(ctx)).blocks[name], { b: 3 }, "the entry");
    },
  },
  {
    id: "apply/all-or-nothing-validation",
    title: "every violation is reported at once and nothing is written",
    async run(ctx) {
      await writable(ctx);
      const good = ctx.name("good");
      const error = await expectError(
        ctx.client.blocksApply({
          set: {
            [good]: { ok: true },
            [ctx.name("array")]: [] as never,
            [ctx.name("null")]: null as never,
          },
        }),
        ErrorCode.InvalidBlock,
        "invalid values",
      );
      assertEqual(
        violations(error).length,
        2,
        "one violation per invalid entry",
      );
      assert(
        !(good in (await list(ctx)).blocks),
        "the valid entry wasn't written",
      );
    },
  },
  {
    id: "apply/name-rules",
    title: "names the site editor can't save are refused",
    async run(ctx) {
      await writable(ctx);
      const p = ctx.prefix;
      const bad = [
        "",
        `${p}\\x`,
        `${p}..x`,
        "CON",
        "con.backup",
        "__proto__",
        `${p}-mod.ts`,
        `${p}-mod.tsx`,
        `.${p}-hidden`,
        ".",
      ];
      bad.push(`${p}-${"é".repeat(60)}`); // 360 encoded bytes
      for (const name of bad) {
        const error = await expectError(
          ctx.client.blocksApply({ set: { [name]: { x: 1 } } }),
          ErrorCode.InvalidBlock,
          `the name ${JSON.stringify(name)}`,
        );
        assert(
          violations(error).some((v) => v.name === name),
          `a violation names ${JSON.stringify(name)}`,
        );
      }
      // A name ending in a source extension can still be deleted.
      const result = await ctx.client.blocksApply({ delete: [`${p}-mod.ts`] });
      assertEqual(
        result.versions,
        { [`${p}-mod.ts`]: null },
        "deleting a .ts name",
      );
    },
  },
  {
    id: "apply/case-collision",
    title:
      "a new name that differs from another entry's only in letter case is refused",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("CaseName");
      await ctx.client.blocksApply({ set: { [name]: { v: 1 } } });
      await expectError(
        ctx.client.blocksApply({ set: { [name.toLowerCase()]: { v: 2 } } }),
        ErrorCode.InvalidBlock,
        "a case variant",
      );
      await ctx.client.blocksApply({ set: { [name]: { v: 3 } } });
      assertEqual(
        (await list(ctx)).blocks[name],
        { v: 3 },
        "updating the existing name",
      );
    },
  },
  {
    id: "apply/spellings",
    title:
      "two spellings of one name are one entry: guards see either, and a write keeps only the written spelling",
    async run(ctx) {
      await writable(ctx);
      const encoded = `${ctx.prefix}-Home%20Page`;
      const literal = `${ctx.prefix}-Home Page`;
      ctx.track(encoded);
      ctx.track(literal);
      await expectError(
        ctx.client.blocksApply({
          set: { [encoded]: { v: 1 }, [literal]: { v: 2 } },
        }),
        ErrorCode.InvalidBlock,
        "both spellings in one write",
      );
      const created = await ctx.client.blocksApply({
        set: { [encoded]: { v: 1 } },
      });
      // Create-only under another spelling: the entry exists, so the guard fails.
      const error = await expectError(
        ctx.client.blocksApply({
          set: { [literal]: { v: 2 } },
          ifMatch: { [literal]: null },
        }),
        ErrorCode.Conflict,
        "create-only on another spelling of an existing entry",
      );
      assertEqual(
        (error.data as { entries?: unknown }).entries,
        { [literal]: { expected: null, actual: created.versions[encoded] } },
        "the conflict reports the existing spelling's version",
      );
      assertEqual(
        (await list(ctx)).blocks[encoded],
        { v: 1 },
        "nothing was deleted",
      );
      // A guard on one spelling holds for the other.
      const written = await ctx.client.blocksApply({
        set: { [literal]: { v: 2 } },
        ifMatch: { [literal]: created.versions[encoded]! },
      });
      assertEqual(
        written.versions[encoded],
        null,
        "the result reports the deleted spelling as gone, so a client's map drops it",
      );
      assert(
        typeof written.versions[literal] === "string",
        "the written spelling has a version",
      );
      const after = await list(ctx);
      assertEqual(after.blocks[literal], { v: 2 }, "the written spelling");
      assert(
        !(encoded in after.blocks),
        "the other spelling was deleted in the same commit",
      );
      assert(
        !after.diagnostics.some(
          (d) => d.name === literal || d.name === encoded,
        ),
        "no shadowed spelling is left",
      );
    },
  },
  {
    id: "apply/if-match",
    title:
      "ifMatch guards a write; a failed guard writes nothing and reports versions",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("guarded");
      const other = ctx.name("other");
      const created = await ctx.client.blocksApply({
        set: { [name]: { v: 1 } },
        ifMatch: { [name]: null },
      });
      const v1 = created.versions[name]!;
      const error = await expectError(
        ctx.client.blocksApply({
          set: { [name]: { v: 2 }, [other]: { v: 2 } },
          ifMatch: { [name]: `${v1}x` },
        }),
        ErrorCode.Conflict,
        "a stale version",
      );
      assertEqual(
        (error.data as { entries?: unknown }).entries,
        { [name]: { expected: `${v1}x`, actual: v1 } },
        "the conflict's versions",
      );
      const after = await list(ctx);
      assertEqual(
        after.blocks[name],
        { v: 1 },
        "the guarded entry is unchanged",
      );
      assert(!(other in after.blocks), "nothing else was written");
      await expectError(
        ctx.client.blocksApply({
          set: { [name]: { v: 3 } },
          ifMatch: { [name]: null },
        }),
        ErrorCode.Conflict,
        "create-only on an existing entry",
      );
      const updated = await ctx.client.blocksApply({
        set: { [name]: { v: 4 } },
        ifMatch: { [name]: v1 },
      });
      assert(updated.versions[name] !== v1, "a matching version writes");
    },
  },
  {
    id: "apply/rename-recipe",
    title: "renaming is a set plus a delete, create-only on the new name",
    async run(ctx) {
      await writable(ctx);
      const from = ctx.name("from");
      const to = ctx.name("to");
      const created = await ctx.client.blocksApply({
        set: { [from]: { v: 1 } },
      });
      await ctx.client.blocksApply({
        set: { [to]: { v: 1 } },
        delete: [from],
        ifMatch: { [to]: null, [from]: created.versions[from]! },
      });
      const after = await list(ctx);
      assert(!(from in after.blocks) && to in after.blocks, "the entry moved");
    },
  },
  {
    id: "apply/schema-precondition",
    title: "ifSchemaMatch rejects a write when the schema changed",
    async run(ctx) {
      const d = await writable(ctx);
      const name = ctx.name("schema-guarded");
      if (!d.writes.schemaPreconditions) {
        await expectError(
          ctx.client.blocksApply({ set: { [name]: {} }, ifSchemaMatch: "x" }),
          ErrorCode.Unsupported,
          "an unadvertised guard",
        );
        return;
      }
      if (ctx.options.hasSchema === false) return ctx.skip("no schema");
      const { version } = await ctx.client.schemaGet();
      const error = await expectError(
        ctx.client.blocksApply({
          set: { [name]: {} },
          ifSchemaMatch: `${version}-old`,
        }),
        ErrorCode.Conflict,
        "a stale schema version",
      );
      assertEqual(
        (error.data as { schema?: unknown }).schema,
        { expected: `${version}-old`, actual: version },
        "the conflict's schema versions",
      );
      assert(!(name in (await list(ctx)).blocks), "nothing was written");
      await ctx.client.blocksApply({
        set: { [name]: {} },
        ifSchemaMatch: version,
      });
    },
  },
  {
    id: "apply/unknown-params",
    title:
      "an unknown parameter is refused, so an unknown guard never becomes an unguarded write",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("unknown-param");
      await expectError(
        ctx.client.call("blocks.apply", {
          set: { [name]: {} },
          ifUnmodifiedSince: "x",
        } as never),
        ErrorCode.InvalidParams,
        "an unknown guard",
      );
      assert(!(name in (await list(ctx)).blocks), "nothing was written");
    },
  },
  {
    id: "apply/read-only",
    title: "a write to a read-only endpoint is ReadOnly",
    async run(ctx) {
      const d = await ctx.describe();
      if (!d.readOnly) return ctx.skip("the endpoint accepts writes");
      await expectError(
        ctx.client.blocksApply({ delete: ["x"] }),
        ErrorCode.ReadOnly,
        "a write",
      );
    },
  },
  {
    id: "apply/last-writer-wins",
    title: "without guards, the later of two writes wins",
    async run(ctx) {
      await writable(ctx);
      const name = ctx.name("lww");
      await Promise.all([
        ctx.client.blocksApply({ set: { [name]: { from: "a" } } }),
        ctx.client.blocksApply({ set: { [name]: { from: "b" } } }),
      ]);
      const value = (await list(ctx)).blocks[name] as { from: string };
      assert(
        value.from === "a" || value.from === "b",
        "one of the writes is stored whole",
      );
      await ctx.client.blocksApply({ set: { [name]: { from: "c" } } });
      assertEqual(
        (await list(ctx)).blocks[name],
        { from: "c" },
        "the latest write",
      );
    },
  },
];
