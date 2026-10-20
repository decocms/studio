import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fetchPublicOnePager } from "./public-report";

let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
afterEach(() => fetchSpy.mockRestore());

const engineReplies = (body: unknown, status = 200) => {
  fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), { status }),
  );
};

describe("fetchPublicOnePager", () => {
  test("returns null when the engine has nothing public", async () => {
    engineReplies({ error: "not_found" }, 404);
    expect(await fetchPublicOnePager("example.com")).toBeNull();
  });

  test("forwards the viewer's language", async () => {
    engineReplies({ error: "not_found" }, 404);
    await fetchPublicOnePager("example.com", { lang: "pt-BR" });
    const [url] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toMatch(
      /\/diagnostics\/example\.com\/onepager\?lang=pt-BR$/,
    );
  });

  test("throws on a body that is not a one-pager", async () => {
    engineReplies({ status: "ready", deck: { slides: [] } });
    await expect(fetchPublicOnePager("example.com")).rejects.toThrow();
  });

  test("throws on an engine error instead of reporting not found", async () => {
    engineReplies({ error: "boom" }, 500);
    await expect(fetchPublicOnePager("example.com")).rejects.toThrow(
      "onepager read HTTP 500",
    );
  });
});
