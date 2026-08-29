import { describe, expect, test } from "bun:test";
import { interpolateParams } from "./index";

describe("interpolateParams", () => {
  test("does not splice a ? found inside an already-substituted $-style value", () => {
    const result = interpolateParams("SELECT * FROM t WHERE a = $1 AND b = ?", [
      "a question: ?",
      "value2",
    ]);
    expect(result).toBe(
      "SELECT * FROM t WHERE a = 'a question: ?' AND b = 'a question: ?'",
    );
  });

  test("keeps a literal $1 inside an escaped $-style value intact", () => {
    const result = interpolateParams("SELECT $1, $2", ["cost is $1", "ok"]);
    expect(result).toBe("SELECT 'cost is $1', 'ok'");
  });

  test("substitutes repeated ? placeholders positionally", () => {
    const result = interpolateParams("a = ? AND b = ?", [1, "two"]);
    expect(result).toBe("a = 1 AND b = 'two'");
  });

  test("leaves an out-of-range $N placeholder untouched", () => {
    const result = interpolateParams("a = $1 AND b = $2", ["x"]);
    expect(result).toBe("a = 'x' AND b = $2");
  });

  test("does not treat a ? inside a string literal as a placeholder", () => {
    const result = interpolateParams(
      "SELECT * FROM t WHERE msg = 'what?' AND id = ?",
      [5],
    );
    expect(result).toBe("SELECT * FROM t WHERE msg = 'what?' AND id = 5");
  });

  test("does not treat a $1 inside a string literal as a placeholder", () => {
    const result = interpolateParams(
      "SELECT * FROM t WHERE msg = 'cost is $1' AND id = $1",
      [5],
    );
    expect(result).toBe("SELECT * FROM t WHERE msg = 'cost is $1' AND id = 5");
  });

  test("keeps a doubled '' escaped quote inside the string open", () => {
    const result = interpolateParams(
      "SELECT * FROM t WHERE msg = 'it''s a ?' AND id = ?",
      [5],
    );
    expect(result).toBe("SELECT * FROM t WHERE msg = 'it''s a ?' AND id = 5");
  });

  test("does not treat a ? inside a quoted identifier as a placeholder", () => {
    const result = interpolateParams(
      'SELECT * FROM t WHERE "col?" = ? AND id = ?',
      [1, 2],
    );
    expect(result).toBe('SELECT * FROM t WHERE "col?" = 1 AND id = 2');
  });

  test("does not treat a $1 inside a quoted identifier as a placeholder", () => {
    const result = interpolateParams(
      'SELECT "col$1" FROM t WHERE id = $1',
      [5],
    );
    expect(result).toBe('SELECT "col$1" FROM t WHERE id = 5');
  });

  test('keeps a doubled "" escaped quote inside the identifier open', () => {
    const result = interpolateParams(
      'SELECT * FROM t WHERE "col""?" = ? AND id = ?',
      [1, 2],
    );
    expect(result).toBe('SELECT * FROM t WHERE "col""?" = 1 AND id = 2');
  });

  test("does not treat a $1 inside a dollar-quoted function body as a placeholder", () => {
    const result = interpolateParams(
      "DO $$ BEGIN PERFORM some_func($1); END $$; SELECT ? ",
      ["x"],
    );
    expect(result).toBe(
      "DO $$ BEGIN PERFORM some_func($1); END $$; SELECT 'x' ",
    );
  });

  test("does not treat a $1 inside a tagged dollar-quoted body as a placeholder", () => {
    const result = interpolateParams(
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT $1 $body$ LANGUAGE sql; SELECT ?",
      ["x"],
    );
    expect(result).toBe(
      "CREATE FUNCTION f() RETURNS int AS $body$ SELECT $1 $body$ LANGUAGE sql; SELECT 'x'",
    );
  });

  test("does not let a ? inside a line comment shift later positional params", () => {
    const result = interpolateParams(
      "SELECT * FROM t WHERE a = ? -- filter by a, right?\nAND b = ?",
      [1, 2],
    );
    expect(result).toBe(
      "SELECT * FROM t WHERE a = 1 -- filter by a, right?\nAND b = 2",
    );
  });

  test("does not let a ? inside a block comment shift later positional params", () => {
    const result = interpolateParams(
      "SELECT * FROM t WHERE a = ? /* is this right? */ AND b = ?",
      [1, 2],
    );
    expect(result).toBe(
      "SELECT * FROM t WHERE a = 1 /* is this right? */ AND b = 2",
    );
  });

  test("keeps a nested block comment closed until its outer terminator", () => {
    const result = interpolateParams(
      "SELECT ? /* outer /* inner */ trailing ? */, ?",
      [1, 2, 3],
    );
    expect(result).toBe("SELECT 1 /* outer /* inner */ trailing ? */, 2");
  });
});
