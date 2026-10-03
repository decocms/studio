/**
 * Uploads beside the protocol: `PUT /assets/<name>`. These cases run only
 * when the harness passes `assetsEndpoint`.
 */
import { ErrorCode } from "../../errors";
import {
  assert,
  assertEqual,
  type ConformanceContext,
  rawErrorCode,
} from "../context";
import type { ConformanceCase } from "./types";

/** The smallest PNG header: enough bytes for an upload, never executed. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function uploadsAccepted(ctx: ConformanceContext) {
  if (ctx.options.assetsEndpoint === undefined)
    return ctx.skip("no assetsEndpoint");
  const d = await ctx.describe();
  if (d.readOnly || d.assets === null)
    return ctx.skip("the endpoint doesn't accept uploads");
  return d;
}

const pathOf = (body: unknown) => (body as { path?: unknown } | null)?.path;

export const assetCases: ConformanceCase[] = [
  {
    id: "assets/upload",
    title:
      "an upload answers 201 with /assets/<name>; a taken name gets a suffix, never an overwrite",
    async run(ctx) {
      await uploadsAccepted(ctx);
      const name = `${ctx.prefix}-banner.png`;
      const first = await ctx.upload(name, PNG, "image/png");
      assertEqual(first.status, 201, "HTTP status");
      assertEqual(pathOf(first.body), `/assets/${name}`, "the stored path");
      const second = await ctx.upload(name, PNG, "image/png");
      assertEqual(second.status, 201, "HTTP status of the second upload");
      const path = pathOf(second.body);
      assert(
        typeof path === "string" &&
          path.startsWith("/assets/") &&
          path !== `/assets/${name}`,
        `a taken name gets another name, got ${String(path)}`,
      );
      assert(path.endsWith(".png"), "the suffix goes before the extension");
    },
  },
  {
    id: "assets/content-types",
    title:
      "uploads refuse non-media types, SVG and an extension that doesn't match the type (415)",
    async run(ctx) {
      await uploadsAccepted(ctx);
      const script = "<script>alert(document.cookie)</script>";
      const refused: Array<[name: string, type: string]> = [
        [`${ctx.prefix}-page.html`, "text/html"],
        [`${ctx.prefix}-evil.html`, "image/png"],
        [`${ctx.prefix}-evil.js`, "image/jpeg"],
        [`${ctx.prefix}-logo.svg`, "image/svg+xml"],
        [`${ctx.prefix}-data.json`, "application/json"],
      ];
      for (const [name, type] of refused) {
        const response = await ctx.upload(name, script, type);
        assertEqual(response.status, 415, `HTTP status of ${name} as ${type}`);
        assertEqual(
          rawErrorCode(response.body),
          ErrorCode.InvalidRequest,
          "the error code",
        );
      }
    },
  },
  {
    id: "assets/read-only",
    title: "an endpoint without uploads refuses them",
    async run(ctx) {
      if (ctx.options.assetsEndpoint === undefined)
        return ctx.skip("no assetsEndpoint");
      const d = await ctx.describe();
      if (!d.readOnly && d.assets !== null)
        return ctx.skip("the endpoint accepts uploads");
      const response = await ctx.upload(
        `${ctx.prefix}-x.png`,
        PNG,
        "image/png",
      );
      assert(
        response.status === 403 || response.status === 404,
        `HTTP ${response.status} (expected 403 or 404)`,
      );
      const code = rawErrorCode(response.body);
      assert(
        code === ErrorCode.ReadOnly || code === ErrorCode.Unsupported,
        `error ${String(code)} (expected ReadOnly or Unsupported)`,
      );
    },
  },
];
