import { expect, test } from "bun:test";

import { createFetch, serve } from "./index";

test("index exports nats transport APIs", () => {
  expect(createFetch).toBeFunction();
  expect(serve).toBeFunction();
});
