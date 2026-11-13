import { describe, expect, it } from "bun:test";
import { withStudioModulesCors } from "./studio-modules-cors";

const ok = () =>
  new Response("export default () => {}", {
    headers: { "content-type": "text/javascript" },
  });

describe("withStudioModulesCors", () => {
  it("lets any site's page import a Studio module", async () => {
    const res = withStudioModulesCors(
      new Request(
        "https://studio.example/studio-modules/v1/wireframe.js?build=1",
      ),
      ok(),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(await res.text()).toBe("export default () => {}");
  });

  it("adds nothing to any other file", () => {
    const original = ok();
    const res = withStudioModulesCors(
      new Request("https://studio.example/assets/index-abc.js"),
      original,
    );
    expect(res).toBe(original);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
