import { expect, test } from "bun:test";
import { internalizeMcpUrl } from "./internalize-url";

const MAP = {
  "sites-vtex.deco.site": "http://vtex-sites.deco.svc.cluster.local:8080",
};

test("rewrites origin, keeps path + query", () => {
  const out = internalizeMcpUrl(
    new URL("https://sites-vtex.deco.site/mcp?x=1"),
    MAP,
  );
  expect(out.toString()).toBe(
    "http://vtex-sites.deco.svc.cluster.local:8080/mcp?x=1",
  );
});

test("no-op when host not in map", () => {
  const url = new URL("https://other.example.com/mcp");
  expect(internalizeMcpUrl(url, MAP).toString()).toBe(url.toString());
});

test("no-op on empty map", () => {
  const url = new URL("https://sites-vtex.deco.site/mcp");
  expect(internalizeMcpUrl(url, {}).toString()).toBe(url.toString());
});

test("assumes http:// when the target omits a scheme", () => {
  const out = internalizeMcpUrl(new URL("https://sites-vtex.deco.site/mcp"), {
    "sites-vtex.deco.site": "vtex-sites.deco.svc.cluster.local",
  });
  expect(out.toString()).toBe("http://vtex-sites.deco.svc.cluster.local/mcp");
});
