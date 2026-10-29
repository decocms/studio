import { expect, test } from "bun:test";
import { buildInstruction } from "./instruction";

test("a keyed site gets the keyed tag and the preview-domain caveat", () => {
  const text = buildInstruction({ id: "s1", key: "dq_abc", modules: ["core"] });
  expect(text).toContain(
    '<script async src="https://analytics.decocdn.com/_dq/a.js?k=dq_abc"></script>',
  );
  expect(text).toContain("preview domain");
  expect(text).toContain("window.__dq?.purchase");
  expect(text).toContain(
    "add `https://analytics.decocdn.com/_dq/` to both `script-src` and `connect-src`",
  );
});

test("a host-resolved site gets the same-origin tag", () => {
  const text = buildInstruction({ id: "s1", key: null, modules: ["core"] });
  expect(text).toContain('<script async src="/_dq/a.js"></script>');
  expect(text).not.toContain("?k=");
  expect(text).not.toContain("preview domain");
  expect(text).not.toContain("Content-Security-Policy");
});

test("the deco module lets a storefront skip purchase wiring", () => {
  expect(
    buildInstruction({ id: "s1", key: null, modules: ["core", "deco"] }),
  ).toContain("window.DECO.events");
  expect(
    buildInstruction({ id: "s1", key: null, modules: ["core"] }),
  ).not.toContain("window.DECO.events");
});
