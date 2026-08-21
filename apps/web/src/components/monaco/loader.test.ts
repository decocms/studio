import { describe, expect, test } from "bun:test";

import { MONACO_VS_PATH } from "@/lib/monaco-vs-path";
import { configureMonacoLoader } from "./loader";

describe("MONACO_VS_PATH", () => {
  test("is same-origin — an absolute URL is what the desktop CSP refuses", () => {
    expect(MONACO_VS_PATH.startsWith("/")).toBe(true);
    expect(MONACO_VS_PATH).not.toMatch(/^[a-z]+:|^\/\//);
  });

  test("ends in /vs, which monaco's worker bootstrap assumes", () => {
    expect(MONACO_VS_PATH.endsWith("/vs")).toBe(true);
  });

  test("carries a version, so the unhashed files can be cached immutably", () => {
    expect(MONACO_VS_PATH).toMatch(/^\/monaco\/\d+\.\d+\.\d+\/vs$/);
  });
});

describe("configureMonacoLoader", () => {
  test("declares a same-origin worker under the engine path", () => {
    configureMonacoLoader();
    const getWorkerUrl = globalThis.MonacoEnvironment?.getWorkerUrl;
    expect(getWorkerUrl?.("workerMain.js", "typescript")).toBe(
      `${MONACO_VS_PATH}/base/worker/workerMain.js`,
    );
  });

  test("keeps hooks a previous caller put on MonacoEnvironment", () => {
    const createTrustedTypesPolicy = () => undefined;
    globalThis.MonacoEnvironment = { createTrustedTypesPolicy };
    configureMonacoLoader();
    expect(globalThis.MonacoEnvironment?.createTrustedTypesPolicy).toBe(
      createTrustedTypesPolicy,
    );
  });
});
