import { expect, test } from "bun:test";
import { browserGap } from "./unavailable.ts";

test("the browser gap is ours", () => {
  expect(browserGap()).toEqual({
    source: "browser",
    error: "navegador indisponível nesta instalação",
  });
});
