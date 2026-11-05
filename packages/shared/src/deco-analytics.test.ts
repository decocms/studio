import { expect, test } from "bun:test";
import { storedExternalRegistration } from "./deco-analytics";

test("storedExternalRegistration reads only a complete stored registration", () => {
  expect(
    storedExternalRegistration({
      decoAnalytics: { id: "d-shop-example-com-1a2b", key: "dq_abc" },
    }),
  ).toEqual({ id: "d-shop-example-com-1a2b", key: "dq_abc" });
  expect(storedExternalRegistration(null)).toBeNull();
  expect(storedExternalRegistration({ siteSlug: "shop" })).toBeNull();
  expect(
    storedExternalRegistration({ decoAnalytics: { id: "", key: "dq_abc" } }),
  ).toBeNull();
  expect(
    storedExternalRegistration({ decoAnalytics: { id: "d-shop" } }),
  ).toBeNull();
});
