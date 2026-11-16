import { describe, expect, test } from "bun:test";
import { cmsJson, CmsRequestError, parseCmsPublicationResult } from "./cms-api";

describe("CMS JSON responses", () => {
  test("an HTTP success with truncated or empty JSON cannot acknowledge a write", async () => {
    for (const body of ["{truncated", "", "<html>upstream error</html>"]) {
      const error = await cmsJson(new Response(body, { status: 200 })).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(CmsRequestError);
      expect(error).toMatchObject({ status: 200, code: "invalid_response" });
    }
  });

  test("a valid JSON success remains available for operation-specific validation", async () => {
    const answer = {
      result: "published",
      revision: "revision-1",
      previous: null,
    };
    expect(await cmsJson<typeof answer>(Response.json(answer))).toEqual(answer);
  });

  test("non-JSON and scalar HTTP refusals retain their HTTP failure", async () => {
    for (const body of ["upstream unavailable", "null", "[]", "false"]) {
      const error = await cmsJson(new Response(body, { status: 502 })).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(CmsRequestError);
      expect(error).toMatchObject({
        message: "HTTP 502",
        status: 502,
        code: null,
      });
    }
  });

  test("a structured refusal retains the server message and code", async () => {
    await expect(
      cmsJson(
        Response.json(
          { error: "Production moved", code: "production_moved" },
          { status: 409 },
        ),
      ),
    ).rejects.toMatchObject({
      message: "Production moved",
      status: 409,
      code: "production_moved",
    });
  });
});

test("publication validation preserves rollback revisions and explicit empty-site no-ops", () => {
  expect(
    parseCmsPublicationResult({
      result: "published",
      revision: "revision-2",
      previous: "revision-1",
    }),
  ).toEqual({
    result: "published",
    revision: "revision-2",
    previous: "revision-1",
  });
  expect(
    parseCmsPublicationResult({ result: "up-to-date", revision: null }),
  ).toEqual({ result: "up-to-date", revision: null });
});
