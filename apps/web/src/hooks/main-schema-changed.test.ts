import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import {
  isMainSchemaChangedResponse,
  mainSchemaHeaders,
  resetMainSchemaAnswer,
} from "./main-schema-changed";

describe("main changed mid-session", () => {
  test("only the server's 409 main_schema_changed counts", async () => {
    expect(
      await isMainSchemaChangedResponse(
        Response.json({ code: "main_schema_changed" }, { status: 409 }),
      ),
    ).toBe(true);
    expect(
      await isMainSchemaChangedResponse(
        Response.json({ code: "site_not_owned" }, { status: 409 }),
      ),
    ).toBe(false);
    expect(
      await isMainSchemaChangedResponse(
        Response.json({ code: "main_schema_changed" }, { status: 404 }),
      ),
    ).toBe(false);
  });

  test("the header names the answer the request acts on", () => {
    expect(mainSchemaHeaders("v7")).toEqual({ "x-deco-main-schema": "v7" });
  });

  test("the editor forgets main's answer and the GitHub probe, then waits (pending)", () => {
    const client = new QueryClient();
    const main = KEYS.mainSchemaV8("org", "p1");
    const probe = KEYS.contentBackend("org", "p1", "b1", "github");
    const local = KEYS.contentBackend("org", "p1", "local", "http://x");
    const other = KEYS.mainSchemaV8("org", "p2");
    for (const key of [main, probe, local, other]) {
      client.setQueryData(key, true);
    }
    resetMainSchemaAnswer(client, "org", "p1");
    // Undecided again: the editor shows its loading state, never a swap.
    expect(client.getQueryData(main)).toBeUndefined();
    expect(client.getQueryData(probe)).toBeUndefined();
    expect(client.getQueryData<boolean>(local)).toBe(true);
    expect(client.getQueryData<boolean>(other)).toBe(true);
  });
});
