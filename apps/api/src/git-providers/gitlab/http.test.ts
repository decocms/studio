import { describe, expect, test } from "bun:test";
import { GitProviderError } from "../types";
import { gitlabJson } from "./http";

describe("gitlabJson", () => {
  test("parses a well-formed 2xx body", async () => {
    const res = new Response(JSON.stringify({ id: 1 }), { status: 200 });
    await expect(gitlabJson(res, "get_repo")).resolves.toEqual({ id: 1 });
  });

  test("degrades a malformed 2xx body into a GitProviderError instead of a raw SyntaxError", async () => {
    const res = new Response("<html>Not JSON</html>", { status: 200 });
    await expect(gitlabJson(res, "get_repo")).rejects.toBeInstanceOf(
      GitProviderError,
    );
  });
});
