import { describe, it, expect, afterAll } from "bun:test";
import { DuckDBProvider } from "./duckdb-provider";

describe("DuckDBProvider", () => {
  const provider = new DuckDBProvider(":memory:");

  afterAll(async () => {
    await provider.close();
  });

  it("runs a simple query", async () => {
    const rows = await provider.all<{ answer: number }>("SELECT 42 as answer");
    expect(rows).toEqual([{ answer: 42 }]);
  });

  it("runs a parameterized query", async () => {
    const rows = await provider.all<{ val: number }>(
      "SELECT ? + ? as val",
      10,
      20,
    );
    expect(rows).toEqual([{ val: 30 }]);
  });

  it("executes DDL statements", async () => {
    await provider.run("CREATE TABLE test_table (id INTEGER, name VARCHAR)");
    await provider.run("INSERT INTO test_table VALUES (1, 'hello')");
    const rows = await provider.all<{ id: number; name: string }>(
      "SELECT * FROM test_table",
    );
    expect(rows).toEqual([{ id: 1, name: "hello" }]);
  });
});
