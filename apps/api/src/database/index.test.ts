import { describe, expect, test } from "bun:test";
import { CompiledQuery, type LogEvent } from "kysely";
import { queryDurationAttributes } from "./index";

const queryEvent = (sql: string): LogEvent => ({
  level: "query",
  query: CompiledQuery.raw(sql),
  queryDurationMillis: 1,
});

const errorEvent = (sql: string): LogEvent => ({
  level: "error",
  query: CompiledQuery.raw(sql),
  queryDurationMillis: 1,
  error: new Error("boom"),
});

describe("queryDurationAttributes", () => {
  test("statements that differ only in list length share one series", () => {
    expect(
      queryDurationAttributes(queryEvent(`select 1 where "p" in ($1)`)),
    ).toEqual(
      queryDurationAttributes(queryEvent(`select 1 where "p" in ($1, $2, $3)`)),
    );
  });

  test("records the query status", () => {
    expect(queryDurationAttributes(queryEvent("select 1"))).toEqual({
      "db.status": "success",
    });
    expect(queryDurationAttributes(errorEvent("select 1"))).toEqual({
      "db.status": "error",
    });
  });
});
