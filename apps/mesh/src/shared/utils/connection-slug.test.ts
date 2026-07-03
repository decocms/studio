import { describe, expect, it } from "bun:test";
import { getConnectionSlug } from "./connection-slug";

describe("getConnectionSlug", () => {
  it("prefers app_name over everything else", () => {
    expect(
      getConnectionSlug({
        app_name: "vtex",
        connection_url: "https://example.com",
        title: "VTEX Store",
        id: "conn_1",
      }),
    ).toBe("vtex");
  });

  it("derives a slug from host + path when connection_url has no port", () => {
    expect(
      getConnectionSlug({ connection_url: "https://Example.com/Foo/Bar/" }),
    ).toBe("examplecom-foo-bar");
  });

  it("includes the port in the derived slug when present", () => {
    expect(
      getConnectionSlug({ connection_url: "http://localhost:4000/mcp" }),
    ).toBe("localhost-4000-mcp");
  });

  it("falls back to slugifying the raw url when it fails to parse", () => {
    expect(getConnectionSlug({ connection_url: "not a url" })).toBe(
      "not-a-url",
    );
  });

  it("falls back to the slugified title when there is no app_name/connection_url", () => {
    expect(getConnectionSlug({ title: "My Connection" })).toBe("my-connection");
  });

  it("falls back to the raw id when there is no app_name/connection_url/title", () => {
    expect(getConnectionSlug({ id: "conn_1" })).toBe("conn_1");
  });

  it("falls back to 'unknown' when nothing is present", () => {
    expect(getConnectionSlug({})).toBe("unknown");
  });
});
